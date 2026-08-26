import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "../transcript-store";
import { SessionKernelStoreHost } from "./store-host";
import { SessionKernelStore, sessionKernelSessionDbPath } from "./store";
import {
  migrateActorTranscriptsOffline,
  rollbackActorTranscriptsOffline,
} from "./transcript-offline-migration";

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
  await source.importLegacyTranscript("orphan-without-placement", [{
    id: "orphan",
    type: "system",
    timestamp: "2026-01-01T00:00:00.000Z",
    content: "rollback evidence only",
  }], "merged", 10);
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
  return {
    root,
    centralPath,
    isolatedRoot,
    sourceTranscriptPath: sourcePath,
    sessionId,
  };
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

    const audit = migrateActorTranscriptsOffline({ ...paths, dryRun: true });
    expect(audit).toMatchObject({
      dryRun: true,
      migrated: 0,
      claimedTranscriptOnly: 1,
      sessions: [{ sessionId: paths.sessionId }, { sessionId: "orphan-without-placement" }],
    });
    let auditCentral = new SessionKernelStore(paths.centralPath);
    expect(auditCentral.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe("shared");
    expect(auditCentral.sessionPlacement("orphan-without-placement")).toBeUndefined();
    auditCentral.close();
    expect(existsSync(sessionKernelSessionDbPath(
      "orphan-without-placement",
      paths.isolatedRoot,
    ))).toBe(false);
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);

    let readOnlyAttachVerified = false;
    const result = migrateActorTranscriptsOffline({
      ...paths,
      afterSourceAttached: (db) => {
        expect(() => db.exec(
          "DELETE FROM source.transcript_events WHERE session_id = 'fixture-session'",
        )).toThrow("readonly");
        readOnlyAttachVerified = true;
      },
    });
    expect(readOnlyAttachVerified).toBe(true);
    expect(result).toMatchObject({
      migrated: 2,
      adopted: 0,
      migratedLegacyKernel: 0,
      claimedTranscriptOnly: 1,
    });
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
    });
    expect(central.sessionPlacement("orphan-without-placement")).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
    });
    central.close();

    expect(rollbackActorTranscriptsOffline(paths.centralPath)).toBe(2);
    auditCentral = new SessionKernelStore(paths.centralPath);
    expect(auditCentral.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe("shared");
    expect(
      auditCentral.sessionPlacement("orphan-without-placement")?.transcriptAuthority,
    ).toBe("shared");
    auditCentral.close();
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);
  });

  test("adopts a verified target after a crash before placement publication", async () => {
    const paths = await fixture();
    const beforeBytes = readFileSync(paths.sourceTranscriptPath);
    let verified = 0;
    expect(() => migrateActorTranscriptsOffline({
      ...paths,
      beforePublish: () => {
        verified++;
        if (verified === 2) throw new Error("simulated crash before publication");
      },
    })).toThrow("simulated crash before publication");
    expect(verified).toBe(2);

    let central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe("shared");
    expect(central.sessionPlacement("orphan-without-placement")).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "shared",
    });
    central.close();
    const orphanTarget = new TranscriptStore(sessionKernelSessionDbPath(
      "orphan-without-placement",
      paths.isolatedRoot,
    ));
    expect(orphanTarget.readTail("orphan-without-placement", 10).entries).toMatchObject([
      { id: "orphan" },
    ]);
    orphanTarget.close();
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);

    const adopted = migrateActorTranscriptsOffline(paths);
    expect(adopted).toMatchObject({
      migrated: 0,
      adopted: 2,
      claimedTranscriptOnly: 0,
    });
    central = new SessionKernelStore(paths.centralPath);
    expect(central.sessionPlacement(paths.sessionId)?.transcriptAuthority).toBe("actor");
    central.close();
    expect(readFileSync(paths.sourceTranscriptPath)).toEqual(beforeBytes);
  });

  test("enumerates receipt-only rows and aborts all authority publication", () => {
    const root = mkdtempSync(join(tmpdir(), "actor-transcript-incoherent-"));
    roots.push(root);
    const centralPath = join(root, "session-kernel.sqlite");
    const isolatedRoot = join(root, "session-kernel-sessions");
    const sourceTranscriptPath = join(root, "transcripts.db");
    new SessionKernelStore(centralPath).close();
    new TranscriptStore(sourceTranscriptPath).close();
    const source = new Database(sourceTranscriptPath);
    source.run(`
      INSERT INTO transcript_append_receipts
        (session_id, append_id, request_digest, fence_json, result_json, created_at)
      VALUES ('receipt-only', 'append', 'digest', '{}', '{}', 1)
    `);
    source.close();
    const beforeBytes = readFileSync(sourceTranscriptPath);
    expect(() => migrateActorTranscriptsOffline({
      centralPath,
      isolatedRoot,
      sourceTranscriptPath,
    })).toThrow("has 0 transcript metadata rows");
    expect(readFileSync(sourceTranscriptPath)).toEqual(beforeBytes);
    const central = new SessionKernelStore(centralPath);
    expect(central.sessionPlacement("receipt-only")).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "shared",
    });
    central.close();
  });

  test("migrates legacy central kernel placement before an empty-reset transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "actor-transcript-legacy-central-"));
    roots.push(root);
    const centralPath = join(root, "session-kernel.sqlite");
    const isolatedRoot = join(root, "session-kernel-sessions");
    const sourceTranscriptPath = join(root, "transcripts.db");
    const sessionId = "legacy-central-empty-reset";
    const central = new SessionKernelStore(centralPath);
    central.setRunState({ sessionId, state: "idle", event: "legacy" });
    central.close();
    const source = new TranscriptStore(sourceTranscriptPath);
    await source.importLegacyTranscript(sessionId, [{
      id: "removed",
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      content: "remove me",
    }], "merged", 42);
    await source.replaceTranscriptEvents(sessionId, []);
    const expected = snapshot(source, sessionId);
    expect(expected).toMatchObject({ count: 0, seq: 0, changeSeq: 2, reset: 2 });
    source.close();

    const result = migrateActorTranscriptsOffline({
      centralPath,
      isolatedRoot,
      sourceTranscriptPath,
    });
    expect(result).toMatchObject({
      migrated: 1,
      migratedLegacyKernel: 1,
      claimedTranscriptOnly: 0,
    });
    const migrated = new TranscriptStore(sessionKernelSessionDbPath(sessionId, isolatedRoot));
    expect(snapshot(migrated, sessionId)).toEqual(expected);
    migrated.close();
    const reopened = new SessionKernelStore(centralPath);
    expect(reopened.hasSessionDurableState(sessionId)).toBe(false);
    expect(reopened.sessionPlacement(sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
    });
    reopened.close();
  });
});
