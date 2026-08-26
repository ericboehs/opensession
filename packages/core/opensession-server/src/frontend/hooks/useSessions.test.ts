import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "../lib/types";
import {
  LIVE_POLL_FALLBACK_MS,
  liveSnapshotMatchesQuery,
  reconcilePendingSessionPatches,
  sessionPatchNeedsAcknowledgement,
  sidebarSessionsQuery,
} from "./useSessions";

test("uses a slow safety poll behind WebSocket invalidations", () => {
  expect(LIVE_POLL_FALLBACK_MS).toBe(60_000);
});

function session(archived: boolean): UnifiedSession {
  return { id: "session-1", archived } as UnifiedSession;
}

describe("sidebarSessionsQuery", () => {
  test("asks for the active server-side sidebar projection", () => {
    expect(
      sidebarSessionsQuery({
        user: "Ada Lovelace",
        person: "me",
        repo: "tella fusion",
        autoCreated: "hide",
        selectedSessionId: "os-1",
      }),
    ).toBe(
      "?archived=exclude&view=sidebar&user=Ada+Lovelace&person=me&repo=tella+fusion&autoCreated=hide&session=os-1",
    );
  });
});

describe("liveSnapshotMatchesQuery", () => {
  test("fences a response scoped to the previously selected session", () => {
    const archivedRoute = sidebarSessionsQuery({
      user: "Ada Lovelace",
      person: "me",
      repo: "all",
      autoCreated: "hide",
      selectedSessionId: "archived-session",
    });
    const nextRoute = sidebarSessionsQuery({
      user: "Ada Lovelace",
      person: "me",
      repo: "all",
      autoCreated: "hide",
      selectedSessionId: "next-session",
    });

    expect(liveSnapshotMatchesQuery(archivedRoute, nextRoute)).toBe(false);
    expect(liveSnapshotMatchesQuery(nextRoute, nextRoute)).toBe(true);
  });
});

describe("reconcilePendingSessionPatches", () => {
  test("keeps the chat's running state applied across a stale list poll", () => {
    const pending = new Map([
      [
        "session-1",
        {
          values: {
            isRunning: true,
            runStartedAt: "2026-08-22T12:00:00Z",
          },
          runtimeRevision: 1,
        },
      ],
    ]);

    const [reconciled] = reconcilePendingSessionPatches(
      [{ ...session(false), isRunning: false }],
      pending,
      0,
    );

    expect(reconciled.isRunning).toBe(true);
    expect(reconciled.runStartedAt).toBe("2026-08-22T12:00:00Z");
    expect(pending.has("session-1")).toBe(true);
  });

  test("accepts idle state from a poll started after the run frame", () => {
    const idle = session(false);
    const pending = new Map([
      [
        "session-1",
        {
          values: {
            isRunning: true,
            runStartedAt: "2026-08-22T12:00:00Z",
          },
          runtimeRevision: 1,
        },
      ],
    ]);

    expect(reconcilePendingSessionPatches([idle], pending, 1)).toEqual([idle]);
    expect(pending.has("session-1")).toBe(false);
  });

  test("holds runtime and archive patches until the server acknowledges them", () => {
    expect(sessionPatchNeedsAcknowledgement({ isRunning: true })).toBe(true);
    expect(sessionPatchNeedsAcknowledgement({ archived: true })).toBe(true);
    expect(sessionPatchNeedsAcknowledgement({ title: "Renamed" })).toBe(false);
  });

  test("keeps an optimistic archive applied across a stale poll", () => {
    const pending = new Map([
      [
        "session-1",
        { values: { archived: true, archivedReason: "manual" as const } },
      ],
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
    const pending = new Map([
      [
        "session-1",
        { values: { archived: true, archivedReason: "manual" as const } },
      ],
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
