/**
 * Intake-time prompt durability (2026-07-24, bks-019f93ea: a restart killed a
 * create-run during engine-server spawn and the opening prompt was lost from
 * every store). run-session persists the user line at intake with a stable
 * uuid, and the runner's own transcript write reuses that uuid — these tests
 * pin the store contract that makes the two writes ONE bubble: upsert-dedupe
 * by (session_id, uuid), with the later (context-decorated) write replacing
 * the intake row in place.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "./transcript-store";
import { transcriptLineUser } from "./transcript-persistence";
import { parseJsonlLines } from "./jsonl-parser";

async function withStore(run: (store: TranscriptStore) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "transcript-early-persist-"));
  try {
    const store = new TranscriptStore(join(dir, "transcripts.db"));
    try {
      await run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SESSION = "bks-early-persist-test";

function userEntries(text: string, uuid: string) {
  return parseJsonlLines([JSON.stringify(transcriptLineUser(text, uuid))]);
}

describe("intake-time user-line persist", () => {
  test("session creation persists the visible prompt before workspace setup", async () => {
    const source = await Bun.file(
      new URL("./session-create.ts", import.meta.url),
    ).text();
    const persisted = source.indexOf("await persist();");
    const promptWrite = source.indexOf("storeAppendUserLineEarly(", persisted);
    const workspaceSetup = source.indexOf("await spec.materializeWorktree();", persisted);

    expect(persisted).toBeGreaterThan(-1);
    expect(promptWrite).toBeGreaterThan(persisted);
    expect(workspaceSetup).toBeGreaterThan(promptWrite);
  });

  test("intake write + runner write with the same uuid = one upserted row", async () => {
    await withStore(async (store) => {
      const uuid = "prompt-uuid-1";
      // Intake: raw user content, persisted before any engine exists.
      const first = await store.appendTranscriptEvents(
        SESSION,
        userEntries("fix the mask selection", uuid)
      );
      expect(first).toMatchObject({ inserted: 1, updated: 0 });

      // Runner start: same uuid, content now carries the context decoration.
      const second = await store.appendTranscriptEvents(
        SESSION,
        userEntries(
          "<opensession:context>\nhandoff\n</backstage:context>\n\nfix the mask selection",
          uuid
        )
      );
      expect(second).toMatchObject({ inserted: 0, updated: 1 });

      const tail = store.readTail(SESSION);
      const users = tail.entries.filter((e) => e.type === "user");
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(uuid);
      expect(users[0].content).toContain("fix the mask selection");
    });
  });

  test("a re-run with a DIFFERENT uuid would duplicate — the contract promptEntryId exists to prevent", async () => {
    await withStore(async (store) => {
      await store.appendTranscriptEvents(SESSION, userEntries("do the thing", "uuid-a"));
      await store.appendTranscriptEvents(SESSION, userEntries("do the thing", "uuid-b"));
      const users = store.readTail(SESSION).entries.filter((e) => e.type === "user");
      expect(users).toHaveLength(2);
    });
  });

  test("a session first touched by an intake write is marked live-only, not import-blocked", async () => {
    await withStore(async (store) => {
      expect(store.needsImport(SESSION)).toBe(true);
      await store.appendTranscriptEvents(SESSION, userEntries("first ever message", "u1"));
      expect(store.needsImport(SESSION)).toBe(false);
      expect(store.readTail(SESSION).entries).toHaveLength(1);
    });
  });
});
