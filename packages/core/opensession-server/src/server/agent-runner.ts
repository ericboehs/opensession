/**
 * Agent runner dispatcher: one entry point for "run a prompt in a session".
 * Almost everything executes on the opencode engine — native model ids
 * (claude-*, gpt-*) are mapped onto their opencode/<provider>/<model> form at
 * dispatch; explicit pi/<provider>/<model> ids dispatch to the in-process pi
 * runner instead (config-gated, see pi-runner.ts), and claude/… / codex/… ids
 * to the direct-SDK adapters in src/server/engine/ (config-gated, see
 * engine/engines-config.ts). All of them emit the shared StreamEvent shape, so
 * everything downstream of runOnModel is engine-blind. routeModel (models.ts)
 * owns which engine an id lands on; runOnModel just dispatches its answer.
 *
 * Note on session ids: `sessionId` is the engine session id (an opencode
 * session id, or a pi session uuid for pi runs; the field names
 * claudeSessionId/codexThreadId survive in session state for on-disk compat
 * with pre-single-engine sessions — pi runs journal their engine id in the
 * claudeSessionId slot like every other engine).
 */

import {
  journalClear,
  journalClearIfLineage,
  hasActiveRunFor,
  journalQuarantine,
  journalMarkRecoveryAttached,
  journalStartRecovery,
  activeRunRecords,
  takeInterruptedRuns,
  type ActiveRunRecord,
  type QuarantinedRun,
} from "./run-journal";
import {
  getRunState,
  isRunStateUnsettled,
  transitionRunState,
} from "./run-state";
import type { StreamEvent, ImageInput } from "./run-events";
// Type-only, so the direct engines stay lazily loaded (see the dispatch table
// below): this pulls in the contract's signatures, never the SDKs.
import {
  runOpencode,
  isOpencodeSessionBusy,
  cancelOpencodeRun,
  activeOpencodeRunCount,
  activeDetachedOpencodeRunCount,
  tryReattachOpencodeRun,
  steerOpencodeRun,
  EMPTY_COMPLETION_RESULT,
  claudePoolDryReason,
  restoreJournaledRunRpcContext,
  releaseJournaledRunRpcContext,
  abortDetachedOpencodeTurn,
  registerPendingRecoveryProbe,
} from "./opencode-runner";
// Static import is deliberate: the pi-runner module itself is cheap (the
// heavy @earendil-works SDK import stays dynamic inside it, prewarmed only
// when the engine is enabled), and the dispatchers below need its registry
// checks on every busy/steer/cancel call.
import {
  runPi,
  isPiSessionBusy,
  steerPiRun,
  cancelPiRun,
  activePiRunCount,
} from "./pi-runner";
import {
  providerFor,
  nextFallbackModel,
  modelLabel,
  explicitEngineFor,
  routeModel,
  BEST_AVAILABLE_CODEX_MODEL,
  getDefaultModel,
  resolveConcreteModel,
  resolveModel,
  toOpencodeModel,
  toPiModel,
} from "./models";
import { INTERACTIVE_KINDS, baseJournalKind } from "./opencode-policy";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import {
  isProviderOverloadError,
  isTransientRunError,
  TOOL_RESULT_ENVELOPE_RE,
  type McpScope,
} from "./runner-shared";
import {
  hostRunBusy,
  hostSteer,
  hostInterruptSteer,
  hostCancel,
  hostRunCount,
} from "./host-registry";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { personaName } from "./config";
import { wrapContext } from "./prompt-context";
import { logInjectedContext, logStandingJson } from "./context-log";
import {
  beginTurn,
  endTurn,
  isCheckedKind,
  isReachTool,
  recordEffect,
  turnKeyFor,
} from "./turn-outcome";
import { readEngineTranscriptAsync } from "./sessions";
import { ensureSessionScratch } from "./session-scratch";
import type { GitIdentity } from "./shared/user-mappings";
import type { TranscriptEntry } from "./types";
import { audit } from "./audit";

export type { StreamEvent };

export interface RunAgentOpts {
  prompt: string;
  /** Engine session id to resume (claude session id or codex thread id). */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  /** Session-scoped scratch dir (session-scratch.ts). runAgent ensures it for
   *  any run with an osSessionId; engines export it (pi sets TMPDIR +
   *  OPENSESSION_SCRATCH in the bash env) and the run instructions name it,
   *  so temporary files follow the session's lifecycle instead of piling up
   *  in shared /tmp. */
  scratchDir?: string;
  /** MCP OAuth identity override: the session CREATOR — shared sessions run
   *  MCP calls as their creator so teammates see the same objects (their own
   *  grant is the fallback, then the workspace grant). TODO(sandbox): the
   *  sandboxed-run path doesn't thread this yet. */
  mcpGrantUser?: string;
  /** Model id; decides the backend. Omitted = default Claude model. */
  model?: string;
  /** User-selected model retained while a transient fallback drives this turn. */
  selectedModel?: string;
  /** Internal recovery marker: the effective model is only a per-turn fallback. */
  transientFallback?: boolean;
  /** OpenCode reasoning variant for this run; unset = the model default. */
  effort?: string;
  /** Use OpenAI's priority service tier when this is a ChatGPT OAuth Codex run. */
  fastMode?: boolean;
  /**
   * External MCP servers this run may mount. REQUIRED and with no implicit
   * default: pass an allowlist, `[]` for none, or `"all"` to mount every
   * configured connector — a wide grant a reviewer can see in the diff. See
   * McpScope for why "just omit it" is no longer an option.
   */
  mcpServers: McpScope;
  /**
   * In-process SDK MCP servers (opensession-sessions / opensession-admin) for trusted
   * interactive runs only — never automations. Claude receives them directly;
   * Codex receives stdio proxy configs that forward to the same in-process
   * servers through Open Session's run RPC socket.
   */
  inProcessMcp?: Record<string, unknown>;
  /**
   * The model loop is running outside its coding sandbox. Strip OpenCode's
   * built-in local bash/read/write/edit/search tools so the run can only touch
   * the workspace through the session-scoped remote-workspace MCP server.
   */
  disableLocalWorkspaceTools?: boolean;
  /**
   * System-prompt note describing the session's repos (primary + attached) and
   * their worktree paths, so the agent works in the right isolated checkout for
   * cross-repo sessions. Claude receives it as system context; Codex via the
   * developer_instructions config channel.
   */
  reposNote?: string;
  /**
   * Reviewer to request on PRs this run opens (GitHub login, `org/team` slug,
   * or a comma-separated list). Set from the owning automation's `prReviewer`
   * — unattended PRs otherwise land with no reviewer and never surface in
   * anyone's review queue. Preserved across model fallback and restart resume.
   */
  prReviewer?: string;
  /** Images attached to the opening message. */
  images?: ImageInput[];
  /**
   * Stable uuid for the prompt's user transcript line. Callers that persist
   * the user line at intake (run-session) — and boot re-runs of journaled
   * runs — pass it so the runner's own transcript write upserts the same
   * entry instead of duplicating the bubble.
   */
  promptEntryId?: string;
  /**
   * Prior-engine transcript entries accompanying a cross-engine handoff (the
   * same entries the handoff note was built from). The opencode runner seeds a
   * freshly-created session's persisted transcript file with them, so the UI
   * transcript stays continuous across the engine switch. Other runners ignore
   * this (their engines own their transcript files).
   */
  seedTranscriptEntries?: TranscriptEntry[];
  /** Fork the resumed session into a new id (optionally from `resumeSessionAt`). Claude only. */
  forkSession?: boolean;
  resumeSessionAt?: string;
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  aws?: boolean;
  /**
   * Provision the run's env with a Claude-CLI credential from the
   * claude-accounts pool (CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CONFIG_DIR), so
   * tooling the agent itself spawns — deepsec's `--agent claude` Agent-SDK
   * subprocess — runs on Open Session's account pool instead of the host
   * CLI's own login (which scans must never depend on; it logged out
   * 2026-08-08 and every scan silently analyzed zero batches). Set by
   * security scans and pool-cli-flagged automations only; opencode engine,
   * per-session servers only (a meridian-backed run already carries the
   * same-class token and wins).
   */
  claudeCliEnv?: boolean;
  /**
   * Codex sibling of claudeCliEnv: point the run's env at a codex-accounts
   * pool credential (CODEX_HOME for ChatGPT-subscription accounts,
   * OPENAI_API_KEY for api-key ones) so run-spawned tooling — deepsec's
   * `--agent codex` — runs on the ChatGPT pool. Same trust gate and
   * per-session-server containment as claudeCliEnv; the two flags are
   * independent so a caller grants only the pools its tooling uses.
   */
  codexCliEnv?: boolean;
  /** Git identity for commits this run makes, attributing them to the prompt's author. */
  author?: GitIdentity | null;
  /**
   * The run's user (prompt author / UI user). Gates per-user MCP servers
   * (mcp-config.json `allowedUsers`) — e.g. a server restricted to specific teammates.
   * Omitted = anonymous, which sees only unrestricted servers.
   */
  user?: string;
  /**
   * Model to switch to when the primary model dies on usage limits with no
   * account left in its pool (claude-runner/codex-runner rotate their own
   * account pools first — this fires only once a whole pool is exhausted).
   * Cross-provider fallback starts a fresh native engine session. The previous
   * engine's internal history cannot carry over, so the runner injects a recent
   * transcript handoff when one is available; cwd/worktree state carries over.
   */
  fallbackModel?: string;
  /** Stable provider-account affinity for internal fan-out workers. Distinct
   * workers should use distinct keys while retries of one worker reuse it. */
  accountAffinityKey?: string;
  /**
   * Pinned account in the active model provider's Claude or Codex pool. The
   * provider runner prefers it and falls back to the pool on exhaustion.
   * Journaled for resume.
   */
  accountId?: string;
  /**
   * Hard accountId pin (automation cost cap): the run only ever uses that
   * account — an exhausted pin kills the run with usageLimitExhausted so the
   * fallback-model chain takes over instead of the shared pool.
   */
  accountStrict?: boolean;
  /**
   * Allow runs to keep going on accounts billing usage-credits past their
   * subscription limits (extra usage enabled with credit headroom). Off =
   * never intentionally spend paid credits. Claude only.
   */
  usageCredits?: boolean;
  journal?: {
    osSessionId?: string;
    kind?: string;
    firstJournaledAt?: string;
    resumeAttempts?: number;
    lastResumeAt?: string;
  };
  /** Exact admission reservation for a UI-created turn. Internal only: Stop
   * latches this token, so a replacement prompt cannot revive the old turn. */
  startToken?: string;
  /** Run-lifetime cancellation predicate threaded through engine retries. */
  shouldCancel?: () => boolean;
  /**
   * Unified session id (e.g. `linear-<branch>`) for the transcript-v2 oc→
   * unified map ONLY (opencode-transcript.ts recordBksSessionFor) — lets loop
   * runs whose journal is deliberately kind-only (no crash journal; the loop
   * re-drives its own turns) still key their store appends on their unified
   * session. Never journaled, never used for resume/run-state/MCP identity —
   * runs that journal a osSessionId don't need this (it wins when both are
   * set, since they must agree anyway).
   */
  transcriptSessionId?: string;
  onAskUser?: (input: Record<string, unknown>) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >;
}

