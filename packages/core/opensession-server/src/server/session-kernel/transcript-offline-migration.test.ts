import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "../transcript-store";
import { SessionKernelStoreHost } from "./store-host";
import { SessionKernelStore, sessionKernelSessionDbPath } from "./store";
import { migrateActorTranscriptsOffline } from "./transcript-offline-migration";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "actor-transcript-migration-"));
  roots.push(root);
  const centralPath = join(root, "session-kernel.sqlite");
  const isolatedRoot = join(root, "session-kernel-sessions");
  const sourcePath = join(root, "transcripts.db");
  const sessionId = "fixture-session";
  const central = new SessionKernelStore(centralPath);
  central.setRunState({ sessionId, state: "idle", event: "seed" });
  central.close();
  const host = new SessionKernelStoreHost(centralPath, isolatedRoot);
  expect(host.migrateLegacySessions(1)).toBe(1);
  host.close();

  const source = new TranscriptStore(sourcePath);
  const oversized = "x".repeat(40_000);
  await source.importLegacyTranscript(sessionId, [{
    id: "old",
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    content: oversized,
  }], "merged", 123);
  await source.appendTranscriptDestination({
    sessionId,
    appendId: "destination-one",
    runId: "run-one",
    turnId: "turn-one",
    generation: 1,
    entries: [{
      id: "new",
      type: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      content: "hello",
    }],
  });
  source.close();
  return { root, centralPath, isolatedRoot, sourceTranscriptPath: sourcePath, sessionId };
}

function snapshot(store: TranscriptStore, sessionId: string) {
  return {
    tail: store.readTail(sessionId, 100),
    outline: store.readTranscriptIndex(sessionId),
    old: store.getFullEntry(sessionId, "old"),
    info: store.getImportInfo(sessionId),
    count: store.countEvents(sessionId),
    seq: store.getLastSeq(sessionId),
    changeSeq: store.getLastChangeSeq(sessionId),
    reset: store.getLastResetChangeSeq(sessionId),
  };
}

describe("offline actor transcript migration", () => {
  test("copies exact transcript authority and leaves the rollback source untouched", async () => {
    const paths = await fixture();
    const beforeBytes = readFileSync(paths.sourceTranscriptPath);
    const source = new TranscriptStore(paths.sourceTranscriptPath);
    const expected = snapshot(source, paths.sessionId);
    source.close();

    const result = migrateActorTranscriptsOffline(paths);
    expect(result).toMatchObject({ migrated: 1, adopted: 0 });
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);

    const target = new TranscriptStore(
      sessionKernelSessionDbPath(paths.sessionId, paths.isolatedRoot),
    );
    expect(snapshot(target, paths.sessionId)).toEqual(expected);
    target.close();
    const central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
      transcriptMigrationReceipt: result.sessions[0]!.receipt,
    });
    central.close();
  });

  test("adopts a verified target after a crash before placement publication", async () => {
    const paths = await fixture();
    const beforeBytes = readFileSync(paths.sourceTranscriptPath);
    expect(() => migrateActorTranscriptsOffline({
      ...paths,
      beforePublish: () => {
        throw new Error("simulated crash before publication");
      },
    })).toThrow("simulated crash before publication");

    let central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe("shared");
    central.close();
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);

    const adopted = migrateActorTranscriptsOffline(paths);
    expect(adopted).toMatchObject({ migrated: 0, adopted: 1 });
    central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe("actor");
    central.close();
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);
  });
});
