import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "../lib/types";
import {
  reconcileCloudOutageSessions,
  reconcilePendingSessionPatches,
} from "./useSessions";

function session(archived: boolean): UnifiedSession {
  return { id: "session-1", archived } as UnifiedSession;
}

describe("reconcilePendingSessionPatches", () => {
  test("keeps an optimistic archive applied across a stale poll", () => {
    const pending = new Map<string, Partial<UnifiedSession>>([
      ["session-1", { archived: true, archivedReason: "manual" }],
    ]);

    const [reconciled] = reconcilePendingSessionPatches(
      [session(false)],
      pending,
    );

    expect(reconciled.archived).toBe(true);
    expect(reconciled.archivedReason).toBe("manual");
    expect(pending.has("session-1")).toBe(true);
  });

  test("drops the optimistic patch after the server acknowledges it", () => {
    const pending = new Map<string, Partial<UnifiedSession>>([
      ["session-1", { archived: true, archivedReason: "manual" }],
    ]);
    const acknowledged = {
      ...session(true),
      archivedReason: "manual" as const,
    };

    expect(reconcilePendingSessionPatches([acknowledged], pending)).toEqual([
      acknowledged,
    ]);
    expect(pending.has("session-1")).toBe(false);
  });
});

describe("reconcileCloudOutageSessions", () => {
  const item = (
    id: string,
    lastActivity: string,
    local = false,
  ): UnifiedSession =>
    ({ id, lastActivity, ...(local ? { local: true } : {}) }) as UnifiedSession;

  test("retains cloud sessions while applying the latest local snapshot", () => {
    const cloud = item("cloud", "2026-07-24T10:00:00Z");
    const staleLocal = item("local", "2026-07-24T09:00:00Z", true);
    const freshLocal = item("local", "2026-07-24T11:00:00Z", true);

    expect(
      reconcileCloudOutageSessions([cloud, staleLocal], [freshLocal]),
    ).toEqual([freshLocal, cloud]);
  });

  test("keeps the cloud successor instead of an upgraded local tombstone", () => {
    const cloud = item("same", "2026-07-24T10:00:00Z");
    const tombstone = {
      ...item("same", "2026-07-23T10:00:00Z", true),
      upgradedTo: { id: "same" },
    } as UnifiedSession;

    expect(reconcileCloudOutageSessions([cloud], [tombstone])).toEqual([cloud]);
  });

  test("does not invent cloud sessions on an offline cold start", () => {
    const local = item("local", "2026-07-24T10:00:00Z", true);
    expect(reconcileCloudOutageSessions([], [local])).toEqual([local]);
  });
});