/** The engine call signature runOnModel dispatches to — what a test fake
 *  must implement (the INNER contract: emit init → chunks/tools → one
 *  terminal done/error; runAgent's fallback walk wraps it). */
export type EngineRunner = (
  opts: RunAgentOpts,
  model: string
) => AsyncGenerator<StreamEvent>;

// Test seam: lets a deterministic fake engine stand in for runOpencode so the
// consumer stack (runAgent's fallback walk, runSessionPrompt's event loop,
// queue drain, run-state transitions) is testable without spending model
// tokens or touching a live engine. Never set outside tests — parked on a
// plain module local, NOT globalThis, so a hot reload always clears it.
let engineForTest: EngineRunner | null = null;
export function __setEngineForTest(fn: EngineRunner | null): void {
  engineForTest = fn;
}

/** Test seam for the reattach half of restart recovery — the only part of a
 *  recovery that needs a surviving detached `opencode serve` to exercise. */
let reattachForTest: typeof tryReattachOpencodeRun | null = null;
export function __setReattachForTest(fn: typeof tryReattachOpencodeRun | null): void {
  reattachForTest = fn;
}

type LocalHostResume = (
  run: ActiveRunRecord,
  callbacks: { onAskUser?: RunAgentOpts["onAskUser"] },
) => Promise<AsyncGenerator<StreamEvent> | null>;

/** Test seam for the local detached-host half of restart recovery. */
let localHostResumeForTest: LocalHostResume | null = null;
export function __setLocalHostResumeForTest(fn: LocalHostResume | null): void {
  localHostResumeForTest = fn;
}

/** Test seam for abandonment paths that must reach a detached engine turn. */
let abortDetachedForTest: typeof abortDetachedOpencodeTurn | null = null;
export let DETACHED_ABORT_WAIT_MS = 7_000;
export function __setAbortDetachedForTest(
  fn: typeof abortDetachedOpencodeTurn | null,
): void {
  abortDetachedForTest = fn;
}

export function __setDetachedAbortWaitMsForTest(ms: number): number {
  const previous = DETACHED_ABORT_WAIT_MS;
  DETACHED_ABORT_WAIT_MS = ms;
  return previous;
}

function abortInterruptedDetachedTurn(run: ActiveRunRecord): Promise<boolean> {
  const controller = new AbortController();
  const abort = (abortDetachedForTest ?? abortDetachedOpencodeTurn)(run, controller.signal);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, DETACHED_ABORT_WAIT_MS);
    void abort.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      () => {
        clearTimeout(timeout);
        resolve(false);
      },
    );
  });
}

type ModelAvailabilityProbe = (opts: RunAgentOpts, model: string) => string | null;
let modelAvailabilityForTest: ModelAvailabilityProbe | null = null;
export function __setModelAvailabilityForTest(fn: ModelAvailabilityProbe | null): void {
  modelAvailabilityForTest = fn;
}

function modelUnavailableReason(opts: RunAgentOpts, model: string): string | null {
  const mapped = toOpencodeModel(model) || model;
  if (modelAvailabilityForTest) return modelAvailabilityForTest(opts, mapped);
  // A fake engine owns its scripted availability unless a test explicitly
  // installs the separate probe above.
  if (engineForTest) return null;
  return claudePoolDryReason(opts, mapped);
}

function recordPoolDryShortCircuit(opts: RunAgentOpts, model: string, reason: string): void {
  audit({
    msg: "account_pool_short_circuit",
    run_kind: opts.journal?.kind,
    session_id: opts.journal?.osSessionId,
    model,
    reason,
  });
}


function runOnModel(opts: RunAgentOpts, model: string | undefined): AsyncIterable<StreamEvent> {
  // Engine dispatch. routeModel (models.ts) owns the resolution order —
  // explicit engine prefix > per-model default engine (interactive runs only)
  // > opencode — and hands back the id to dispatch with: pi/<provider>/<model>
  // runs on the in-process pi runner, everything else on opencode (native ids
  // get their opencode form, explicit opencode ids pass through, and the
  // removed direct engines' legacy claude/… and codex/… ids normalize onto
  // opencode). Anything that still doesn't parse as
  // an engine id gets the runner's clear error (e.g. anthropic bridge
  // disabled). The test seam stays FIRST, before the engine branch, so a fake
  // engine intercepts every engine's turns (fake-engine.test.ts).
  const requested = model || getDefaultModel();
  const mapped = toOpencodeModel(requested) || requested;
  // Model-visible means logged (context-log.ts). This is the single dispatch
  // point for every engine and every hop of the fallback walk, so recording
  // the injected context here covers all of them with the prompt each one
  // actually receives — including the handoff the walk prepends on a
  // cross-provider hop. Before the test seam, so fake-engine tests exercise it.
  logInjectedContext({
    sessionId: opts.journal?.osSessionId || opts.transcriptSessionId,
    turnId: opts.promptEntryId || opts.startToken,
    prompt: opts.prompt,
    reposNote: opts.reposNote,
    model: mapped,
  });
  // Standing context, same choke point: the tool surface the run was scoped
  // to. Model-visible on every turn and identical across them, so it is
  // recorded once per session and again only when the scoping moves. Written
  // here rather than in a runner because this is where the decision is final
  // for EVERY engine — the direct SDK adapters assemble their own tool lists
  // and would each need their own call otherwise. What the runner adds below
  // it (`mcp-servers`) is the resolution of this scope, not a second copy.
  logStandingJson({
    sessionId: opts.journal?.osSessionId || opts.transcriptSessionId,
    turnId: opts.promptEntryId || opts.startToken,
    source: "tools",
    value: {
      // `mcpServers` is typed as required, and the create path passes it
      // through a cast that can still be undefined at runtime — which reads
      // as "all" per McpScope's own contract, and must never be spread.
      mcpScope: Array.isArray(opts.mcpServers)
        ? [...opts.mcpServers].sort()
        : (opts.mcpServers ?? "all"),
      inProcess: Object.keys(opts.inProcessMcp || {}).sort(),
      // Names, not the refusal messages: those are model-visible through the
      // instructions record, and folding them in here would churn this hash
      // on a wording change that altered no tool.
      deniedTools: Object.keys(opts.deniedTools || {}).sort(),
      confirmTools: Object.keys(opts.confirmTools || {}).sort(),
      mode: opts.mode || null,
      localWorkspaceToolsDisabled: !!opts.disableLocalWorkspaceTools,
    },
  });
  if (engineForTest) return engineForTest(opts, mapped);
  const route = routeModel(requested, { interactive: isInteractiveRun(opts) });
  if (route.engine === "pi") return runPi(opts, route.model);
  return runOpencode(opts, route.model);
}

/** Which engine's transcript store owns a routed model's session ids — the
 *  read side of the same routing prefix runOnModel dispatches on. Anything
 *  without an engine prefix (native ids, `<vendor>/<model>` paths) is served
 *  by opencode. */
export function transcriptProviderFor(
  engineModel: string
): "opencode" | "pi" {
  return explicitEngineFor(engineModel) === "pi" ? "pi" : "opencode";
}

/** Whether the per-model default engine applies to this run. Automations and
 *  the other unattended kinds stay on their current routing for now — moving
 *  their default is a separate, deliberate step. */
export function isInteractiveRun(opts: { journal?: { kind?: string } }): boolean {
  return INTERACTIVE_KINDS.has(baseJournalKind(opts.journal?.kind));
}

/**
 * Watch a run's event stream for whether it ever reached anybody, and settle
 * the verdict when it ends (src/server/turn-outcome.ts). Only unattended kinds
 * carry a ledger; for everything else this is two branch predictions per run.
 */
export async function* runAgent(opts: RunAgentOpts): AsyncGenerator<StreamEvent> {
  const osSessionId = opts.journal?.osSessionId;
  const runAliases = new Set(
    [osSessionId, opts.transcriptSessionId, opts.sessionId].filter(
      (id): id is string => !!id,
    ),
  );
  const runToken =
    opts.startToken ||
    (osSessionId ? pendingStarts.get(osSessionId)?.values().next().value : undefined) ||
    crypto.randomUUID();
  const effectiveOpts: RunAgentOpts = {
    ...opts,
    scratchDir:
      opts.scratchDir ?? (osSessionId ? ensureSessionScratch(osSessionId) : undefined),
    journal: opts.journal
      ? {
          ...opts.journal,
          firstJournaledAt:
            opts.journal.firstJournaledAt || new Date().toISOString(),
        }
      : undefined,
    startToken: runToken,
    shouldCancel: () =>
      cancelledRunTokens.has(runToken) || opts.shouldCancel?.() === true,
  };
  for (const alias of runAliases) {
    let tokens = activeSessionRunTokens.get(alias);
    if (!tokens) activeSessionRunTokens.set(alias, (tokens = new Set()));
    tokens.add(runToken);
  }
  if (osSessionId) {
    if (!sessionRunOwners.has(osSessionId))
      sessionRunOwners.set(osSessionId, runToken);
  }
  let terminalEvent: StreamEvent | undefined;
  const observe = (event: StreamEvent) => {
    if (event.type === "done" || event.type === "error") terminalEvent = event;
    return event;
  };
  const key = isCheckedKind(opts.journal?.kind)
    ? turnKeyFor({ osSessionId: opts.journal?.osSessionId })
    : undefined;
  try {
    if (!key) {
      for await (const event of runAgentInner(effectiveOpts)) yield observe(event);
      return;
    }
    beginTurn({
      key,
      kind: opts.journal?.kind || "unknown",
      sessionId: opts.journal?.osSessionId,
    });
    try {
      for await (const event of runAgentInner(effectiveOpts)) {
        observe(event);
        if (event.type === "tool_use" && isReachTool(event.toolName)) {
          recordEffect(key, event.toolName!);
        }
        yield event;
      }
    } finally {
      // `finally`, not after the loop: a consumer that breaks out early (a
      // cancel, a steer) still closes the ledger, so a later run reusing the
      // same session id starts clean instead of inheriting stale effects.
      endTurn(key, { model: opts.model, by: opts.user });
    }
  } finally {
    if (
      osSessionId &&
      terminalEvent &&
      sessionRunOwners.get(osSessionId) === runToken &&
      !(terminalEvent.type === "error" && terminalEvent.content === "Session is busy") &&
      isRunStateUnsettled(getRunState(osSessionId))
    ) {
      const failed =
        terminalEvent.type === "error" || !!terminalEvent.usageLimitExhausted;
      transitionRunState(osSessionId, failed ? "run_failed" : "turn_end", {
        source: "runner_terminal",
      });
    }
    cancelledRunTokens.delete(runToken);
    for (const alias of runAliases) {
      const tokens = activeSessionRunTokens.get(alias);
      tokens?.delete(runToken);
      if (!tokens?.size) activeSessionRunTokens.delete(alias);
    }
    if (osSessionId) {
      if (sessionRunOwners.get(osSessionId) === runToken)
        sessionRunOwners.delete(osSessionId);
    }
  }
}

