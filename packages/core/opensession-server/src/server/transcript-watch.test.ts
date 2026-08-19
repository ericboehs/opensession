import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "./transcript-store";
import { subscribeTranscript, transcriptSubscriberCount } from "./transcript-bus";
import { startTranscriptWatch } from "./transcript-watch";
import type { TranscriptEntry } from "./types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "transcript-watch-"));
  const store = new TranscriptStore(join(dir, "transcripts.db"));
  const frames: any[] = [];
  const socket = {
    onSend: null as null | ((frame: any) => void),
    send(payload: string) {
      const frame = JSON.parse(payload);
      frames.push(frame);
      this.onSend?.(frame);
    },
  };
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, frames, socket };
}

function entry(id: string, content: string): TranscriptEntry {
  return {
    id,
    type: "assistant",
    content,
    timestamp: "2026-07-23T12:00:00.000Z",
  };
}

function watch(
  state: ReturnType<typeof setup>,
  sessionId: string,
  sinceChangeSeq?: number
) {
  return startTranscriptWatch({
    sessionId,
    store: state.store,
    socket: state.socket,
    subscribe: subscribeTranscript,
    isCurrent: () => true,
    ...(sinceChangeSeq === undefined ? {} : { sinceChangeSeq }),
  });
}

describe("race-free transcript watch", () => {
  test("reconciles an append committed synchronously while init is being sent", () => {
    const state = setup();
    const sid = `bks-race-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [entry("a", "before")]);
    state.socket.onSend = (frame) => {
      if (frame.type === "transcript_init") {
        state.socket.onSend = null;
        state.store.appendTranscriptEvents(sid, [entry("b", "during")]);
      }
    };

    const handle = watch(state, sid);
    cleanups.push(() => handle.unsubscribe());

    expect(state.frames.map((frame) => frame.type)).toEqual([
      "transcript_init",
      "transcript_append",
    ]);
    expect(state.frames[1].entries.map((e: TranscriptEntry) => e.id)).toEqual(["b"]);
    expect(handle.changeSeq()).toBe(2);
  });

  test("reconnect replays an old-seq rewrite through changeSeq", () => {
    const state = setup();
    const sid = `bks-rewrite-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [
      entry("old", "v1"),
      entry("new", "later"),
    ]);
    const cursor = state.store.getLastChangeSeq(sid);
    state.store.appendTranscriptEvents(sid, [entry("old", "v2")]);

    const handle = watch(state, sid, cursor);
    cleanups.push(() => handle.unsubscribe());

    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({
      type: "transcript_append",
      lastChangeSeq: 3,
    });
    expect(state.frames[0].entries[0]).toMatchObject({
      id: "old",
      content: "v2",
      seq: 1,
      changeSeq: 3,
    });
  });

  test("duplicate bus wake-ups never duplicate durable changes", async () => {
    const state = setup();
    const sid = `bks-wake-${crypto.randomUUID()}`;
    state.store.markImported(sid, "live-only");
    const handle = watch(state, sid);
    cleanups.push(() => handle.unsubscribe());
    state.frames.length = 0;

    state.store.appendTranscriptEvents(sid, [entry("a", "one")]);
    // A second subscriber-style wake is represented by another upsert-free
    // notification; reconciliation reads only changeSeq > cursor.
    await Promise.resolve();
    await Promise.resolve();

    expect(state.frames).toHaveLength(1);
    expect(state.frames[0].entries.map((e: TranscriptEntry) => e.id)).toEqual(["a"]);
  });

  test("preserves an ordered feed envelope for the matching durable wake", async () => {
    const state = setup();
    const sid = `bks-feed-${crypto.randomUUID()}`;
    state.store.markImported(sid, "live-only");
    const handle = startTranscriptWatch({
      sessionId: sid,
      store: state.store,
      socket: state.socket,
      subscribe: subscribeTranscript,
      isCurrent: () => true,
      formatAppend(frame, event) {
        return event?.feed ? { ...event.feed, event: frame } : frame;
      },
    });
    cleanups.push(() => handle.unsubscribe());
    state.frames.length = 0;

    state.store.appendTranscriptEvents(sid, [entry("a", "one")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.frames[0]).toMatchObject({
      type: "session_feed",
      phase: "committed",
      event: {
        type: "transcript_append",
        lastChangeSeq: 1,
        entries: [expect.objectContaining({ id: "a", changeSeq: 1 })],
      },
    });
  });

  test("unsubscribe is idempotent and releases the bus subscription", () => {
    const state = setup();
    const sid = `bks-unsub-${crypto.randomUUID()}`;
    const handle = watch(state, sid);
    expect(transcriptSubscriberCount(sid)).toBe(1);
    handle.unsubscribe();
    handle.unsubscribe();
    expect(transcriptSubscriberCount(sid)).toBe(0);
  });

  test("a failed handshake releases its subscription", () => {
    const state = setup();
    const sid = `bks-fail-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [entry("a", "one")]);
    state.socket.send = () => {
      throw new Error("socket closed");
    };

    expect(() => watch(state, sid)).toThrow("socket closed");
    expect(transcriptSubscriberCount(sid)).toBe(0);
  });

  test("authoritative replacement sends a fresh complete init", async () => {
    const state = setup();
    const sid = `bks-reset-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(
      sid,
      Array.from({ length: 30 }, (_, i) => entry(`old-${i}`, String(i)))
    );
    const handle = watch(state, sid);
    cleanups.push(() => handle.unsubscribe());
    state.frames.length = 0;

    state.store.replaceTranscriptEvents(sid, [entry("new", "replacement")]);
    await Promise.resolve();
    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({
      type: "transcript_init",
      entries: [expect.objectContaining({ id: "new", seq: 1 })],
    });
    expect(state.frames).toHaveLength(1);
  });

  test("reconnect from before a missed replacement receives a snapshot", () => {
    const state = setup();
    const sid = `bks-reset-resume-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(sid, [entry("old", "old")]);
    const staleCursor = state.store.getLastChangeSeq(sid);
    state.store.replaceTranscriptEvents(sid, [entry("new", "new")]);

    const handle = watch(state, sid, staleCursor);
    cleanups.push(() => handle.unsubscribe());
    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({
      type: "transcript_init",
      entries: [expect.objectContaining({ id: "new" })],
    });
  });

  test("large snapshots initialize in one frame", () => {
    const state = setup();
    const sid = `bks-stage-${crypto.randomUUID()}`;
    state.store.appendTranscriptEvents(
      sid,
      Array.from({ length: 140 }, (_, i) => entry(`e${i}`, String(i)))
    );
    const handle = watch(state, sid);
    expect(state.frames).toHaveLength(1);
    expect(state.frames[0]).toMatchObject({
      type: "transcript_init",
      truncated: true,
      firstSeq: 9,
      lastSeq: 140,
    });
    expect(state.frames[0].entries).toHaveLength(132);
    expect(state.frames[0].entries[0]).toMatchObject({ id: "e8", seq: 9 });
    expect(state.frames[0].entries.at(-1)).toMatchObject({
      id: "e139",
      seq: 140,
    });
    handle.unsubscribe();
    expect(state.frames).toHaveLength(1);
  });

  test("every entry batch is prepared before it goes on the wire", async () => {
    // Store rows are raw: classification (notices.ts) happens on the way out,
    // and a client that only reads the classified form has no second chance.
    // Snapshot, resume append and live append must all go through it.
    const state = setup();
    const sid = `bks-prepare-${crypto.randomUUID()}`;
    const prepareEntries = (entries: any[]) =>
      entries.map((e) => ({ ...e, prepared: true }));
    state.store.appendTranscriptEvents(sid, [entry("a", "snapshot")]);
    const cursor = state.store.getLastChangeSeq(sid);
    state.store.appendTranscriptEvents(sid, [entry("b", "resume")]);

    const handle = startTranscriptWatch({
      sessionId: sid,
      store: state.store,
      socket: state.socket,
      subscribe: subscribeTranscript,
      isCurrent: () => true,
      sinceChangeSeq: cursor,
      prepareEntries,
    });
    cleanups.push(() => handle.unsubscribe());
    state.store.appendTranscriptEvents(sid, [entry("c", "live")]);
    // The bus fans out on the microtask queue, never inside the write.
    await Promise.resolve();

    const sent = state.frames.flatMap((frame) => frame.entries ?? []);
    expect(sent.map((e: any) => e.id)).toEqual(["b", "c"]);
    expect(sent.every((e: any) => e.prepared)).toBe(true);

    // …and the snapshot path too, for a watch that can't resume.
    state.frames.length = 0;
    const fresh = startTranscriptWatch({
      sessionId: sid,
      store: state.store,
      socket: state.socket,
      subscribe: subscribeTranscript,
      isCurrent: () => true,
      prepareEntries,
    });
    cleanups.push(() => fresh.unsubscribe());
    expect(state.frames[0].type).toBe("transcript_init");
    expect(
      state.frames[0].entries.every((e: any) => e.prepared)
    ).toBe(true);
  });
});
