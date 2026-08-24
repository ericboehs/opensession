/**
 * Bounded history for the run-host's proxied transcript appends (the
 * `transcript` frame; see src/server/transcript-forward.ts for the seam and
 * host.ts for the wiring).
 *
 * Socket-mode hosts have a live-only stream. Frames sent while the server is
 * detached are gone. Lines carry stable uuids and upsert server-side, so the
 * recovery is simply to re-send everything recorded so far on every
 * (re)attach. The history is byte-bounded: past the budget new batches are
 * still SENT live but no longer recorded, so a reattach resend turns partial
 * rather than the host growing without limit (`overflowed` reports it once).
 * WS-mode hosts do not need this: their frames ride the sequenced ring
 * buffer and replay after the server's ack (ws-buffer.ts).
 */

export interface TranscriptBatch {
  engineSessionId: string;
  lines: Record<string, unknown>[];
}

export class TranscriptRelay {
  private history: TranscriptBatch[] = [];
  private bytes = 0;
  private overflow = false;

  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}

  /** Record one batch for later resend. False = budget exhausted (the batch
   *  should still be sent live; it just will not be part of resends). */
  record(engineSessionId: string, lines: Record<string, unknown>[]): boolean {
    const size = JSON.stringify(lines).length;
    if (this.bytes + size > this.maxBytes) {
      this.overflow = true;
      return false;
    }
    this.history.push({ engineSessionId, lines });
    this.bytes += size;
    return true;
  }

  /** All recorded batches, oldest first, for a reattach resend. */
  replay(): readonly TranscriptBatch[] {
    return this.history;
  }

  /** True once at least one batch fell outside the byte budget. */
  get overflowed(): boolean {
    return this.overflow;
  }
}
