import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "./transcript-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "actor-transcript-wake-"));
  roots.push(root);
  const path = join(root, "session.sqlite");
  const sessionId = "wake-session";
  const request = {
    op: "append" as const,
    sessionId,
    requestId: "append-one",
    entries: [{
      id: "entry-one",
      type: "assistant" as const,
      timestamp: "2026-01-01T00:00:00.000Z",
      content: "committed",
    }],
  };
  return { path, sessionId, request };
}

describe("actor transcript wake crash recovery", () => {
  test("reconciles a committed mutation after a crash before wake delivery", () => {
    const { path, sessionId, request } = fixture();
    let store = new TranscriptStore(path);
    const committed = store.applyActorRequest(request) as {
      wakeCursor: number;
      replay: boolean;
    };
    expect(committed).toMatchObject({ wakeCursor: 1, replay: false });
    store.close();

    store = new TranscriptStore(path);
    expect(store.pendingActorWake(sessionId)).toMatchObject({
      cursor: 1,
      ackedCursor: 0,
      firstChangeSeq: 1,
      lastChangeSeq: 1,
    });
    expect(store.readChangesSince(sessionId, 0).entries).toMatchObject([
      { id: "entry-one", seq: 1, changeSeq: 1 },
    ]);
    expect(store.ackActorWake(sessionId, 1)).toBe(true);
    expect(store.pendingActorWake(sessionId)).toBeNull();
    store.close();
  });

  test("marks a chunked import complete only after the final actor receipt", () => {
    const { path, sessionId } = fixture();
    const store = new TranscriptStore(path);
    store.applyActorRequest({
      op: "import",
      sessionId,
      requestId: "import:one:0",
      entries: [{
        id: "history",
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "history",
      }],
      src: "merged",
      watermark: 42,
      final: false,
    });
    expect(store.needsImport(sessionId)).toBe(true);
    store.applyActorRequest({
      op: "import",
      sessionId,
      requestId: "import:one:1",
      entries: [],
      src: "merged",
      watermark: 42,
      final: true,
    });
    expect(store.needsImport(sessionId)).toBe(false);
    expect(store.getImportInfo(sessionId)).toMatchObject({
      src: "merged",
      watermark: 42,
    });
    store.close();
  });

  test("replays the immutable receipt without duplicating a wake before ack", () => {
    const { path, sessionId, request } = fixture();
    let store = new TranscriptStore(path);
    store.applyActorRequest(request);
    // Simulate gateway publication followed by a crash before durable ack.
    expect(store.readChangesSince(sessionId, 0).entries).toHaveLength(1);
    store.close();

    store = new TranscriptStore(path);
    expect(store.applyActorRequest(request)).toMatchObject({
      wakeCursor: 1,
      replay: true,
    });
    expect(store.countEvents(sessionId)).toBe(1);
    expect(store.getLastChangeSeq(sessionId)).toBe(1);
    expect(store.pendingActorWake(sessionId)?.cursor).toBe(1);
    store.close();
  });
});
