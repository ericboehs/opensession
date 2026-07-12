/**
 * Engine-neutral run event types shared by the runner (opencode) and by
 * everything that consumes a run's event stream (opensession.ts, sandbox
 * providers, the runner host).
 */

/**
 * Token/cost accounting for a single run (accumulated across all turns in the
 * run — steers and background-task follow-ups included), attached to the
 * terminal `done` event. `contextTokens` is the last turn's full prompt size
 * (input + cache read + cache creation) — the live "how full is the context
 * window" figure.
 */
export interface TurnUsage {
  costUsd?: number;
  costApproximate?: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number;
}

/** A large Anthropic turn after the first should reuse at least some prefix. */
export function isLikelyPromptCacheMiss(
  usage: TurnUsage,
  userTurns: number,
  providerId: string,
): boolean {
  if (providerId !== "anthropic" || userTurns < 2 || usage.contextTokens < 10_000) return false;
  return usage.cacheReadTokens < 1_024 && usage.cacheReadTokens / usage.contextTokens < 0.05;
}

export interface StreamEvent {
  type:
    | "init"
    | "text_chunk"
    | "tool_use"
    | "tool_result"
    | "usage_snapshot"
    | "done"
    | "error"
    | "model_switch"
    // Runner-injected operational notice (`text`), e.g. "usage limit hit on
    // account X; switched to Y and retrying". NOT part of the model's reply —
    // the runner persists it as a durable system line in the session
    // transcript (the remote mirror does the same host-side), so stream
    // consumers should not fold it into assistant text.
    | "runner_notice";
  sessionId?: string;
  text?: string;
  /** On a model_switch: the exhausted model and the fallback it switched to. */
  fromModel?: string;
  toModel?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  content?: string;
  result?: string;
  /**
   * Renderable image sources on a tool_result (data: URLs from base64 blocks,
   * or direct urls). Forwarded to viewers so screenshots show up the moment
   * the tool returns instead of waiting for the jsonl tail to catch up.
   */
  images?: string[];
  /**
   * Renderable video sources on a tool_result, parsed from `BACKSTAGE_VIDEO:`
   * markers in the (full, pre-truncation) tool output. Forwarded so recordings
   * play the moment the tool returns, no reload needed.
   */
  videos?: string[];
  /** Which backend emitted this event (set on init/done). */
  provider?: "claude" | "codex" | "opencode";
  /** Effective model for the run (set on init/done). */
  model?: string;
  /**
   * Cumulative token/cost accounting for the run. Set on the terminal `done`
   * (authoritative) and on every `usage_snapshot` (live mid-run figures —
   * always run-cumulative, so consumers fold a snapshot onto the pre-run base
   * rather than onto the previous snapshot).
   */
  usage?: TurnUsage;
  /** This completed Anthropic turn unexpectedly reused almost none of its prompt. */
  cacheMissWarning?: boolean;
  /**
   * Set on a terminal done/error when the run died on usage limits with no
   * account left to rotate to — the dispatcher's cue to try a fallback model.
   */
  usageLimitExhausted?: boolean;
}

/** A pasted/dropped image, decoded to raw base64 (no `data:` prefix). */
export interface ImageInput {
  mediaType: string;
  data: string;
}
