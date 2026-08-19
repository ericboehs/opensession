import { describe, expect, test } from "bun:test";
import {
  __adoptDetachedRecordsForTest,
  __probeDetachedRecordForTest,
  type DetachedRecordProbe,
} from "./opencode-runner";
import type { DetachedServerRecord } from "./opencode-detach";
import type { ActiveRunRecord } from "./run-journal";

function record(key: string, unit: string, spawnedAt: string): DetachedServerRecord {
  return {
    key,
    unit,
    pid: 42,
    url: "http://127.0.0.1:1",
    password: "test",
    cwd: "/tmp",
    configHash: "hash",
    shared: true,
    rpcToken: `token-${unit}`,
    spawnedAt,
  };
}

function probe(
  healthy: boolean,
  busySessionIds: string[] = [],
  uncertainSessionIds: string[] = [],
): DetachedRecordProbe {
  return { healthy, busySessionIds, uncertainSessionIds };
}

describe("detached opencode adoption", () => {
  test("keeps a journal session uncertain when its status probe does not answer", async () => {
    const key = `key-${crypto.randomUUID()}`;
    const rec = record(key, `unit-${crypto.randomUUID()}`, new Date().toISOString());
    const run = {
      runKey: `run-${crypto.randomUUID()}`,
      osSessionId: `os-${crypto.randomUUID()}`,
      claudeSessionId: `oc-${crypto.randomUUID()}`,
      serverKey: key,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    } satisfies ActiveRunRecord;

    const result = await __probeDetachedRecordForTest(rec, [run], async () => {
      throw new Error("boot probe timed out");
    });

    expect(result).toEqual({
      busySessionIds: [],
      uncertainSessionIds: [run.claudeSessionId],
    });
  });

  test("does not stop an uncertain older duplicate", () => {
    const key = `key-${crypto.randomUUID()}`;
    const older = record(key, `old-${crypto.randomUUID()}`, "2026-08-16T10:00:00.000Z");
    const newest = record(key, `new-${crypto.randomUUID()}`, "2026-08-16T11:00:00.000Z");
    const ocSessionId = `oc-${crypto.randomUUID()}`;
    const result = __adoptDetachedRecordsForTest(
      [older, newest],
      new Map([
        [older.unit, probe(false, [], [ocSessionId])],
        [newest.unit, probe(true)],
      ]),
    );
    try {
      expect(result.stopped).not.toContain(older.unit);
      const survivor = result.managed.find((entry) => entry.proc.unit === older.unit);
      expect(survivor?.draining).toBe(true);
      expect(survivor?.recoveringSessionIds).toEqual(new Set([ocSessionId]));
      expect(survivor?.confirmedRecoverySessionIds).toEqual(new Set());
    } finally {
      result.cleanup();
    }
  });

  test("does not stop an uncertain unhealthy newest record", () => {
    const key = `key-${crypto.randomUUID()}`;
    const newest = record(key, `new-${crypto.randomUUID()}`, "2026-08-16T11:00:00.000Z");
    const ocSessionId = `oc-${crypto.randomUUID()}`;
    const result = __adoptDetachedRecordsForTest(
      [newest],
      new Map([[newest.unit, probe(false, [], [ocSessionId])]]),
    );
    try {
      expect(result.stopped).not.toContain(newest.unit);
      expect(result.managed[0]?.draining).toBe(true);
      expect(result.managed[0]?.recoveringSessionIds).toEqual(new Set([ocSessionId]));
      expect(result.managed[0]?.confirmedRecoverySessionIds).toEqual(new Set());
    } finally {
      result.cleanup();
    }
  });

  test("still stops an older duplicate whose status probe answered idle", () => {
    const key = `key-${crypto.randomUUID()}`;
    const older = record(key, `old-${crypto.randomUUID()}`, "2026-08-16T10:00:00.000Z");
    const newest = record(key, `new-${crypto.randomUUID()}`, "2026-08-16T11:00:00.000Z");
    const result = __adoptDetachedRecordsForTest(
      [older, newest],
      new Map([
        [older.unit, probe(false)],
        [newest.unit, probe(true)],
      ]),
    );
    try {
      expect(result.stopped).toContain(older.unit);
      expect(result.managed.some((entry) => entry.proc.unit === older.unit)).toBe(false);
    } finally {
      result.cleanup();
    }
  });

  test("marks only successful busy probes as confirmed hosts", () => {
    const key = `key-${crypto.randomUUID()}`;
    const older = record(key, `old-${crypto.randomUUID()}`, "2026-08-16T10:00:00.000Z");
    const newest = record(key, `new-${crypto.randomUUID()}`, "2026-08-16T11:00:00.000Z");
    const ocSessionId = `oc-${crypto.randomUUID()}`;
    const result = __adoptDetachedRecordsForTest(
      [older, newest],
      new Map([
        [older.unit, probe(true, [ocSessionId])],
        [newest.unit, probe(true)],
      ]),
    );
    try {
      const survivor = result.managed.find((entry) => entry.proc.unit === older.unit);
      expect(survivor?.recoveringSessionIds).toEqual(new Set([ocSessionId]));
      expect(survivor?.confirmedRecoverySessionIds).toEqual(new Set([ocSessionId]));
    } finally {
      result.cleanup();
    }
  });
});
