/**
 * Engine adapter contract (transcript-v2 design §7).
 *
 * Shaped on the REAL surface run-session.ts / agent-runner.ts consume from the
 * opencode runner today — not an aspirational abstraction:
 *
 *  - `startTurn(opts, model)` is one prompt turn as an async event stream. The
 *    stream keeps the runner's existing StreamEvent contract exactly: an
 *    `init` event carrying the engine session id, incremental
 *    text_chunk/tool_use/tool_result/usage_snapshot events, `model_switch` and
 *    `runner_notice` operational cues, and EXACTLY ONE terminal `done` or
 *    `error`. `usageLimitExhausted` on the terminal event (or on a pre-init
 *    error when the account pool is dry at pick time) is what drives
 *    agent-runner's fallback walk; `noticePersisted` on a terminal error tells
 *    consumers the adapter already wrote its own transcript notice. There is
 *    deliberately NO 'idle' event — turn boundaries are the terminal event.
 *  - Permission asks stay a BLOCKING `onAskUser` callback in the opts (never a
 *    stream event): the run parks mid-turn awaiting the human answer.
 *  - Control ops are id-keyed, and every id ALIAS a run registered under must
 *    work (run key, unified bks-/slack- session id, engine session id) —
 *    that's the opencode registry contract callers already rely on.
 *  - `reattach` is the restart-survival path: given a journaled run record
 *    whose engine server outlived the process, return a stream re-pumping the
 *    live turn, or null when the run can't be reattached (caller falls back to
 *    the continuation re-prompt).
 *
 * The direct-SDK engines export these as free functions rather than an
 * adapter object, and agent-runner.ts dispatches to them through a table of
 * export names. That table types itself off this interface and checks each
 * name against the adapter's real exports, so a renamed or missing control op
 * is a compile error there rather than an undefined that quietly downgrades a
 * steer to queueing or hides a live run from the shutdown drain.
 *
 * Types are reused via type-only imports from the existing modules
 * (run-events.ts is the runner's own event-type home; RunAgentOpts /
 * ActiveRunRecord from their owners) so an adapter is conformant by
 * construction — no parallel re-declarations to drift.
 */

import type { StreamEvent, ImageInput } from "../run-events";
import type { RunAgentOpts } from "../agent-runner";
import type { ActiveRunRecord } from "../run-journal";

export type { StreamEvent, ImageInput, RunAgentOpts, ActiveRunRecord };
export type { TurnUsage } from "../run-events";

/** The blocking permission-ask callback (AskUserQuestion et al.) — lives in
 *  opts, never in the event stream. Same shape as RunAgentOpts.onAskUser. */
export type EngineAskHandler = NonNullable<RunAgentOpts["onAskUser"]>;

export interface EngineAdapter {
  /** Stable adapter id, e.g. "opencode" / "pi". */
  readonly name: string;

  /**
   * Run one prompt turn. `model` is the caller-resolved model id (adapters
   * normalize their own prefixes, e.g. opencode/<provider>/<model>). The
   * returned stream follows the StreamEvent contract described in the module
   * doc; `opts.onAskUser` handles blocking permission asks.
   */
  startTurn(opts: RunAgentOpts, model: string): AsyncIterable<StreamEvent>;

  /**
   * Fold a message into a live run at its next step boundary (mid-turn
   * steer). True = accepted for delivery; false = nothing steerable under
   * this id (caller queues instead).
   */
  steer(id: string, text: string, images?: ImageInput[]): boolean;

  /** Hard-cancel a live run. True if anything was cancelled. */
  cancel(id: string): boolean;

  /** Is a run live under this id (any registered alias)? */
  isBusy(id: string): boolean;

  /**
   * Reattach to a run whose engine process survived a service restart
   * (journaled record + detached server). Resolves to the re-pumped event
   * stream, or null when the run is gone / was never detachable — the caller
   * then falls back to the continuation re-prompt.
   */
  reattach(
    run: ActiveRunRecord,
    handlers?: { onAskUser?: EngineAskHandler }
  ): Promise<AsyncIterable<StreamEvent> | null>;

  /**
   * How many of this adapter's live runs execute on DETACHED engine servers
   * that survive a restart — the graceful-shutdown drain skips waiting on
   * these (boot reattaches them via the journal instead).
   */
  activeDetachedRunCount(): number;
}
