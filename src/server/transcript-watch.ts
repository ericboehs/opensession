import type {
  SeqEntry,
  TranscriptBusEvent,
  TranscriptPage,
} from "./transcript-store";

export interface TranscriptWatchStore {
  getLastChangeSeq(sessionId: string): number;
  getLastResetChangeSeq(sessionId: string): number;
  readChangesSince(
    sessionId: string,
    sinceChangeSeq: number,
    limit?: number
  ): TranscriptPage;
  readTail(sessionId: string, limit?: number): TranscriptPage;
}

export interface TranscriptWatchSocket {
  send(payload: string): void;
}

export interface StartTranscriptWatchOptions {
  sessionId: string;
  store: TranscriptWatchStore;
  socket: TranscriptWatchSocket;
  subscribe: (
    sessionId: string,
    wake: (event: TranscriptBusEvent) => void
  ) => () => void;
  schedule: (fn: () => void, delayMs: number) => unknown;
  isCurrent: () => boolean;
  sinceChangeSeq?: number;
  clampSnapshot?: (entries: SeqEntry[]) => SeqEntry[];
}

export interface TranscriptWatchHandle {
  unsubscribe(): void;
  /** Current durable mutation cursor, exposed for deterministic tests. */
  changeSeq(): number;
}

const RESUME_LIMIT = 500;
const FIRST_PAINT_ENTRIES = 12;
const SNAPSHOT_TAIL_ENTRIES = FIRST_PAINT_ENTRIES + 120;

/**
 * Start a race-free v2 watch. Subscription happens before the durable read,
 * and bus callbacks are only wake-ups: every delivery is reconciled from
 * SQLite by changeSeq. This makes delayed/duplicated notifications harmless.
 */
export function startTranscriptWatch(
  options: StartTranscriptWatchOptions
): TranscriptWatchHandle {
  const {
    sessionId,
    store,
    socket,
    subscribe,
    schedule,
    isCurrent,
    clampSnapshot = (entries) => entries,
  } = options;
  let cursor = 0;
  let initialized = false;
  let flushing = false;
  let pending = false;
  let resetPending = false;
  let closed = false;
  let snapshotGeneration = 0;

  const send = (frame: Record<string, unknown>) => {
    if (!closed && isCurrent()) socket.send(JSON.stringify(frame));
  };

  function sendSnapshot(): void {
    const generation = ++snapshotGeneration;
    // Capture the mutation baseline before the tail. A write racing the tail
    // read may overlap the snapshot, but the following flush replays it by id.
    cursor = store.getLastChangeSeq(sessionId);
    const tail = store.readTail(sessionId, SNAPSHOT_TAIL_ENTRIES);
    const head = tail.entries.slice(-FIRST_PAINT_ENTRIES);
    const rest = tail.entries.slice(0, -FIRST_PAINT_ENTRIES);
    send({
      type: "transcript_init",
      sessionId,
      entries: clampSnapshot(head),
      truncated: tail.firstSeq > 1,
      firstSeq: head.length ? head[0].seq : 0,
      lastSeq: head.length ? head[head.length - 1].seq : 0,
      lastChangeSeq: cursor,
      v2: true,
    });
    if (rest.length) {
      const payload = JSON.stringify({
        type: "transcript_history",
        sessionId,
        entries: clampSnapshot(rest),
        firstSeq: rest[0].seq,
        lastSeq: rest[rest.length - 1].seq,
        truncated: tail.firstSeq > 1,
        v2: true,
      });
      schedule(() => {
        if (!closed && generation === snapshotGeneration && isCurrent()) {
          socket.send(payload);
        }
      }, 80);
    }
  }

  const flush = (event?: TranscriptBusEvent) => {
    if (event?.reset) resetPending = true;
    if (closed || !initialized) {
      pending = true;
      return;
    }
    if (flushing) {
      pending = true;
      return;
    }
    flushing = true;
    try {
      do {
        pending = false;
        if (resetPending) {
          resetPending = false;
          sendSnapshot();
        }
        for (;;) {
          const page = store.readChangesSince(sessionId, cursor, RESUME_LIMIT);
          if (!page.entries.length) break;
          cursor = Math.max(cursor, ...page.entries.map((entry) => entry.changeSeq));
          send({
            type: "transcript_append",
            sessionId,
            entries: page.entries,
            firstSeq: page.firstSeq,
            lastSeq: page.lastSeq,
            lastChangeSeq: cursor,
            v2: true,
          });
          if (page.entries.length < RESUME_LIMIT) break;
        }
      } while (pending && !closed);
    } finally {
      flushing = false;
    }
  };

  // Subscribe before observing any cursor or snapshot. A commit at every
  // possible handshake boundary either appears in the read or sets pending.
  const unsubscribeBus = subscribe(sessionId, flush);
  try {
    const requested =
      typeof options.sinceChangeSeq === "number" &&
      Number.isFinite(options.sinceChangeSeq) &&
      options.sinceChangeSeq >= 0
        ? Math.floor(options.sinceChangeSeq)
        : undefined;
    const lastChangeSeq = store.getLastChangeSeq(sessionId);
    const lastResetChangeSeq = store.getLastResetChangeSeq(sessionId);
    let resumed = false;
    if (
      requested !== undefined &&
      requested >= lastResetChangeSeq &&
      requested <= lastChangeSeq
    ) {
      const changes = store.readChangesSince(
        sessionId,
        requested,
        RESUME_LIMIT + 1
      );
      if (changes.entries.length <= RESUME_LIMIT) {
        cursor = requested;
        if (changes.entries.length) {
          cursor = Math.max(
            cursor,
            ...changes.entries.map((entry) => entry.changeSeq)
          );
          send({
            type: "transcript_append",
            sessionId,
            entries: changes.entries,
            firstSeq: changes.firstSeq,
            lastSeq: changes.lastSeq,
            lastChangeSeq: cursor,
            v2: true,
          });
        }
        resumed = true;
      }
    }

    if (!resumed) sendSnapshot();

    initialized = true;
    // Mandatory post-subscription reconciliation. It also covers writes caused
    // synchronously by a socket.send implementation in tests or adapters.
    flush();

    return {
      unsubscribe() {
        if (closed) return;
        closed = true;
        snapshotGeneration++;
        unsubscribeBus();
      },
      changeSeq: () => cursor,
    };
  } catch (error) {
    closed = true;
    snapshotGeneration++;
    unsubscribeBus();
    throw error;
  }
}
