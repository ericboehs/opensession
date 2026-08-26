import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import { mineStatus } from "./sidebar-lanes";

function session(overrides: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: "session-1",
    title: "Session",
    createdAt: "2026-08-22T12:00:00Z",
    lastActivity: "2026-08-22T12:00:00Z",
    isRunning: false,
    transcriptPath: null,
    ...overrides,
  } as UnifiedSession;
}

describe("mineStatus", () => {
  test("files every working chat under In progress", () => {
    expect(
      mineStatus(session({ isRunning: true, manualStatus: "pending" })),
    ).toBe("inprogress");
  });

  test("restores a pinned lane when the chat becomes idle", () => {
    expect(mineStatus(session({ manualStatus: "review" }))).toBe("review");
  });

  test("keeps a blocked chat above running state", () => {
    expect(
      mineStatus(session({ isRunning: true, waitingForInput: true })),
    ).toBe("needsinput");
  });
});