async function* runAgentInner(opts: RunAgentOpts): AsyncGenerator<StreamEvent> {
  const wasCancelled = () => opts.shouldCancel?.() === true;
  if (wasCancelled()) return;
  // Workspace presets stay as their picker id on the session. Resolve their
  // lead only for dispatch, so the session never loses its preset identity.
  const workspacePreset = resolveWorkspaceModelPreset(opts.model);
  const requestedModel = resolveModel(workspacePreset?.model || opts.model || getDefaultModel());
  const wantsBestCodex = requestedModel?.id === BEST_AVAILABLE_CODEX_MODEL;
  const primaryModel = workspacePreset?.model || resolveConcreteModel(opts.model);
  const preservePiEngine = explicitEngineFor(primaryModel) === "pi";
  // Direct-SDK engines are explicit engine selections. Never cross that
  // boundary into an OpenCode fallback. Pi can use the same model graph while
  // preserving its own engine prefix on every hop.
  const preferredFallback = /^(?:claude|codex)\//.test(primaryModel)
    ? "none"
    : wantsBestCodex
    ? BEST_AVAILABLE_CODEX_MODEL
    : opts.fallbackModel;
  // No fallback configured (interactive auto-switch off, or an automation with
  // fallbackModel:"none") ⇒ run the primary and surface whatever it does.
  if (!preferredFallback || preferredFallback === "none") {
    const dry = modelUnavailableReason(opts, primaryModel);
    if (dry) {
      recordPoolDryShortCircuit(opts, primaryModel, dry);
      yield {
        type: "error",
        content: `Claude account pool is unavailable: ${dry}`,
        provider: providerFor(primaryModel),
        model: primaryModel,
        usageLimitExhausted: true,
      };
      return;
    }
    yield* runOnModel(opts, primaryModel);
    return;
  }

  let currentOpts = {
    ...opts,
    selectedModel: opts.selectedModel ?? opts.model,
  };
  let currentModel = primaryModel;
  const exhaustedModels = new Set<string>();
  let consecutiveTransient = 0;
  for (;;) {
    if (wasCancelled()) return;
    let currentEngineId = currentOpts.sessionId;
    // Why this turn ended, if it did: a usage cap (pool drained), a transient
    // infrastructure failure, or an upstream provider overload. The first two
    // route into the fallback graph; a provider overload surfaces plainly
    // because changing models immediately usually hits the same outage.
    let failure: { transient: boolean; providerOverloaded?: boolean; content?: string } | null = null;

    const dry = modelUnavailableReason(currentOpts, currentModel);
    if (dry) {
      recordPoolDryShortCircuit(currentOpts, currentModel, dry);
      failure = { transient: false, content: dry };
    } else {
      for await (const event of runOnModel(currentOpts, currentModel)) {
        if (event.type === "init") {
          currentEngineId = event.sessionId || currentEngineId;
        }
        if (event.type === "done" && event.usageLimitExhausted === true) {
          failure = { transient: false };
          break;
        }
        if (event.type === "error") {
          if (event.usageLimitExhausted === true) {
            failure = { transient: false, content: event.content };
            break;
          }
          if (isProviderOverloadError(event.content)) {
            failure = { transient: false, providerOverloaded: true, content: event.content };
            break;
          }
          // A non-usage error that looks like infra (server death, wedge, 5xx,
          // network, SQLite contention): the opencode runner already spent its own
          // in-attempt retry, so escalate to the next model rather than failing.
          if (isTransientRunError(event.content)) {
            failure = { transient: true, content: event.content };
            break;
          }
        }
        yield event;
      }
    }

    if (!failure || wasCancelled()) return;

    if (failure.providerOverloaded) {
      yield {
        type: "error",
        content:
          "The model provider is temporarily overloaded. Your session and completed work are preserved. " +
          "Retry this prompt in a minute.",
        provider: providerFor(currentModel),
        model: currentModel,
      };
      return;
    }

    // Two models in a row dying the TRANSIENT way is an infrastructure
    // problem (dead rpc socket, wedged bridge, network) — every further rung
    // would burn its own liveness window and fail identically, and the walk
    // would end by blaming usage for what is an outage. Stop and say what
    // actually happened. (2026-07-17 stolen-socket outage: the walk burned
    // Fable→Sol→Opus→GPT-5.5 for ~12 min per prompt, then told users the
    // models were "out of usage".)
    if (failure.transient) {
      consecutiveTransient++;
      if (consecutiveTransient >= 2) {
        yield {
          type: "error",
          content:
            `${modelLabel(currentModel)} also failed with a transient engine error. ` +
            `${consecutiveTransient} models in a row failed the same way, so this looks like ` +
            `infrastructure (engine bridge, MCP socket, or network). Stopping the fallback ` +
            `walk; retry in a minute or ping ${personaName()}. ` +
            `Last error: ${failure.content || "unknown"}`,
          provider: providerFor(currentModel),
          model: currentModel,
        };
        return;
      }
    } else {
      consecutiveTransient = 0;
    }

    const currentGraphModel = preservePiEngine
      ? toOpencodeModel(currentModel.replace(/^pi\//, "")) || currentModel
      : toOpencodeModel(currentModel) || currentModel;
    exhaustedModels.add(currentGraphModel);
    const hop = nextFallbackModel(currentGraphModel, exhaustedModels, preferredFallback);
    if (!hop) {
      // Nothing left to try — surface the terminal error we were suppressing.
      yield {
        type: "error",
        content: failure.transient
          ? failure.content ||
            `${modelLabel(currentModel)} failed and no fallback models remain.`
          : `${modelLabel(currentModel)} is out of usage, and no fallback models remain.`,
        provider: providerFor(currentModel),
        model: currentModel,
        usageLimitExhausted: failure.transient ? undefined : true,
      };
      return;
    }
    const nextModel = preservePiEngine ? toPiModel(hop.id) : hop.id;
    if (!nextModel) {
      yield {
        type: "error",
        content: `${modelLabel(currentModel)} is out of usage, and its fallback cannot run on Pi.`,
        provider: providerFor(currentModel),
        model: currentModel,
        usageLimitExhausted: true,
      };
      return;
    }

    // Downgrade to a dumber model (Fable→Opus, Opus→Sonnet, Sol→Opus): a human
    // decides. Interactive runs get an AskUserQuestion; headless runs
    // (automations, workflow sub-agents, restart resumes without an ask handler)
    // auto-proceed — stalling them would defeat "continue without failing".
    if (hop.mode === "ask") {
      const approved = await askFallbackApproval(
        opts.onAskUser,
        currentModel,
        nextModel,
        failure.transient
      );
      if (!approved) {
        // Name the real cause — a transient engine failure declined here must
        // NOT read as "out of usage" (that mislabel sent people chasing
        // billing during the 2026-07-17 infra outage).
        yield {
          type: "error",
          content: failure.transient
            ? `${modelLabel(currentModel)} hit a transient engine failure. ` +
              `Declined the fallback to ${modelLabel(nextModel)}. Retry this prompt, or use /model to switch.`
            : `${modelLabel(currentModel)} is out of usage. ` +
              `Declined the fallback to ${modelLabel(nextModel)}. Use /model to switch when ready.`,
          provider: providerFor(currentModel),
          model: currentModel,
          usageLimitExhausted: failure.transient ? undefined : true,
        };
        return;
      }
    }
    if (wasCancelled()) return;

    // Everything runs on the opencode engine, so `providerFor` reports
    // "opencode" for both sides and can't tell a same-family switch from a
    // cross-family one. The decision that matters — resume the partial session
    // vs. start fresh with a handoff — turns on the UNDERLYING provider
    // (anthropic ↔ openai): same family resumes the opencode session; a family
    // switch needs a fresh session seeded with the prior transcript.
    const fromFamily = engineFamily(currentModel);
    const toFamily = engineFamily(nextModel);
    const crossProvider = fromFamily !== toFamily;
    const reason = failure.transient ? "hit a transient failure" : "is out of usage on all accounts";
    console.warn(
      `[runner] ${currentModel} ${reason}; falling back to ${nextModel} (${hop.mode})`
    );
    const transientFallback = !!currentOpts.transientFallback || failure.transient;
    // Structured cue: usage exhaustion becomes a durable selection change;
    // transient recovery is explicitly marked as current-turn-only.
    yield {
      type: "model_switch",
      fromModel: currentModel,
      toModel: nextModel,
      switchReason: failure.transient ? "hit a transient engine error" : "out of credits",
      temporaryFallback: transientFallback,
    };

    let prompt = currentOpts.prompt;
    let handoffEntries: TranscriptEntry[] = [];
    if (crossProvider) {
      // Read the prior turn from the CURRENT engine's store: an opencode
      // session id reads from OpenCode's store regardless of which model
      // family produced it; a pi run's history is served from the owned
      // transcript store via the "pi" branch (the id is a pi session uuid —
      // the old hardcoded "opencode" arg would return nothing for it).
      // Gate on currentEngineId (present when resuming an existing session),
      // NOT on sawInit: an account pool that is dry *at pick time* throws
      // usageLimitExhausted BEFORE any init event, so sawInit stays false — yet
      // the resumed session on disk still holds the full history to hand off.
      // Requiring sawInit here dropped that history and started the fallback
      // model on a blank session (the "history lost after fallback" bug).
      const entries = currentEngineId
        ? await readEngineTranscriptAsync(
            currentOpts.cwd,
            currentEngineId,
            transcriptProviderFor(currentModel)
          )
        : [];
      handoffEntries = entries;
      if (entries.length) {
        prompt =
          `${wrapContext(
            buildEngineSwitchHandoffNote({
              fromModel: currentModel,
              fromProvider: familyLabel(fromFamily),
              toProvider: familyLabel(toFamily),
              targetResuming: false,
              entries,
            }),
            "handoff"
          )}\n\n${prompt}`;
      } else {
        prompt +=
          "\n\n[Note: a previous attempt on another model was cut short and may have " +
          "left partial work in this directory — review what's already done before continuing.]";
      }
    }
    if (wasCancelled()) return;

    currentOpts = {
      ...currentOpts,
      prompt,
      selectedModel: transientFallback ? currentOpts.selectedModel : nextModel,
      transientFallback,
      // Account ids are provider-local. A fallback to another family must not
      // reinterpret the source provider's pin (including a strict cost cap).
      ...(crossProvider ? { accountId: undefined, accountStrict: undefined } : {}),
      // Same family can resume the partial session; a family switch starts fresh
      sessionId: crossProvider ? undefined : currentEngineId,
      // The fresh opencode session is seeded with the history the handoff covers.
      seedTranscriptEntries:
        crossProvider && handoffEntries.length ? handoffEntries : undefined,
      journal: opts.journal
        ? { ...opts.journal, kind: `${opts.journal.kind || "run"}-fallback` }
        : undefined,
    };
    currentModel = nextModel;
  }
}

/** Underlying engine provider family of a model id ("anthropic" / "openai"),
 *  read from its opencode mapping. Drives resume-vs-fresh on a fallback hop.
 *  Families are ENGINE-scoped: a pi engine session can never be resumed by
 *  opencode (or vice versa) even when both sides run the same upstream
 *  provider, so pi/<provider>/… reports "pi-<provider>" — a pi↔opencode hop
 *  is always cross-family (fresh session + transcript handoff) while pi→pi
 *  stays same-family and resumes its own session. */
export function engineFamily(model: string): string {
  const piFamily = model.match(/^pi\/([^/]+)\//)?.[1];
  if (piFamily) return `pi-${piFamily}`;
  const oc = toOpencodeModel(model) || model;
  return oc.match(/^opencode\/([^/]+)\//)?.[1] || providerFor(model);
}

/** Map an engine family to the handoff note's provider label. */
function familyLabel(family: string): "claude" | "codex" | "opencode" | "pi" {
  if (family.startsWith("pi-")) return "pi";
  if (family === "anthropic") return "claude";
  if (family === "openai") return "codex";
  return "opencode";
}

/**
 * Confirm a downgrade fallback with the human. Interactive runs surface an
 * AskUserQuestion card (web UI + Slack escalation); headless runs — no
 * onAskUser — auto-approve so automations and workflow sub-agents keep going
 * rather than dead-ending on the limit. Returns false only when a human is
 * present and declined (or nobody answered).
 */
async function askFallbackApproval(
  onAskUser: RunAgentOpts["onAskUser"],
  fromModel: string,
  toModel: string,
  transient: boolean
): Promise<boolean> {
  if (!onAskUser) return true;
  const reason = transient
    ? `**${modelLabel(fromModel)}** hit a transient failure`
    : `**${modelLabel(fromModel)}** is out of usage`;
  const switchLabel = `Switch to ${modelLabel(toModel)}`;
  let answer;
  try {
    answer = await onAskUser({
      questions: [
        {
          question: `${reason}. Fall back to the lighter **${modelLabel(toModel)}** to keep going?`,
          header: "Model fallback",
          options: [
            { label: switchLabel, description: "Continue this turn on the fallback model" },
            { label: "Stop here", description: "Don't switch — I'll pick a model myself" },
          ],
          multiSelect: false,
        },
      ],
    });
  } catch (e) {
    console.warn(`[runner] fallback approval ask failed for ${fromModel}→${toModel}:`, e);
    return false;
  }
  if (answer.behavior === "deny") return false; // nobody answered / timed out
  const picked = String(
    Object.values((answer.updatedInput as { answers?: Record<string, string> }).answers || {})[0] || ""
  ).toLowerCase();
  return picked.startsWith("switch") || picked.startsWith("yes");
}

// Sessions whose prompt run has started but isn't registered in the runner's
// activeRuns yet — runSessionPrompt awaits (worktree revive, title gen, upload
// staging) before the generator is first pulled, so two racing prompts could
// both pass the busy check and the loser's message got dropped as a "Session
// is busy" error. Marked synchronously before any await; parked on globalThis
// so a hot reload keeps it.
const runnerGlobal = globalThis as any;
const pendingStarts: Map<string, Set<string>> = (runnerGlobal.__pendingSessionStartTokens ??=
  new Map());
const cancelledRunTokens: Set<string> = ((globalThis as any)
  .__cancelledRunTokens ??= new Set());
const activeSessionRunTokens: Map<string, Set<string>> = ((globalThis as any)
  .__activeSessionRunTokens ??= new Map());
const sessionRunOwners: Map<string, string> = ((globalThis as any)
  .__sessionRunOwners ??= new Map());
const cancelledRecoveries: Set<ActiveRunRecord> = ((globalThis as any)
  .__cancelledRecoveries ??= new Set());
const activeRecoveryRuns: Map<string, ActiveRunRecord> = ((globalThis as any)
  .__activeRecoveryRuns ??= new Map());
const activeRecoveryWorkerRunKeys: Set<string> = ((globalThis as any)
  .__activeRecoveryWorkerRunKeys ??= new Set());
// Recoveries that reached a LIVE engine turn (reattach succeeded). Two
// consequences: their queue slot is released (the turn runs on a detached
// server and costs this process nothing), and an abandonment must not abort
// their engine session — an attached run owns an AbortController, and after
// journalClear the same engine session id belongs to the continuation.
const attachedRecoveryRunKeys: Set<string> = ((globalThis as any)
  .__attachedRecoveryRunKeys ??= new Set());

// Boot adoption reserves each detached survivor until its recovery reaches
// it. What "until" means lives here, not on a clock: a recovery is still
// coming while it is tracked, whether it is queued behind the bounded boot
// queue, promoted out of it, or mid-probe. Registering in memory at module
// scope keeps the dependency one-way (agent-runner → opencode-runner) and
// arms nothing; same shape as run-journal's registerActiveRunProbe.
registerPendingRecoveryProbe((ocSessionId) => activeRecoveryRuns.has(ocSessionId));

// Hot reloads can leave the pre-token Set globals alive in old module
// closures. Keep observing them until those preparations unwind; using a new
// key for the token map avoids ever casting that Set to a Map and crashing.
function legacyPendingStarts(): Set<string> | undefined {
  const value = runnerGlobal.__pendingSessionStarts;
  return value instanceof Set ? value : undefined;
}

function legacyCancelledSessions(): Set<string> {
  const value = runnerGlobal.__cancelledSessionRuns;
  if (value instanceof Set) return value;
  return (runnerGlobal.__cancelledSessionRuns = new Set<string>());
}

function trackRecovery(run: ActiveRunRecord): void {
  for (const id of [run.osSessionId, run.claudeSessionId]) {
    if (id) activeRecoveryRuns.set(id, run);
  }
  // The run's detached engine is executing RIGHT NOW, whatever the recovery
  // queue is doing — give its in-process MCP calls their token back here
  // rather than in the reattach body, which may be minutes away (2026-08-16).
  restoreJournaledRunRpcContext(run);
}

function untrackRecovery(run: ActiveRunRecord): void {
  for (const id of [run.osSessionId, run.claudeSessionId]) {
    if (id && activeRecoveryRuns.get(id)?.runKey === run.runKey)
      activeRecoveryRuns.delete(id);
  }
  attachedRecoveryRunKeys.delete(run.runKey);
  releaseJournaledRunRpcContext(run);
}

/** Mark a session as starting a run (call synchronously, before any await). */
export function markSessionStarting(id: string): string {
  const token = crypto.randomUUID();
  let tokens = pendingStarts.get(id);
  if (!tokens) pendingStarts.set(id, (tokens = new Set()));
  tokens.add(token);
  const state = getRunState(id);
  if (
    !sessionRunOwners.has(id) ||
    state === "idle" ||
    state === "stopped" ||
    state === "failed"
  ) {
    sessionRunOwners.set(id, token);
  }
  transitionRunState(id, "prompt");
  return token;
}

/** Clear a starting mark (call in a `finally` once the run has ended). */
export function unmarkSessionStarting(id: string, token?: string): void {
  const tokens = pendingStarts.get(id);
  const owned = token || (tokens?.size === 1 ? tokens.values().next().value : undefined);
  if (owned) tokens?.delete(owned);
  if (!tokens?.size) pendingStarts.delete(id);
  if (owned && sessionRunOwners.get(id) === owned) sessionRunOwners.delete(id);
  if (owned) cancelledRunTokens.delete(owned);
}

/** Whether Stop has latched this admitted turn before its runner registered. */
export function isAgentSessionCancelled(id: string, token?: string): boolean {
  if (token) return cancelledRunTokens.has(token);
  if (legacyCancelledSessions().has(id)) return true;
  return [...(pendingStarts.get(id) || [])].some((owned) =>
    cancelledRunTokens.has(owned),
  );
}

/** Live engine/runner busy check, excluding restart-recovery FSM state. */
export function isAgentLiveEngineBusy(...ids: Array<string | null | undefined>): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (
      pendingStarts.has(id) ||
      legacyPendingStarts()?.has(id) ||
      activeSessionRunTokens.has(id) ||
      isOpencodeSessionBusy(id) ||
      isPiSessionBusy(id) ||
      hostRunBusy(id)
    )
      return true;
  }
  return false;
}

/** Live engine work plus queued/in-progress restart recovery ownership. */
export function isAgentEngineBusy(...ids: Array<string | null | undefined>): boolean {
  return ids.some((id) => !!id && activeRecoveryRuns.has(id)) ||
    isAgentLiveEngineBusy(...ids);
}

/** Busy check (pass any engine/backstage session id). */
export function isAgentSessionBusy(...ids: Array<string | null | undefined>): boolean {
  if (hasActiveRunFor(...ids) || isAgentEngineBusy(...ids)) return true;
  return ids.some((id) => {
    if (!id) return false;
    const state = getRunState(id);
    return state === "interrupted" || state === "reattaching";
  });
}

/**
 * How many runs this process is actively driving. Used by graceful shutdown
 * to wait for in-flight work to reach a stopping point before exiting. (Does
 * not count external CLI/tmux runs — we can't drain those.)
 */
export function activeAgentRunCount(): number {
  return activeOpencodeRunCount() + activePiRunCount() + hostRunCount();
}

/** Of those, how many execute on a DETACHED engine server that survives a
 *  restart — the graceful-shutdown drain skips waiting on these (boot
 *  reattaches them via the journal instead). In-process Pi contributes 0;
 *  Pi inside a local run host contributes through hostRunCount(). */
export function activeDetachedAgentRunCount(): number {
  return activeDetachedOpencodeRunCount() + hostRunCount();
}

/**
 * Steer a message into an in-flight run. Opencode runs steer in-band since
 * 2026-07-12 (steerOpencodeRun: a noReply history append the running turn
 * picks up at its next step boundary — Claude-SDK-steer semantics); pi runs
 * steer natively (session.steer folds the message in at the next step);
 * host-forwarded runs steer over RPC. False = nothing steerable — caller
 * should queue.
 */
export function steerAgentRun(
  ids: Array<string | null | undefined>,
  text: string,
  images?: ImageInput[]
): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (steerOpencodeRun(id, text, images)) return true;
    if (steerPiRun(id, text, images)) return true;
    // Host-forward RPC is text-only: a send with images falls through
    // (caller queues it — the queue drain delivers images).
    if (!images?.length && hostSteer(id, text)) return true;
  }
  return false;
}

