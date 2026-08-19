/**
 * Streaming assistant text as the model writes it, and the bookkeeping that
 * makes partial delivery safe.
 *
 * The opencode engine publishes a text part over SSE exactly twice, empty at
 * creation and complete at the end, so mirroring part snapshots can only ever
 * deliver a finished reply in one frame. Partial text exists in exactly one
 * place: the `message.part.delta` feed. Forwarding that is what makes a reply
 * type out, and it is what opencode's own client consumes.
 *
 * What goes out is not the raw delta feed, though. A model writes markdown,
 * and markdown mid-write does not render as itself: a paragraph stops
 * mid-word, a code fence has no closing fence, a backtick has no partner. So
 * deltas are held to the next boundary where the text stands on its own — the
 * end of a sentence, a line, or a block (`safeFlushLength`, which lives in
 * `@tellahq/opensession-protocol/stream-cuts` beside the viewers' word-level
 * reveal) — and a viewer only ever holds something it can render. It also
 * cuts a fast turn from hundreds of frames to a handful.
 *
 * Delivery from the server is unconditional, which is what makes the engines
 * agree: the codex-direct adapter has always streamed its
 * `item/agentMessage/delta` feed, and this puts opencode on the same footing.
 * Whether a reply actually types out is a VIEWER's choice (the "Live typing"
 * preference, default off) — several people can watch one run, the frames cost
 * nothing to drop, and deciding it client-side covers every engine rather than
 * only this one. OPENSESSION_OC_STREAM_TEXT=0 remains the instance-level kill
 * switch for stopping the frames at the source without waiting for a deploy.
 */

import { safeFlushLength } from "@tellahq/opensession-protocol/stream-cuts";

export { safeFlushLength };

/**
 * Whether the opencode runner forwards partial assistant text. On unless the
 * kill switch is set. Read per call, never pinned at module load, so flipping
 * it needs only a restart rather than an edit.
 */
export function streamPartialTextEnabled(): boolean {
  return process.env.OPENSESSION_OC_STREAM_TEXT !== "0";
}

/**
 * Per-part hold for the text between block boundaries.
 *
 * `push` takes the engine's raw delta and hands back only what can be shown
 * (see `safeFlushLength`); the rest waits for the delta that completes it.
 * The held text is never lost: the part's completion snapshot emits every
 * character the stream has not carried, so `clear` at completion is all the
 * bookkeeping a finished block needs.
 */
export class BlockFlusher {
  private held = new Map<string, string>();

  push(id: string, delta: string): string {
    if (!delta) return "";
    const text = (this.held.get(id) || "") + delta;
    const cut = safeFlushLength(text);
    if (cut <= 0) {
      this.held.set(id, text);
      return "";
    }
    const rest = text.slice(cut);
    if (rest) this.held.set(id, rest);
    else this.held.delete(id);
    return text.slice(0, cut);
  }

  clear(id: string): void {
    this.held.delete(id);
  }

  /** How many parts are holding text (test/diagnostic seam). */
  get size(): number {
    return this.held.size;
  }
}

/**
 * Per-run ledger of how much of each text part has already gone out.
 *
 * The invariant it exists to hold: every chunk emitted for one part
 * concatenates to exactly that part's final text, never more and never less.
 * run-session sums `text_chunk` into the turn's assistant text and the viewers
 * accumulate it into one bubble, so a re-sent prefix would duplicate the reply
 * and a dropped tail would truncate it.
 */
export class TextPartStream {
  private sent = new Map<string, number>();

  /**
   * The not-yet-emitted tail of this part, or "" when there is nothing new.
   * Records the new length, so consecutive calls walk the text forward.
   *
   * Text parts only grow. A body SHORTER than what already went out means the
   * part was rewritten (or re-delivered by a reconnect); there is no way to
   * un-say what the viewers already have, so this yields nothing further for
   * that part and lets the durable transcript entry — which lands at
   * completion and supersedes the live bubble — be the correction.
   */
  tail(id: string, text: unknown): string {
    const body = typeof text === "string" ? text : "";
    const sent = this.sent.get(id) || 0;
    if (body.length <= sent) return "";
    this.sent.set(id, body.length);
    return body.slice(sent);
  }

  /**
   * Record a delta the engine emitted for this part (message.part.delta) and
   * hand it back to be sent. The engine's deltas are a growing prefix of the
   * part's final text, so counting them here is what lets the completion
   * snapshot know it has only the remainder left to say.
   */
  advance(id: string, delta: unknown): string {
    const piece = typeof delta === "string" ? delta : "";
    if (!piece) return "";
    this.sent.set(id, (this.sent.get(id) || 0) + piece.length);
    return piece;
  }

  /** Forget a completed part. The ledger is per-run, so a part that never
   * completes is released with the turn. */
  done(id: string): void {
    this.sent.delete(id);
  }

  /** How many parts are still in flight (test/diagnostic seam). */
  get size(): number {
    return this.sent.size;
  }
}
