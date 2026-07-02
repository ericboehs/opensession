/**
 * Agent runner dispatcher: one entry point for "run a prompt in a session",
 * routed by the session's model — Claude models go through the Claude Agent
 * SDK runner, GPT/Codex models through the Codex SDK runner. Both emit the
 * same StreamEvent shape.
 *
 * Note on session ids: `sessionId` is the engine session id — a Claude
 * session id for claude models, a Codex thread id for codex models. Callers
 * keep the two separately (claudeSessionId vs codexThreadId) so switching
 * models mid-session keeps both histories resumable.
 */

import {
  runClaude,
  isSessionBusy,
  cancelRun,
  steerRun,
  interruptAndSteerRun,
  takeInterruptedRuns,
  activeRunCount,
  type StreamEvent,
  type ImageInput,
} from "./claude-runner";
import { runCodex, isCodexSessionBusy, cancelCodexRun, activeCodexRunCount } from "./codex-runner";
import { providerFor, resolveModel, DEFAULT_CODEX_MODEL, getDefaultModel } from "./models";
import {
  hostRunBusy,
  hostSteer,
  hostInterruptSteer,
  hostCancel,
} from "./host-registry";
import type { GitIdentity } from "./shared/user-mappings";

export type { StreamEvent };

export interface RunAgentOpts {
  prompt: string;
  /** Engine session id to resume (claude session id or codex thread id). */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  /** Model id; decides the backend. Omitted = default Claude model. */
  model?: string;
  mcpServers?: string[];
  /**
   * In-process SDK MCP servers (michael-sessions / michael-admin) for trusted
   * interactive runs only — never automations. Claude receives them directly;
   * Codex receives stdio proxy configs that forward to the same in-process
   * servers through Backstage's run RPC socket.
   */
  inProcessMcp?: Record<string, unknown>;
  /**
   * System-prompt note describing the session's repos (primary + attached) and
   * their worktree paths, so the agent works in the right isolated checkout for
   * cross-repo sessions. Claude receives it as system context; Codex receives it
   * prepended to the prompt because the SDK has no system-prompt hook.
   */
  reposNote?: string;
  /** Images attached to the opening message. */
  images?: ImageInput[];
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
   * Cross-provider fallback starts a fresh engine session: conversation
   * history doesn't carry over, but the cwd/worktree state does.
   */
  fallbackModel?: string;
  journal?: { bksSessionId?: string; kind?: string };
  onAskUser?: (input: Record<string, unknown>) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >;
}

function runOnModel(opts: RunAgentOpts, model: string | undefined): AsyncGenerator<StreamEvent> {
  if (providerFor(model) === "codex") {
    return runCodex({
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mode: opts.mode,
      model: model || DEFAULT_CODEX_MODEL,
      mcpServers: opts.mcpServers,
      images: opts.images,
      reposNote: opts.reposNote,
      inProcessMcp: opts.inProcessMcp,
      deniedTools: opts.deniedTools,
      confirmTools: opts.confirmTools,
      fallbackModel: opts.fallbackModel,
      journal: opts.journal,
      author: opts.author,
      user: opts.user,
    });
  }
  return runClaude({ ...opts, model });
}