/**
 * Bare interrupt: no engine supports it anymore (it released a Claude run's
 * held steers at a turn boundary). Kept for caller compat — always false, so
 * callers fall back to the queue flap's other paths.
 */
export function interruptAgentRun(
  _ids: Array<string | null | undefined>
): boolean {
  return false;
}

/**
 * Esc-style stop: the opencode engine has no graceful stop-turn — callers
 * fall back to the hard cancel (cancelAgentRun aborts the turn server-side).
 */
export function stopAgentRunTurn(
  _ids: Array<string | null | undefined>
): boolean {
  return false;
}

/**
 * Esc-style redirect: abort the current turn but keep the run alive,
 * continuing immediately with the given message. Host-forwarded runs only;
 * false = caller should fall back to cancel + queue.
 */
export function interruptAndSteerAgentRun(
  ids: Array<string | null | undefined>,
  text: string,
  images?: ImageInput[]
): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (!images?.length && hostInterruptSteer(id, text)) return true;
  }
  return false;
}

/** Cancel a run; returns true if anything was cancelled. */
export function cancelAgentRun(...ids: Array<string | null | undefined>): boolean {
  let cancelled = false;
  for (const id of ids) {
    if (!id) continue;
    if (cancelOpencodeRun(id)) cancelled = true;
    if (cancelPiRun(id)) cancelled = true;
    if (hostCancel(id)) cancelled = true;
  }
  const wanted = new Set(ids.filter((id): id is string => !!id));
  for (const id of wanted) {
    const pendingTokens = pendingStarts.get(id) || new Set<string>();
    const activeTokens = activeSessionRunTokens.get(id) || new Set<string>();
    for (const token of pendingTokens) cancelledRunTokens.add(token);
    for (const token of activeTokens)
      cancelledRunTokens.add(token);
    const legacyPending = legacyPendingStarts()?.has(id) === true;
    if (legacyPending) legacyCancelledSessions().add(id);
    if (!pendingTokens.size && !activeTokens.size && !legacyPending) continue;
    if (isRunStateUnsettled(getRunState(id)))
      transitionRunState(id, "cancel", { source: "run_cancelled_preparation" });
    cancelled = true;
  }
  const records = new Map<string, ActiveRunRecord>();
  const recoveryRunKeys = new Set<string>();
  for (const run of activeRunRecords()) {
    if (
      (run.osSessionId && wanted.has(run.osSessionId)) ||
      (run.claudeSessionId && wanted.has(run.claudeSessionId))
    )
      records.set(run.runKey, run);
  }
  for (const id of wanted) {
    const recovery = activeRecoveryRuns.get(id);
    if (recovery) {
      records.set(recovery.runKey, recovery);
      recoveryRunKeys.add(recovery.runKey);
    }
  }
  for (const run of records.values()) {
    if (recoveryRunKeys.has(run.runKey)) {
      cancelledRecoveries.add(run);
      // Stop has to reach the ENGINE even when the recovery never started: a
      // detached turn that was never reattached has no in-process
      // AbortController for cancelOpencodeRun to find, so without this it
      // keeps working in the session's worktree after the session goes idle.
      if (!attachedRecoveryRunKeys.has(run.runKey))
        void abortInterruptedDetachedTurn(run).catch(() => {});
    }
    journalClear(run.runKey);
    // A queued recovery has not crossed an async boundary yet, so its marker
    // is enough to make it exit when scheduled. An active worker keeps its
    // reservation until its probe/stream actually unwinds; otherwise a new
    // prompt can overlap work that Stop has not finished cancelling.
    if (!activeRecoveryWorkerRunKeys.has(run.runKey)) untrackRecovery(run);
    if (run.osSessionId && isRunStateUnsettled(getRunState(run.osSessionId)))
      transitionRunState(run.osSessionId, "cancel", {
        run_key: run.runKey,
        source: "run_cancelled",
      });
    cancelled = true;
  }
  return cancelled;
}

