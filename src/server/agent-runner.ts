/**
 * Agent runner dispatcher: one entry point for "run a prompt in a session".
 * Everything executes on the opencode engine — native model ids (claude-*,
 * gpt-*) are mapped onto their opencode/<provider>/<model> form at dispatch;
 * the runner emits the shared StreamEvent shape.
 *
 * Note on session ids: `sessionId` is the engine session id (an opencode
 * session id; the field names claudeSessionId/codexThreadId survive in
 * session state for on-disk compat with pre-single-engine sessions).
 */

import { takeInterruptedRuns } from "./run-journal";
import type { StreamEvent, ImageInput } from "./run-events";
import {
  runOpencode,
  isOpencodeSessionBusy,
  cancelOpencodeRun,
  activeOpencodeRunCount,
  activeDetachedOpencodeRunCount,
  tryReattachOpencodeRun,
  steerOpencodeRun,
} from "./opencode-runner";
import {
  providerFor,
  nextFallbackModel,
  modelLabel,
  BEST_AVAILABLE_CODEX_MODEL,
  getDefaultModel,
  resolveConcreteModel,
  resolveModel,
  toOpencodeModel,
} from "./models";
import { isTransientRunError } from "./runner-shared";
import {
  hostRunBusy,
  hostSteer,
  hostInterruptSteer,
  hostCancel,
} from "./host-registry";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { personaName } from "./config";
import { wrapContext } from "./prompt-context";
import { readEngineTranscript } from "./sessions";
import type { GitIdentity } from "./shared/user-mappings";
import type { TranscriptEntry } from "./types";

export type { StreamEvent };

export interface RunAgentOpts {
  prompt: string;
  /** Engine session id to resume (claude session id or codex thread id). */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  /** Model id; decides the backend. Omitted = default Claude model. */
  model?: string;
  /**
   * Reasoning effort for this run (UI scale: low | medium | high). Each runner
   * normalizes it onto its own scale (Claude: low..max, Codex: minimal..xhigh);
   * unset = the backend's default.
   */
  effort?: string;
  mcpServers?: string[];
  /**
   * In-process SDK MCP servers (opensession-sessions / opensession-admin) for trusted
   * interactive runs only — never automations. Claude receives them directly;
   * Codex receives stdio proxy configs that forward to the same in-process
   * servers through Backstage's run RPC socket.
   */
  inProcessMcp?: Record<string, unknown>;
  /**
   * System-prompt note describing the session's repos (primary + attached) and
   * their worktree paths, so the agent works in the right isolated checkout for
   * cross-repo sessions. Claude receives it as system context; Codex via the
   * developer_instructions config channel.
   */
  reposNote?: string;
  /** Images attached to the opening message. */
  images?: ImageInput[];
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
  /** Git identity for commits this run makes, attributing them to the prompt's author. */
  author?: GitIdentity | null;
  /**
   * The run's user (prompt author / UI user). Gates per-user MCP servers
   * (mcp-config.json `allowedUsers`) — e.g. `brex` is limited to Michiel + Grant.
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
  /**
   * Pinned Claude subscription (claude-accounts id) for this session. Flows to
   * runClaude, which prefers it and falls back to the pool on exhaustion.
   * Claude only — Codex has its own account pool. Journaled for resume.
   */
  accountId?: string;
  /**
   * Hard accountId pin (automation cost cap): the run only ever uses that
   * account — an exhausted pin kills the run with usageLimitExhausted so the
   * fallback-model chain takes over instead of the shared pool. Claude only.
   */
  accountStrict?: boolean;
  /**
   * Allow runs to keep going on accounts billing usage-credits past their
   * subscription limits (extra usage enabled with credit headroom). Off =
   * never intentionally spend paid credits. Claude only.
   */
  usageCredits?: boolean;
  journal?: { bksSessionId?: string; kind?: string };
  onAskUser?: (input: Record<string, unknown>) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >;
}

function runOnModel(opts: RunAgentOpts, model: string | undefined): AsyncGenerator<StreamEvent> {
  // Single engine: map native ids (claude-*, gpt-*, codex-best-available)
  // onto their opencode form; explicit opencode/<provider>/<model> ids pass
  // through. Anything that still doesn't parse as an opencode id gets the
  // runner's clear error (e.g. anthropic bridge disabled).
  const requested = model || getDefaultModel();
  const mapped = toOpencodeModel(requested) || requested;
  return runOpencode(opts, mapped);
}