export async function* runAgent(opts: RunAgentOpts): AsyncGenerator<StreamEvent> {
  const fallback = opts.fallbackModel ? resolveModel(opts.fallbackModel) : null;
  if (!fallback || fallback.id === (opts.model || getDefaultModel())) {
    yield* runOnModel(opts, opts.model);
    return;
  }

  let sawInit = false;
  let primaryEngineId = opts.sessionId;
  for await (const event of runOnModel(opts, opts.model)) {
    if (event.type === "init") {
      sawInit = true;
      primaryEngineId = event.sessionId || primaryEngineId;
    }
    const exhausted =
      (event.type === "done" || event.type === "error") && event.usageLimitExhausted;
    if (!exhausted) {
      yield event;
      continue;
    }

    // Primary model out of usage on every account — switch to the fallback.
    const crossProvider = providerFor(opts.model) !== fallback.provider;
    const primaryName = opts.model || getDefaultModel();
    console.warn(`[runner] ${primaryName} exhausted on all accounts; falling back to ${fallback.id}`);
    // Structured cue: interactive sessions turn this into a durable model-switch
    // divider + model pill update (backstage.ts run loop). Other consumers ignore
    // it and rely on the human-readable text line below.
    yield { type: "model_switch", fromModel: primaryName, toModel: fallback.id };
    yield {
      type: "text_chunk",
      text: `\n\n[runner] ${primaryName} usage exhausted on all accounts; falling back to ${fallback.id}.\n\n`,
    };

    let prompt = opts.prompt;
    if (sawInit && crossProvider) {
      prompt +=
        "\n\n[Note: a previous attempt on another model was cut short by usage limits and may have " +
        "left partial work in this directory — review what's already done before continuing.]";
    }

    yield* runOnModel(
      {
        ...opts,
        prompt,
        // Same provider can resume the partial session; cross-provider starts fresh
        sessionId: crossProvider ? undefined : primaryEngineId,
        journal: opts.journal
          ? { ...opts.journal, kind: `${opts.journal.kind || "run"}-fallback` }
          : undefined,
      },
      fallback.id
    );
    return;
  }
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

/** Busy check across both backends (pass any engine/backstage session id). */
export function isAgentSessionBusy(...ids: Array<string | null | undefined>): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (
      pendingStarts.has(id) ||
      isSessionBusy(id) ||
      isCodexSessionBusy(id) ||
      hostRunBusy(id)
    )
      return true;
  }
  return false;
}

/**
 * How many runs this process is actively driving across both backends. Used by
 * graceful shutdown to wait for in-flight work to reach a stopping point before
 * exiting. (Does not count external CLI/tmux runs — we can't drain those.)
 */
export function activeAgentRunCount(): number {
  return activeRunCount() + activeCodexRunCount();
}

/**
 * Steer a message into an in-flight Claude run (merged in at the next turn
 * boundary, same query). False = nothing steerable (codex runs, external
 * processes, or the run is finishing) — caller should queue instead.
 */
export function steerAgentRun(
  ids: Array<string | null | undefined>,
  text: string
): boolean {
  for (const id of ids) {
    if (id && (steerRun(id, text) || hostSteer(id, text))) return true;
  }
  return false;
}

/**
 * Esc-style redirect on an in-flight Claude run: abort the current turn but
 * keep the query alive, continuing immediately with the given message.
 * False = nothing interruptible — caller should fall back to steer/queue.
 */
export function interruptAndSteerAgentRun(
  ids: Array<string | null | undefined>,
  text: string
): boolean {
  for (const id of ids) {
    if (id && (interruptAndSteerRun(id, text) || hostInterruptSteer(id, text)))
      return true;
  }
  return false;
}

/** Cancel across both backends; returns true if anything was cancelled. */
export function cancelAgentRun(...ids: Array<string | null | undefined>): boolean {
  let cancelled = false;
  for (const id of ids) {
    if (!id) continue;
    if (cancelRun(id)) cancelled = true;
    if (cancelCodexRun(id)) cancelled = true;
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
    console.log(
      `[runner] Resuming interrupted ${run.kind || "run"} ${run.bksSessionId || run.runKey} (started ${run.startedAt}, model ${run.model || "default"})`
    );
    void (async () => {
      try {
        for await (const event of runAgent({
          prompt: RESUME_CONTINUATION_PROMPT,
          sessionId: run.claudeSessionId,
          cwd: run.cwd,
          mode: run.mode,
          model: run.model,
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
export const RESUME_CONTINUATION_PROMPT =
  "This session was interrupted by a Michael service restart mid-run. " +
  "Review what you had already done, pick up where you left off, and finish the task. " +
  "If the work was actually complete, just post the final summary/answer.";