/** Per-session AskUserQuestion handler, mirroring RunAgentOpts.onAskUser. */
type AskHandler = NonNullable<RunAgentOpts["onAskUser"]>;

/**
 * Resume runs that a previous process left in-flight (service restart or
 * crash). Each resumable run gets a continuation prompt against its engine
 * session, on whichever backend the journaled model belongs to.
 *
 * `askHandlerFor` re-attaches an AskUserQuestion handler (the web-UI + Slack
 * escalation handler) to interactive sessions — without it, a run that was
 * blocked on an ask comes back headless and dead-ends every question. It
 * returns undefined for sessions that should stay headless (automations).
 *
 * `inProcessMcpFor` and `reposNoteFor` rebuild trusted interactive context
 * that is deliberately not serialized into the restart journal.
 */
export function resumeInterruptedRuns(
  onResumed?: (
    osSessionId?: string,
    terminalEvent?: StreamEvent,
  ) => void,
  askHandlerFor?: (osSessionId: string) => AskHandler | undefined,
  inProcessMcpFor?: (osSessionId: string, user?: string) => Record<string, unknown> | undefined,
  reposNoteFor?: (osSessionId: string) => string | undefined,
  onEvent?: (osSessionId: string, event: StreamEvent) => void,
  snapshotLocalHostRuns: ActiveRunRecord[] = [],
): string[] {
  const resumed: string[] = [];
  const settledRunKeys = new Set<string>();
  const rememberHandledSession = (run: ActiveRunRecord) => {
    if (run.osSessionId && !resumed.includes(run.osSessionId))
      resumed.push(run.osSessionId);
  };
  const emitRecoveryEvent = (run: ActiveRunRecord, event: StreamEvent) => {
    if (!run.osSessionId) return;
    try {
      onEvent?.(run.osSessionId, event);
    } catch (e) {
      console.error(`[runner] Recovered event observer failed for ${run.runKey}:`, e);
    }
  };
  const settleRecovery = (run: ActiveRunRecord, event: StreamEvent): boolean => {
    if (settledRunKeys.has(run.runKey)) return false;
    settledRunKeys.add(run.runKey);
    rememberHandledSession(run);
    try {
      emitRecoveryEvent(run, event);
      try {
        onResumed?.(run.osSessionId, event);
      } catch (e) {
        console.error(`[runner] Recovery settlement callback failed for ${run.runKey}:`, e);
      }
    } finally {
      if (run.osSessionId && isRunStateUnsettled(getRunState(run.osSessionId))) {
        const failed = event.type === "error" || !!event.usageLimitExhausted;
        transitionRunState(run.osSessionId, failed ? "run_failed" : "turn_end", {
          run_key: run.runKey,
          source: "recovery_fallback_settlement",
        });
      }
      journalClear(run.runKey);
      if (!activeRecoveryWorkerRunKeys.has(run.runKey)) untrackRecovery(run);
    }
    return true;
  };
  const reportRecoveryFailure = (run: ActiveRunRecord, content: string) => {
    settleRecovery(run, {
      type: "error",
      content,
      model: run.model,
    });
  };
  const abandonStoppedRecovery = (run: ActiveRunRecord): boolean => {
    const cancelled = cancelledRecoveries.delete(run);
    if (
      !cancelled &&
      (!run.osSessionId || getRunState(run.osSessionId) !== "stopped")
    )
      return false;
    journalClearIfLineage(run);
    return true;
  };
  const recoveryTask = (
    run: ActiveRunRecord,
    task: (releaseQueueSlot: () => void) => Promise<void>,
  ): (() => Promise<void>) => {
    // A claimed journal record is intentionally durable, but the recovery
    // queue is bounded, so a run can sit here behind other recoveries. It
    // must never be declared dead for that reason: its engine turn is still
    // executing on a detached server that outlived the restart, so telling
    // the person "send the prompt again" left the predecessor working and put
    // TWO engines in one worktree (2026-08-16). Start it instead, outside the
    // queue, which is the one thing a starved recovery actually needs.
    let started = false;
    let queuedTooLong: ReturnType<typeof setTimeout> | undefined;
    const start = async () => {
      if (started) return;
      started = true;
      clearTimeout(queuedTooLong);
      if (settledRunKeys.has(run.runKey)) {
        // Never reaches the worker's finally, so drain the stop marker here.
        cancelledRecoveries.delete(run);
        return;
      }
      activeRecoveryWorkerRunKeys.add(run.runKey);
      let releaseQueueSlot!: () => void;
      const slotFree = new Promise<void>((resolve) => {
        releaseQueueSlot = resolve;
      });
      // The task keeps running after it frees its slot; only the QUEUE's
      // accounting ends early. Its own try/finally still owns the recovery
      // lifetime (worker key, untrackRecovery), so nothing else moves.
      void (async () => {
        try {
          await task(releaseQueueSlot);
        } catch (error) {
          // Keep one unexpected recovery failure from stranding the rest of the
          // boot queue behind it. Normal recovery paths already report their own
          // failures, so this is only the last-resort guard.
          console.error(`[runner] Recovery worker crashed for ${run.runKey}:`, error);
          if (!settledRunKeys.has(run.runKey))
            reportRecoveryFailure(
              run,
              "Restart recovery stopped unexpectedly. Send the prompt again to continue.",
            );
        } finally {
          activeRecoveryWorkerRunKeys.delete(run.runKey);
          untrackRecovery(run);
          // abandonStoppedRecovery is what normally drains the stop marker,
          // but only on the paths that reach it: a recovery that ended with a
          // terminal event can stop polling first. Drain unconditionally here
          // so a cancelled recovery cannot hold its record for the process
          // lifetime. Safe after untrackRecovery: cancelAgentRun can no
          // longer find this run to mark it again.
          cancelledRecoveries.delete(run);
          releaseQueueSlot();
        }
      })();
      await slotFree;
    };
    queuedTooLong = setTimeout(() => {
      if (started || settledRunKeys.has(run.runKey)) return;
      console.warn(
        `[runner] Restart recovery for ${run.runKey} waited ${BOOT_RECOVERY_QUEUE_WAIT_MS / 60_000} minutes for a queue slot — starting it outside the queue`,
      );
      audit({
        kind: "restart_recovery_promoted",
        session_id: run.osSessionId,
        run_key: run.runKey,
        waited_ms: BOOT_RECOVERY_QUEUE_WAIT_MS,
      });
      void start();
    }, BOOT_RECOVERY_QUEUE_WAIT_MS);
    return start;
  };
  const cancelRecoveredEngine = (run: ActiveRunRecord): void => {
    for (const id of [run.claudeSessionId, run.osSessionId, run.runKey]) {
      if (!id) continue;
      cancelOpencodeRun(id);
      cancelPiRun(id);
      hostCancel(id);
    }
  };
  const snapshotSeeds = snapshotLocalHostRuns.filter(
    (run) => !!run.hostId && !run.sandboxId && !run.runnerId,
  );
  const taken = takeInterruptedRuns(snapshotSeeds);
  // A graceful shutdown snapshot is intentionally broader than the shared
  // run journal: it also covers turns that finish during the drain. A local
  // detached host can still be alive even when its shared record disappeared
  // during process teardown. Seed those snapshot records into the atomic boot
  // claim so resumeLocalHostRun owns them synchronously and the generic
  // drained-session wake cannot start a second host for the same turn.
  const { interrupted, quarantined } = sanitizeInterruptedRuns(taken);
  journalQuarantine(quarantined);
  const recoveringEngineSessions = new Set(
    interrupted.flatMap((run) => (run.claudeSessionId ? [run.claudeSessionId] : [])),
  );
  const quarantineAborts: Promise<boolean>[] = [];
  for (const entry of quarantined) {
    // A quarantined record can still have a live detached engine turn behind
    // it, including a duplicate that deliberately carries notify:false. Abort
    // a discarded engine session unless the kept recovery owns the same one;
    // abortDetachedOpencodeTurn separately guards live in-process ownership.
    const shouldAbortDetached =
      !!entry.run.serverKey &&
      !!entry.run.claudeSessionId &&
      !recoveringEngineSessions.has(entry.run.claudeSessionId);
    const abort = shouldAbortDetached
      ? abortInterruptedDetachedTurn(entry.run).catch(() => false)
      : undefined;
    if (abort) quarantineAborts.push(abort);
    if (!entry.notify || !entry.run.osSessionId) {
      void abort;
      continue;
    }
    const message = recoveryQuarantineMessage(entry);
    if (abort) void abort.finally(() => reportRecoveryFailure(entry.run, message));
    else reportRecoveryFailure(entry.run, message);
  }
  const recoveryTasks: Array<() => Promise<void>> = [];

  for (const run of interrupted) {
    // The github agent owns its own recovery (review/simplify re-trigger on the
    // next PR event; auto-fix loops are resumed by the github agent's startup
    // sweep). Resuming them generically would double-drive an auto-fix loop.
    if (run.kind?.startsWith("github-")) {
      rememberHandledSession(run);
      journalClear(run.runKey);
      if (run.osSessionId) transitionRunState(run.osSessionId, "turn_end");
      continue;
    }
    // Slack runs journal (their bks session id feeds the in-process MCP proxy
    // path), but the Slack queue re-delivers interrupted messages itself — a
    // generic resume would double-drive the turn with no streamer attached.
    if (run.kind?.startsWith("slack")) {
      rememberHandledSession(run);
      journalClear(run.runKey);
      if (run.osSessionId) transitionRunState(run.osSessionId, "turn_end");
      continue;
    }
    // Workflow fan-out agents ("workflow", plus -resume/-rerun suffixes): the
    // orchestration state (the script's Worker) died with the process — the
    // workflow store marks the run interrupted on boot, and replaying a lone
    // child agent without its script would be noise.
    if (run.kind?.startsWith("workflow")) {
      rememberHandledSession(run);
      journalClear(run.runKey);
      if (run.osSessionId) transitionRunState(run.osSessionId, "turn_end");
      continue;
    }
    // Runner hosts are persistent, outbound-dial run hosts just like remote
    // Sandboxes. Reattach through their Runner control channel only. A failed
    // reattach must never fall through to an in-process server run, because
    // that would silently change the selected execution machine.
    if (run.runnerId) {
      rememberHandledSession(run);
      trackRecovery(run);
      recoveryTasks.push(recoveryTask(run, async () => {
        let terminalSeen = false;
        try {
          if (abandonStoppedRecovery(run)) return;
          Object.assign(run, journalStartRecovery(run));
          const events = await (await import("./runner-session")).resumeRunnerRun(run, {
            onAskUser: run.osSessionId ? askHandlerFor?.(run.osSessionId) : undefined,
          });
          if (abandonStoppedRecovery(run)) return;
          if (!events) {
            reportRecoveryFailure(
              run,
              "Restart recovery could not reconnect to the interrupted Runner. Check its connection, then send the prompt again.",
            );
            return;
          }
          for await (const event of events) {
            if (abandonStoppedRecovery(run)) return;
            if (event.type === "done" || event.type === "error") {
              terminalSeen = settleRecovery(run, event) || terminalSeen;
            } else emitRecoveryEvent(run, event);
          }
          if (abandonStoppedRecovery(run)) return;
          if (!terminalSeen) {
            reportRecoveryFailure(
              run,
              "Restart recovery ended before the Runner returned a final result. Send the prompt again to continue.",
            );
          }
        } catch (error) {
          console.error(`[runner] Runner resume failed for ${run.runKey}:`, error);
          if (abandonStoppedRecovery(run)) return;
          if (!terminalSeen) {
            reportRecoveryFailure(
              run,
              "Restart recovery failed while reconnecting to the Runner. Check its connection, then send the prompt again.",
            );
          }
        }
      }));
      continue;
    }
    // Sandboxed runs (docs/self-hosting-sandboxes.md): the sandbox — and
    // often the in-sandbox run host itself — outlives a opensession restart.
    // Reattach/relaunch through the provider instead of running in-process;
    // the sandbox modules are imported lazily so these paths stay completely
    // out of processes that never touch them.
    if (
      run.sandboxId &&
      (run.sandboxProvider === "docker" ||
        run.sandboxProvider === "daytona" ||
        run.sandboxProvider === "e2b" ||
        run.sandboxProvider === "box" ||
        run.sandboxProvider === "modal" ||
        run.sandboxProvider === "microvm" ||
        run.sandboxProvider === "lambda-microvm")
    ) {
      const isDocker = run.sandboxProvider === "docker";
      rememberHandledSession(run);
      trackRecovery(run);
      recoveryTasks.push(recoveryTask(run, async () => {
        const recoveryStartedAt = Date.now();
        let recoveryRecorded = false;
        let terminalSeen = false;
        const recordRecovery = (outcome: "ok" | "failed", reason?: string) => {
          if (recoveryRecorded) return;
          recoveryRecorded = true;
          audit({
            kind: "sandbox_restart_survival_metric",
            session_id: run.osSessionId,
            provider: run.sandboxProvider,
            sandbox_id: run.sandboxId,
            recovery_ms: Date.now() - recoveryStartedAt,
            outcome,
            ...(reason ? { reason } : {}),
          });
        };
        try {
          if (abandonStoppedRecovery(run)) return;
          Object.assign(run, journalStartRecovery(run));
          const resume = isDocker
            ? (await import("./sandbox/docker")).resumeDockerSandboxRun
            : (await import("./sandbox/adapters/bootstrap")).resumeRemoteSandboxRun;
          if (abandonStoppedRecovery(run)) return;
          const events = await resume(run, {
            onAskUser: run.osSessionId ? askHandlerFor?.(run.osSessionId) : undefined,
          });
          if (abandonStoppedRecovery(run)) {
            cancelRecoveredEngine(run);
            return;
          }
          if (!events) {
            console.warn(
              `[runner] Sandbox ${run.sandboxId} for interrupted run ${run.runKey} is gone — the session's next prompt recreates it`
            );
            reportRecoveryFailure(
              run,
              "Restart recovery could not reconnect to the interrupted sandbox. Send the prompt again to continue.",
            );
            recordRecovery("failed", "sandbox_unavailable");
            return;
          }
          for await (const event of events) {
            if (abandonStoppedRecovery(run)) return;
            if (event.type === "done" || event.type === "error") {
              terminalSeen = settleRecovery(run, event) || terminalSeen;
              recordRecovery(event.type === "done" ? "ok" : "failed", event.type);
            } else emitRecoveryEvent(run, event);
          }
          if (abandonStoppedRecovery(run)) return;
          if (!terminalSeen) {
            reportRecoveryFailure(
              run,
              "Restart recovery ended before the interrupted sandbox returned a final result. Send the prompt again to continue.",
            );
            recordRecovery("failed", "stream_ended_without_terminal_event");
          }
        } catch (e) {
          recordRecovery("failed", "recovery_error");
          console.error(`[runner] Sandbox resume failed for ${run.runKey}:`, e);
          if (abandonStoppedRecovery(run)) return;
          if (!terminalSeen)
            reportRecoveryFailure(
              run,
              "Restart recovery failed while reconnecting to the interrupted sandbox. Send the prompt again to continue.",
            );
        }
      }));
      continue;
    }
    // LOCAL detached run hosts (in-process engines: pi). The host process
    // outlived the restart in its own transient systemd unit; reattach to its
    // socket and re-pump the live turn. A host that is gone (crashed mid-run,
    // dir cleaned up) falls back to the classic continuation re-prompt right
    // here: unlike sandboxes/Runners there is no execution boundary to
    // respect. The engine session lives in shared state on this machine, so
    // an in-process resume is exactly the pre-detach recovery behavior.
    if (run.hostId && !run.sandboxId && !run.runnerId) {
      rememberHandledSession(run);
      trackRecovery(run);
      recoveryTasks.push(recoveryTask(run, async () => {
        let terminalSeen = false;
        try {
          if (abandonStoppedRecovery(run)) return;
          Object.assign(run, journalStartRecovery(run));
          if (run.osSessionId)
            transitionRunState(run.osSessionId, "reattach_start", { run_key: run.runKey });
          const resumeLocalHost =
            localHostResumeForTest ??
            (await import("./host-client")).resumeLocalHostRun;
          const reattached = await resumeLocalHost(run, {
              onAskUser: run.osSessionId ? askHandlerFor?.(run.osSessionId) : undefined,
            })
            .catch((e) => {
              console.warn(`[runner] Local host reattach failed for ${run.runKey}:`, e);
              return null;
            });
          if (abandonStoppedRecovery(run)) {
            cancelRecoveredEngine(run);
            return;
          }
          if (run.osSessionId)
            transitionRunState(
              run.osSessionId,
              reattached ? "reattach_ok" : "reattach_fail",
              { run_key: run.runKey },
            );
          if (reattached) {
            Object.assign(run, journalMarkRecoveryAttached(run) || {});
          }
          let events = reattached;
          if (!events) {
            if (!run.prompt && !run.claudeSessionId) {
              reportRecoveryFailure(
                run,
                "Restart recovery could not reconnect to the detached run host and had nothing to resume. Send the prompt again to continue.",
              );
              return;
            }
            if (run.osSessionId)
              transitionRunState(run.osSessionId, "resume_reprompt", { run_key: run.runKey });
            // The re-run journals under its own runKey. Drop the host record.
            journalClear(run.runKey);
            console.log(
              `[runner] Local run host ${run.hostId} is gone; resuming ${run.osSessionId || run.runKey} in-process`,
            );
            events = runAgent({
              prompt: run.claudeSessionId
                ? resumeContinuationPrompt(run.prompt || "")
                : run.prompt!,
              promptEntryId: run.claudeSessionId ? undefined : run.promptEntryId,
              sessionId: run.claudeSessionId || undefined,
              cwd: run.cwd,
              mode: run.mode,
              model: run.model,
              selectedModel: run.selectedModel,
              transientFallback: run.transientFallback,
              effort: run.effort,
              fastMode: run.fastMode,
              mcpServers: run.mcpServers ?? "all",
              inProcessMcp: run.osSessionId
                ? inProcessMcpFor?.(run.osSessionId, run.user)
                : undefined,
              reposNote: run.osSessionId ? reposNoteFor?.(run.osSessionId) : undefined,
              user: run.user,
              deniedTools: run.deniedTools,
              confirmTools: run.confirmTools,
              aws: run.aws,
              fallbackModel: run.fallbackModel,
              accountId: run.accountId,
              accountStrict: run.accountStrict,
              usageCredits: run.usageCredits,
              journal: {
                osSessionId: run.osSessionId,
                kind: recoveryKind(run.kind, "resume"),
                firstJournaledAt: run.firstJournaledAt,
                resumeAttempts: run.resumeAttempts,
                lastResumeAt: run.lastResumeAt,
              },
              onAskUser: run.osSessionId ? askHandlerFor?.(run.osSessionId) : undefined,
            });
          }
          for await (const event of events) {
            if (abandonStoppedRecovery(run)) return;
            if (event.type === "done" || event.type === "error") {
              terminalSeen = settleRecovery(run, event) || terminalSeen;
            } else emitRecoveryEvent(run, event);
          }
          if (abandonStoppedRecovery(run)) return;
          if (!terminalSeen) {
            reportRecoveryFailure(
              run,
              "Restart recovery ended before the detached run host returned a final result. Send the prompt again to continue.",
            );
          }
        } catch (e) {
          console.error(`[runner] Local host resume failed for ${run.runKey}:`, e);
          if (abandonStoppedRecovery(run)) return;
          if (!terminalSeen)
            reportRecoveryFailure(
              run,
              "Restart recovery failed while reconnecting to the detached run host. Send the prompt again to continue.",
            );
        }
      }));
      continue;
    }
    if (!run.claudeSessionId) {
      // No engine session id means the run died before the model produced its
      // first turn (e.g. during MCP startup) — so nothing actually ran and no
      // side effects happened. If we journaled the original prompt we can safely
      // re-run it from scratch; otherwise it's genuinely unrecoverable.
      if (!run.prompt) {
        console.warn(
          `[runner] Interrupted run ${run.runKey} (${run.kind || "unknown"}) had no engine session and no saved prompt — cannot resume`
        );
        reportRecoveryFailure(
          run,
          "Restart recovery could not continue this turn because it had not saved an engine session or original prompt. Send the prompt again to continue.",
        );
        continue;
      }
      rememberHandledSession(run);
      trackRecovery(run);
      console.log(
        `[runner] Re-running interrupted ${run.kind || "run"} ${run.osSessionId || run.runKey} from scratch (never got an engine session)`
      );
      recoveryTasks.push(recoveryTask(run, async () => {
        let terminalSeen = false;
        try {
          if (abandonStoppedRecovery(run)) return;
          Object.assign(run, journalStartRecovery(run));
          if (run.osSessionId)
            transitionRunState(run.osSessionId, "resume_reprompt", {
              run_key: run.runKey,
            });
          // The re-run journals under its own runKey — drop the claimed
          // record now (runAgent's intake journalSet is the very next step,
          // so the unprotected window is one generator start, not the whole
          // adoption+probe phase the old wipe-on-take left open).
          journalClear(run.runKey);
          for await (const event of runAgent({
            prompt: run.prompt!,
            promptEntryId: run.promptEntryId,
            cwd: run.cwd,
            mode: run.mode,
            model: run.model,
            selectedModel: run.selectedModel,
            transientFallback: run.transientFallback,
            effort: run.effort,
            fastMode: run.fastMode,
            mcpServers: run.mcpServers ?? "all",
            inProcessMcp: run.osSessionId
              ? inProcessMcpFor?.(run.osSessionId, run.user)
              : undefined,
            reposNote: run.osSessionId ? reposNoteFor?.(run.osSessionId) : undefined,
            user: run.user,
            deniedTools: run.deniedTools,
            confirmTools: run.confirmTools,
            aws: run.aws,
            claudeCliEnv: run.claudeCliEnv,
            codexCliEnv: run.codexCliEnv,
            fallbackModel: run.fallbackModel,
            accountId: run.accountId,
            accountStrict: run.accountStrict,
            usageCredits: run.usageCredits,
            prReviewer: run.prReviewer,
            journal: {
              osSessionId: run.osSessionId,
              kind: recoveryKind(run.kind, "rerun"),
              firstJournaledAt: run.firstJournaledAt,
              resumeAttempts: run.resumeAttempts,
              lastResumeAt: run.lastResumeAt,
            },
            onAskUser: run.osSessionId ? askHandlerFor?.(run.osSessionId) : undefined,
          })) {
            if (abandonStoppedRecovery(run)) return;
            if (event.type === "done" || event.type === "error") {
              terminalSeen = settleRecovery(run, event) || terminalSeen;
            } else emitRecoveryEvent(run, event);
          }
          if (abandonStoppedRecovery(run)) return;
          if (!terminalSeen)
            reportRecoveryFailure(
              run,
              "Restart recovery ended before the interrupted turn returned a final result. Send the prompt again to continue.",
            );
        } catch (e) {
          console.error(`[runner] Re-run failed for ${run.runKey}:`, e);
          if (abandonStoppedRecovery(run)) return;
          if (!terminalSeen)
            reportRecoveryFailure(
              run,
              "Restart recovery failed while restarting the interrupted turn. Send the prompt again to continue.",
            );
        }
      }));
      continue;
    }
    rememberHandledSession(run);
    trackRecovery(run);
    recoveryTasks.push(recoveryTask(run, async (releaseQueueSlot) => {
      let recoverySettled = false;
      try {
        if (abandonStoppedRecovery(run)) return;
        Object.assign(run, journalStartRecovery(run));
        let repairingRecoveredResult = false;
        // First choice: REATTACH — the run's detached `opencode serve`
        // survived the restart and the turn may still be executing. The
        // adopted-pool lookup + session probe live in tryReattachOpencodeRun;
        // null means the server is gone (or was a direct child) and we fall
        // back to the classic continuation re-prompt below.
        if (run.serverKey) {
          if (run.osSessionId)
            transitionRunState(run.osSessionId, "reattach_start", { run_key: run.runKey });
          const reattached = await (reattachForTest ?? tryReattachOpencodeRun)(run, {
            onAskUser: run.osSessionId ? askHandlerFor?.(run.osSessionId) : undefined,
          }).catch((e) => {
            console.warn(`[runner] Reattach probe failed for ${run.runKey}:`, e);
            return null;
          });
          if (abandonStoppedRecovery(run)) {
            await reattached?.cancelDetachedTurn();
            cancelRecoveredEngine(run);
            return;
          }
          if (run.osSessionId)
            transitionRunState(
              run.osSessionId,
              reattached ? "reattach_ok" : "reattach_fail",
              { run_key: run.runKey },
            );
          if (reattached) {
            Object.assign(run, journalMarkRecoveryAttached(run) || {});
            attachedRecoveryRunKeys.add(run.runKey);
            // This turn executes on a detached server: following it costs
            // this process nothing, so it must not hold a bounded recovery
            // slot. Holding one is what starved every interrupted run past
            // the fourth until the queue-wait timer fired (2026-08-16).
            releaseQueueSlot();
            console.log(
              `[runner] Reattached ${run.kind || "run"} ${run.osSessionId || run.runKey} to its live engine turn (server ${run.serverKey})`
            );
            for await (const event of reattached) {
              if (abandonStoppedRecovery(run)) return;
              if (recoveredResultNeedsContinuation(event)) {
                repairingRecoveredResult = true;
                console.warn(
                  `[runner] Reattached turn ${run.runKey} ended without a usable final answer — continuing once`
                );
                continue;
              }
              if (event.type === "error" && isTransientRunError(event.content)) {
                repairingRecoveredResult = true;
                console.warn(
                  `[runner] Reattached turn ${run.runKey} hit a transient engine failure — continuing through the normal retry/fallback path`
                );
                continue;
              }
              if (event.type === "done" || event.type === "error") {
                recoverySettled = settleRecovery(run, event) || recoverySettled;
              } else emitRecoveryEvent(run, event);
            }
            if (abandonStoppedRecovery(run)) return;
            if (!repairingRecoveredResult && recoverySettled) return;
            if (!repairingRecoveredResult) {
              repairingRecoveredResult = true;
              console.warn(
                `[runner] Reattached turn ${run.runKey} ended without a terminal event — continuing once`
              );
            }
          }
        }
        console.log(
          repairingRecoveredResult
            ? `[runner] Repairing recovered result for ${run.osSessionId || run.runKey}`
            : `[runner] Resuming interrupted ${run.kind || "run"} ${run.osSessionId || run.runKey} (started ${run.startedAt}, model ${run.model || "default"})`
        );
        if (run.osSessionId && !repairingRecoveredResult)
          transitionRunState(run.osSessionId, "resume_reprompt", { run_key: run.runKey });
        if (abandonStoppedRecovery(run)) return;
        // The continuation run journals under its own runKey — drop the
        // claimed record only now, AFTER the reattach probe settled: dying
        // mid-probe used to lose the run to the wipe-on-take (2026-07-27).
        journalClear(run.runKey);
        for await (const event of runAgent({
          prompt: repairingRecoveredResult
            ? recoveredResultContinuationPrompt(run.prompt)
            : resumeContinuationPrompt(run.prompt),
          sessionId: run.claudeSessionId,
          cwd: run.cwd,
          mode: run.mode,
          model: run.model,
          selectedModel: run.selectedModel,
          transientFallback: run.transientFallback,
          effort: run.effort,
          fastMode: run.fastMode,
          mcpServers: run.mcpServers ?? "all",
          inProcessMcp: run.osSessionId
            ? inProcessMcpFor?.(run.osSessionId, run.user)
            : undefined,
          reposNote: run.osSessionId ? reposNoteFor?.(run.osSessionId) : undefined,
          user: run.user,
          deniedTools: run.deniedTools,
          confirmTools: run.confirmTools,
          aws: run.aws,
          claudeCliEnv: run.claudeCliEnv,
          codexCliEnv: run.codexCliEnv,
          fallbackModel: run.fallbackModel,
          accountId: run.accountId,
          accountStrict: run.accountStrict,
          usageCredits: run.usageCredits,
          prReviewer: run.prReviewer,
          journal: {
            osSessionId: run.osSessionId,
            kind: recoveryKind(run.kind, "resume"),
            firstJournaledAt: run.firstJournaledAt,
            resumeAttempts: run.resumeAttempts,
            lastResumeAt: run.lastResumeAt,
          },
          onAskUser: run.osSessionId ? askHandlerFor?.(run.osSessionId) : undefined,
        })) {
          if (abandonStoppedRecovery(run)) return;
          if (event.type === "done" || event.type === "error") {
            recoverySettled = settleRecovery(run, event) || recoverySettled;
          } else emitRecoveryEvent(run, event);
        }
        if (abandonStoppedRecovery(run)) return;
        if (!recoverySettled)
          reportRecoveryFailure(
            run,
            "Restart recovery ended before the interrupted turn returned a final result. Send the prompt again to continue.",
          );
      } catch (e) {
        console.error(`[runner] Resume failed for ${run.runKey}:`, e);
        if (abandonStoppedRecovery(run)) return;
        if (!recoverySettled)
          reportRecoveryFailure(
            run,
            "Restart recovery failed while continuing the interrupted turn. Send the prompt again to continue.",
          );
      }
    }));
  }

  // A discarded duplicate can still be modifying the same worktree. Finish
  // every best-effort detached abort before any kept recovery reattaches or
  // starts a continuation, so this boot never drives both at once.
  void Promise.all(quarantineAborts).then(() => runRecoveryQueue(recoveryTasks));

  return resumed;
}