export async function* runAgent(opts: RunAgentOpts): AsyncGenerator<StreamEvent> {
  const requestedModel = resolveModel(opts.model || getDefaultModel());
  const wantsBestCodex = requestedModel?.id === BEST_AVAILABLE_CODEX_MODEL;
  const primaryModel = resolveConcreteModel(opts.model);
  const preferredFallback = wantsBestCodex
    ? BEST_AVAILABLE_CODEX_MODEL
    : opts.fallbackModel;
  // No fallback configured (interactive auto-switch off, or an automation with
  // fallbackModel:"none") ⇒ run the primary and surface whatever it does.
  if (!preferredFallback || preferredFallback === "none") {
    yield* runOnModel(opts, primaryModel);
    return;
  }

  let currentOpts = opts;
  let currentModel = primaryModel;
  const exhaustedModels = new Set<string>();

  for (;;) {
    let sawInit = false;
    let currentEngineId = currentOpts.sessionId;
    // Why this turn ended, if it did: a usage cap (pool drained) or a transient
    // infra failure. Both route into the fallback graph so the session keeps
    // going instead of dead-ending on the error — the "continue without
    // failing" goal.
    let failure: { transient: boolean; content?: string } | null = null;

    for await (const event of runOnModel(currentOpts, currentModel)) {
      if (event.type === "init") {
        sawInit = true;
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

    if (!failure) return;

    const currentOc = toOpencodeModel(currentModel) || currentModel;
    exhaustedModels.add(currentOc);
    const hop = nextFallbackModel(currentOc, exhaustedModels, preferredFallback);
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

    // Downgrade to a dumber model (Fable→Opus, Opus→Sonnet, Sol→Opus): a human
    // decides. Interactive runs get an AskUserQuestion; headless runs
    // (automations, workflow sub-agents, restart resumes without an ask handler)
    // auto-proceed — stalling them would defeat "continue without failing".
    if (hop.mode === "ask") {
      const approved = await askFallbackApproval(
        opts.onAskUser,
        currentModel,
        hop.id,
        failure.transient
      );
      if (!approved) {
        yield {
          type: "error",
          content:
            `${modelLabel(currentModel)} is out of usage. ` +
            `Declined the fallback to ${modelLabel(hop.id)} — use /model to switch when ready.`,
          provider: providerFor(currentModel),
          model: currentModel,
          usageLimitExhausted: true,
        };
        return;
      }
    }

    // Everything runs on the opencode engine, so `providerFor` reports
    // "opencode" for both sides and can't tell a same-family switch from a
    // cross-family one. The decision that matters — resume the partial session
    // vs. start fresh with a handoff — turns on the UNDERLYING provider
    // (anthropic ↔ openai): same family resumes the opencode session; a family
    // switch needs a fresh session seeded with the prior transcript.
    const fromFamily = engineFamily(currentOc);
    const toFamily = engineFamily(hop.id);
    const crossProvider = fromFamily !== toFamily;
    const reason = failure.transient ? "hit a transient failure" : "is out of usage on all accounts";
    console.warn(
      `[runner] ${currentModel} ${reason}; falling back to ${hop.id} (${hop.mode})`
    );
    // Structured cue: interactive sessions turn this into a durable model-switch
    // divider + model pill update (backstage.ts run loop). Other consumers ignore
    // it and rely on the human-readable text line below.
    yield { type: "model_switch", fromModel: currentModel, toModel: hop.id };
    yield {
      type: "text_chunk",
      text: `\n\n[runner] ${modelLabel(currentModel)} ${reason}; falling back to ${modelLabel(hop.id)}.\n\n`,
    };

    let prompt = currentOpts.prompt;
    let handoffEntries: TranscriptEntry[] = [];
    if (sawInit && crossProvider) {
      // The engine session is always an opencode session id, so read the prior
      // turn from OpenCode's store regardless of which model family produced it.
      const entries = currentEngineId
        ? readEngineTranscript(currentOpts.cwd, currentEngineId, "opencode")
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
            })
          )}\n\n${prompt}`;
      } else {
        prompt +=
          "\n\n[Note: a previous attempt on another model was cut short and may have " +
          "left partial work in this directory — review what's already done before continuing.]";
      }
    }

    currentOpts = {
      ...currentOpts,
      prompt,
      // Same family can resume the partial session; a family switch starts fresh
      sessionId: crossProvider ? undefined : currentEngineId,
      // The fresh opencode session is seeded with the history the handoff covers.
      seedTranscriptEntries:
        crossProvider && handoffEntries.length ? handoffEntries : undefined,
      journal: opts.journal
        ? { ...opts.journal, kind: `${opts.journal.kind || "run"}-fallback` }
        : undefined,
    };
    currentModel = hop.id;
  }
}

/** Underlying engine provider family of a model id ("anthropic" / "openai"),
 *  read from its opencode mapping. Drives resume-vs-fresh on a fallback hop. */
export function engineFamily(model: string): string {
  const oc = toOpencodeModel(model) || model;
  return oc.match(/^opencode\/([^/]+)\//)?.[1] || providerFor(model);
}

/** Map an engine family to the handoff note's provider label. */
function familyLabel(family: string): "claude" | "codex" | "opencode" {
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
const pendingStarts: Set<string> = ((globalThis as any).__pendingSessionStarts ??=
  new Set());

/** Mark a session as starting a run (call synchronously, before any await). */
export function markSessionStarting(id: string): void {
  pendingStarts.add(id);
}

/** Clear a starting mark (call in a `finally` once the run has ended). */
export function unmarkSessionStarting(id: string): void {
  pendingStarts.delete(id);
}

/** Busy check (pass any engine/backstage session id). */
export function isAgentSessionBusy(...ids: Array<string | null | undefined>): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (pendingStarts.has(id) || isOpencodeSessionBusy(id) || hostRunBusy(id))
      return true;
  }
  return false;
}

/**
 * How many runs this process is actively driving. Used by graceful shutdown
 * to wait for in-flight work to reach a stopping point before exiting. (Does
 * not count external CLI/tmux runs — we can't drain those.)
 */
export function activeAgentRunCount(): number {
  return activeOpencodeRunCount();
}

/** Of those, how many execute on a DETACHED engine server that survives a
 *  restart — the graceful-shutdown drain skips waiting on these (boot
 *  reattaches them via the journal instead). */
export function activeDetachedAgentRunCount(): number {
  return activeDetachedOpencodeRunCount();
}

/**
 * Steer a message into an in-flight run. Opencode runs steer in-band since
 * 2026-07-12 (steerOpencodeRun: a noReply history append the running turn
 * picks up at its next step boundary — Claude-SDK-steer semantics);
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
    if (hostCancel(id)) cancelled = true;
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
  onResumed?: (bksSessionId?: string) => void,
  askHandlerFor?: (bksSessionId: string) => AskHandler | undefined,
  inProcessMcpFor?: (bksSessionId: string, user?: string) => Record<string, unknown> | undefined,
  reposNoteFor?: (bksSessionId: string) => string | undefined,
  onEvent?: (bksSessionId: string, event: StreamEvent) => void,
): string[] {
  const interrupted = takeInterruptedRuns();
  const resumed: string[] = [];

  for (const run of interrupted) {
    // The github agent owns its own recovery (review/simplify re-trigger on the
    // next PR event; auto-fix loops are resumed by the github agent's startup
    // sweep). Resuming them generically would double-drive an auto-fix loop.
    if (run.kind?.startsWith("github-")) {
      continue;
    }
    // Slack runs journal (their bks session id feeds the in-process MCP proxy
    // path), but the Slack queue re-delivers interrupted messages itself — a
    // generic resume would double-drive the turn with no streamer attached.
    if (run.kind?.startsWith("slack")) {
      continue;
    }
    // Workflow fan-out agents ("workflow", plus -resume/-rerun suffixes): the
    // orchestration state (the script's Worker) died with the process — the
    // workflow store marks the run interrupted on boot, and replaying a lone
    // child agent without its script would be noise.
    if (run.kind?.startsWith("workflow")) {
      continue;
    }
    // Sandboxed runs (docs/sandboxes-plan.md Phases 1+3): the sandbox — and
    // often the in-sandbox run host itself — outlives a backstage restart.
    // Reattach/relaunch through the provider instead of running in-process;
    // the sandbox modules are imported lazily so these paths stay completely
    // out of processes that never touch them.
    if (
      run.sandboxId &&
      (run.sandboxProvider === "docker" ||
        run.sandboxProvider === "daytona" ||
        run.sandboxProvider === "e2b" ||
        run.sandboxProvider === "box")
    ) {
      const isDocker = run.sandboxProvider === "docker";
      if (run.bksSessionId) resumed.push(run.bksSessionId);
      void (async () => {
        try {
          const resume = isDocker
            ? (await import("./sandbox/docker")).resumeDockerSandboxRun
            : (await import("./sandbox/adapters/bootstrap")).resumeRemoteSandboxRun;
          const events = await resume(run, {
            onAskUser: run.bksSessionId ? askHandlerFor?.(run.bksSessionId) : undefined,
          });
          if (!events) {
            console.warn(
              `[runner] Sandbox ${run.sandboxId} for interrupted run ${run.runKey} is gone — the session's next prompt recreates it`
            );
            onResumed?.(run.bksSessionId);
            return;
          }
          for await (const event of events) {
            if (run.bksSessionId) onEvent?.(run.bksSessionId, event);
            if (event.type === "done" || event.type === "error") {
              onResumed?.(run.bksSessionId);
            }
          }
        } catch (e) {
          console.error(`[runner] Sandbox resume failed for ${run.runKey}:`, e);
        }
      })();
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
        continue;
      }
      if (run.bksSessionId) resumed.push(run.bksSessionId);
      console.log(
        `[runner] Re-running interrupted ${run.kind || "run"} ${run.bksSessionId || run.runKey} from scratch (never got an engine session)`
      );
      void (async () => {
        try {
          for await (const event of runAgent({
            prompt: run.prompt!,
            cwd: run.cwd,
            mode: run.mode,
            model: run.model,
            effort: run.effort,
            mcpServers: run.mcpServers,
            inProcessMcp: run.bksSessionId
              ? inProcessMcpFor?.(run.bksSessionId, run.user)
              : undefined,
            reposNote: run.bksSessionId ? reposNoteFor?.(run.bksSessionId) : undefined,
            user: run.user,
            deniedTools: run.deniedTools,
            confirmTools: run.confirmTools,
            aws: run.aws,
            fallbackModel: run.fallbackModel,
            accountId: run.accountId,
            accountStrict: run.accountStrict,
            usageCredits: run.usageCredits,
            journal: { bksSessionId: run.bksSessionId, kind: `${run.kind || "run"}-rerun` },
            onAskUser: run.bksSessionId ? askHandlerFor?.(run.bksSessionId) : undefined,
          })) {
            if (run.bksSessionId) onEvent?.(run.bksSessionId, event);
            if (event.type === "done" || event.type === "error") {
              onResumed?.(run.bksSessionId);
            }
          }
        } catch (e) {
          console.error(`[runner] Re-run failed for ${run.runKey}:`, e);
        }
      })();
      continue;
    }
    if (run.bksSessionId) resumed.push(run.bksSessionId);
    void (async () => {
      try {
        // First choice: REATTACH — the run's detached `opencode serve`
        // survived the restart and the turn may still be executing. The
        // adopted-pool lookup + session probe live in tryReattachOpencodeRun;
        // null means the server is gone (or was a direct child) and we fall
        // back to the classic continuation re-prompt below.
        if (run.serverKey) {
          const reattached = await tryReattachOpencodeRun(run, {
            onAskUser: run.bksSessionId ? askHandlerFor?.(run.bksSessionId) : undefined,
          }).catch((e) => {
            console.warn(`[runner] Reattach probe failed for ${run.runKey}:`, e);
            return null;
          });
          if (reattached) {
            console.log(
              `[runner] Reattached ${run.kind || "run"} ${run.bksSessionId || run.runKey} to its live engine turn (server ${run.serverKey})`
            );
            for await (const event of reattached) {
              if (run.bksSessionId) onEvent?.(run.bksSessionId, event);
              if (event.type === "done" || event.type === "error") {
                onResumed?.(run.bksSessionId);
              }
            }
            return;
          }
        }
        console.log(
          `[runner] Resuming interrupted ${run.kind || "run"} ${run.bksSessionId || run.runKey} (started ${run.startedAt}, model ${run.model || "default"})`
        );
        for await (const event of runAgent({
          prompt: RESUME_CONTINUATION_PROMPT,
          sessionId: run.claudeSessionId,
          cwd: run.cwd,
          mode: run.mode,
          model: run.model,
          effort: run.effort,
          mcpServers: run.mcpServers,
          inProcessMcp: run.bksSessionId
            ? inProcessMcpFor?.(run.bksSessionId, run.user)
            : undefined,
          reposNote: run.bksSessionId ? reposNoteFor?.(run.bksSessionId) : undefined,
          user: run.user,
          deniedTools: run.deniedTools,
          confirmTools: run.confirmTools,
          aws: run.aws,
          fallbackModel: run.fallbackModel,
          accountId: run.accountId,
          accountStrict: run.accountStrict,
          usageCredits: run.usageCredits,
          journal: { bksSessionId: run.bksSessionId, kind: `${run.kind || "run"}-resume` },
          onAskUser: run.bksSessionId ? askHandlerFor?.(run.bksSessionId) : undefined,
        })) {
          if (run.bksSessionId) onEvent?.(run.bksSessionId, event);
          if (event.type === "done" || event.type === "error") {
            onResumed?.(run.bksSessionId);
          }
        }
      } catch (e) {
        console.error(`[runner] Resume failed for ${run.runKey}:`, e);
      }
    })();
  }

  return resumed;
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
