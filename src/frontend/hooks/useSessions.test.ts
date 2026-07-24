import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "../lib/types";
import { reconcilePendingSessionPatches } from "./useSessions";

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