export const MAX_BOOT_RECOVERIES = 32;
export const BOOT_RECOVERY_CONCURRENCY = 4;
// How long a recovery may wait for a queue slot before it is started anyway,
// outside the queue. Long enough that a busy restart drains its legitimate
// work first; bounded because the alternative — waiting forever — leaves a
// live engine turn nobody is following. It is deliberately NOT a deadline
// after which the run is declared dead: the engine is still executing.
export let BOOT_RECOVERY_QUEUE_WAIT_MS = 10 * 60 * 1000;

/** Test seam: shorten the queue wait so the promotion path is observable
 *  without a ten-minute test. Returns the previous value. */
export function __setRecoveryQueueWaitMsForTest(ms: number): number {
  const prev = BOOT_RECOVERY_QUEUE_WAIT_MS;
  BOOT_RECOVERY_QUEUE_WAIT_MS = ms;
  return prev;
}
export const MAX_BOOT_RESUME_ATTEMPTS = 2;
export const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;

/** Collapse recovery suffixes so a crash during recovery never grows
 * `prompt-resume-resume` (or recursively wraps the same continuation forever). */
export function recoveryKind(kind: string | undefined, suffix: "resume" | "rerun"): string {
  const base = (kind || "run").replace(/(?:(?:-resume|-rerun))+$/g, "");
  return `${base}-${suffix}`;
}

