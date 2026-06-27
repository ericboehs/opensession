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
} from "./claude-runner";
import { runCodex, isCodexSessionBusy, cancelCodexRun, activeCodexRunCount } from "./codex-runner";
import { providerFor, resolveModel, DEFAULT_CODEX_MODEL, getDefaultModel } from "./models";
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
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  aws?: boolean;
  /** Git identity for commits this run makes, attributing them to the prompt's author. */
  author?: GitIdentity | null;
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
      deniedTools: opts.deniedTools,
      confirmTools: opts.confirmTools,
      journal: opts.journal,
      author: opts.author,
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

/** Busy check across both backends (pass any engine/backstage session id). */
export function isAgentSessionBusy(...ids: Array<string | null | undefined>): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (isSessionBusy(id) || isCodexSessionBusy(id)) return true;
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
    if (id && steerRun(id, text)) return true;
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
    if (id && interruptAndSteerRun(id, text)) return true;
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
  }
  return cancelled;
}

/**
 * Resume runs that a previous process left in-flight (service restart or
 * crash). Each resumable run gets a continuation prompt against its engine
 * session, on whichever backend the journaled model belongs to.
 */
export function resumeInterruptedRuns(onResumed?: (bksSessionId?: string) => void): number {
  const interrupted = takeInterruptedRuns();
  let resumed = 0;

  for (const run of interrupted) {
    // The github agent owns its own recovery (review/simplify re-trigger on the
    // next PR event; auto-fix loops are resumed by the github agent's startup
    // sweep). Resuming them generically would double-drive an auto-fix loop.
    if (run.kind?.startsWith("github-")) {
      continue;
    }
    if (!run.claudeSessionId) {
      console.warn(
        `[runner] Interrupted run ${run.runKey} (${run.kind || "unknown"}) had no engine session yet — cannot resume`
      );
      continue;
    }
    resumed++;
    console.log(
      `[runner] Resuming interrupted ${run.kind || "run"} ${run.bksSessionId || run.runKey} (started ${run.startedAt}, model ${run.model || "default"})`
    );
    void (async () => {
      try {
        for await (const event of runAgent({
          prompt:
            "This session was interrupted by a Michael service restart mid-run. " +
            "Review what you had already done, pick up where you left off, and finish the task. " +
            "If the work was actually complete, just post the final summary/answer.",
          sessionId: run.claudeSessionId,
          cwd: run.cwd,
          mode: run.mode,
          model: run.model,
          mcpServers: run.mcpServers,
          deniedTools: run.deniedTools,
          aws: run.aws,
          journal: { bksSessionId: run.bksSessionId, kind: `${run.kind || "run"}-resume` },
        })) {
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