/** One boot recovery per owning session, newest journal record wins. Records
 * without a session id remain independently recoverable by run key. A hard
 * fuse prevents a malformed journal from monopolizing boot and starving HTTP. */
export function sanitizeInterruptedRuns(runs: ActiveRunRecord[], now = Date.now()): {
  interrupted: ActiveRunRecord[];
  quarantined: QuarantinedRun[];
} {
  const newest = new Map<string, ActiveRunRecord>();
  const quarantined: QuarantinedRun[] = [];
  for (const run of runs) {
    const recoverySuffixes = run.kind?.match(/-(?:resume|rerun)/g)?.length ?? 0;
    if (recoverySuffixes > 1) {
      quarantined.push({ run, reason: "recursive_recovery_kind", notify: true });
      continue;
    }
    const resumeAttempts = run.resumeAttempts ?? recoverySuffixes;
    if (resumeAttempts >= MAX_BOOT_RESUME_ATTEMPTS) {
      quarantined.push({ run, reason: "resume_attempts_exhausted", notify: true });
      continue;
    }
    const firstJournaled = Date.parse(run.firstJournaledAt || run.startedAt || "");
    if (!Number.isFinite(firstJournaled) || now - firstJournaled > MAX_RECOVERY_AGE_MS) {
      quarantined.push({ run, reason: "recovery_expired", notify: true });
      continue;
    }
    const key = run.osSessionId ? `session:${run.osSessionId}` : `run:${run.runKey}`;
    const prior = newest.get(key);
    if (!prior) {
      newest.set(key, run);
      continue;
    }
    const priorAt = Date.parse(prior.startedAt || "") || 0;
    const runAt = Date.parse(run.startedAt || "") || 0;
    if (runAt >= priorAt) {
      quarantined.push({ run: prior, reason: "duplicate_session", notify: false });
      newest.set(key, run);
    } else {
      quarantined.push({ run, reason: "duplicate_session", notify: false });
    }
  }
  const ordered = [...newest.values()].sort(
    (a, b) => (Date.parse(b.startedAt || "") || 0) - (Date.parse(a.startedAt || "") || 0),
  );
  const interrupted = ordered.slice(0, MAX_BOOT_RECOVERIES);
  quarantined.push(
    ...ordered.slice(MAX_BOOT_RECOVERIES).map((run) => ({
      run,
      reason: "boot_recovery_limit" as const,
      notify: true,
    })),
  );
  // A rejected stale record must not settle a session whose valid record will
  // still recover. When no valid record remains, notify once for the newest
  // rejected record instead of writing multiple terminal outcomes.
  const recoveringSessions = new Set(
    interrupted.flatMap((run) => (run.osSessionId ? [run.osSessionId] : [])),
  );
  const newestRejectedBySession = new Map<string, QuarantinedRun>();
  for (const entry of quarantined) {
    const sessionId = entry.run.osSessionId;
    if (!entry.notify || !sessionId) continue;
    if (recoveringSessions.has(sessionId)) {
      entry.notify = false;
      continue;
    }
    const prior = newestRejectedBySession.get(sessionId);
    const priorAt = Date.parse(prior?.run.startedAt || "") || 0;
    const entryAt = Date.parse(entry.run.startedAt || "") || 0;
    if (!prior || entryAt >= priorAt) {
      if (prior) prior.notify = false;
      newestRejectedBySession.set(sessionId, entry);
    } else {
      entry.notify = false;
    }
  }
  if (quarantined.length) {
    console.warn(
      `[runner] Restart recovery kept ${interrupted.length} unique run(s), quarantined ${quarantined.length} duplicate/unsafe/excess record(s)`,
    );
  }
  return { interrupted, quarantined };
}

function recoveryQuarantineMessage(entry: QuarantinedRun): string {
  const reason =
    entry.reason === "resume_attempts_exhausted"
      ? `it already used ${entry.run.resumeAttempts ?? MAX_BOOT_RESUME_ATTEMPTS} restart recovery attempts`
      : entry.reason === "recovery_expired"
        ? "its durable journal lineage is older than 24 hours"
        : entry.reason === "boot_recovery_limit"
          ? `the boot recovery safety limit is ${MAX_BOOT_RECOVERIES} runs`
          : "its recovery lineage was recursively re-journaled";
  return `Restart recovery was stopped safely because ${reason}. The record was moved to the run-journal quarantine for inspection; send the prompt again to continue.`;
}

export async function runRecoveryQueue(tasks: Array<() => Promise<void>>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        await task();
      } catch (error) {
        // A task normally reports and settles its own error. This guard keeps
        // a defensive exception from stopping the worker and starving every
        // remaining claimed recovery behind it.
        console.error("[runner] Recovery queue task failed:", error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BOOT_RECOVERY_CONCURRENCY, tasks.length) }, worker),
  );
}

/** Same continuation prompt resumeInterruptedRuns uses — exported so the
 *  graceful-shutdown snapshot path can wake sessions that finished their turn
 *  during the drain (and so were cleared from the journal) with one consistent
 *  message. */
// Note: personaName() is read at module load (a persona rename needs a restart
// to reach this string — fine, runner internals need one anyway).
export const RESUME_CONTINUATION_PROMPT =
  `This session was interrupted by a ${personaName()} service restart mid-run. ` +
  "Review what you had already done, pick up where you left off, and finish the task. " +
  "If the work was actually complete, just post the final summary/answer.";

/**
 * Meridian can very occasionally close a post-restart turn with either no
 * final text or its internal tool-result envelope as assistant text (the
 * observed shape starts `[your bash …]:`) while still reporting a successful
 * `finish: stop`. Accepting either strands partial work without a conclusion.
 * Keep this deliberately narrow and bounded to one repair continuation.
 * The envelope shape lives in runner-shared (TOOL_RESULT_ENVELOPE_RE) and
 * covers any tool id — MCP tools included — not just the builtin set.
 */
export function recoveredResultNeedsContinuation(event: StreamEvent): boolean {
  if (event.type !== "done") return false;
  if (!event.result?.trim() || event.result === EMPTY_COMPLETION_RESULT) return true;
  return TOOL_RESULT_ENVELOPE_RE.test(event.result || "");
}

/** RESUME_CONTINUATION_PROMPT anchored to the interrupted turn's original
 *  prompt. A resume can land in a fresh engine session with no history (e.g.
 *  reattach failed and the re-prompt rotated to another account's server) —
 *  without an anchor the model reconstructs its task from repository state
 *  and can guess wrong (2026-07-24: an amnesiac ask session found its shared
 *  checkout on a teammate's PR branch and re-did that PR's review). */
export function resumeContinuationPrompt(originalPrompt?: string | null): string {
  const p = (originalPrompt || "").trim();
  if (!p) return RESUME_CONTINUATION_PROMPT;
  // A crash during a recovery journals the continuation prompt. Reusing it
  // verbatim prevents restart text nesting inside itself on every boot.
  if (p.startsWith(RESUME_CONTINUATION_PROMPT)) return p;
  const clamped = p.length > 2000 ? `${p.slice(0, 2000)}…` : p;
  return (
    `${RESUME_CONTINUATION_PROMPT}\n\n` +
    `For context, the prompt that started the interrupted turn was:\n` +
    `"""\n${clamped}\n"""\n` +
    "If you no longer see the earlier conversation, treat that prompt as the task " +
    "definition — do not infer the task from repository or checkout state."
  );
}

function recoveredResultContinuationPrompt(originalPrompt?: string | null): string {
  const p = (originalPrompt || "").trim();
  const clamped = p.length > 2000 ? `${p.slice(0, 2000)}…` : p;
  return (
    "Your reattached turn ended without giving the user a usable final answer. " +
    "Review the work already completed in this session, finish anything still needed, and provide the actual concise answer or handoff now. " +
    "Do not merely repeat the last tool output." +
    (clamped
      ? `\n\nThe prompt that started the interrupted turn was:\n"""\n${clamped}\n"""`
      : "")
  );
}
