import { describe, expect, test } from "bun:test";
import { sessionListRow } from "./sessions";
import type { UnifiedSession } from "../types";

describe("ordinary session safety projection", () => {
  test("keeps a visible safety state while removing a stale running projection", () => {
    const row = sessionListRow({
      id: "paused-session",
      claudeSessionId: null,
      source: "opensession",
      branch: null,
      worktreeDir: null,
      startedBy: null,
      title: "Paused work",
      lastActivity: "2026-08-26T12:00:00.000Z",
      createdAt: "2026-08-26T11:00:00.000Z",
      isRunning: false,
      transcriptPath: null,
      safety: {
        status: "paused_for_safety",
        explanation: "Open Session paused this session.",
        automaticReconciliationRunning: false,
        pausedAt: "2026-08-26T12:00:00.000Z",
        operation: "finishing the current turn",
        repairAvailable: false,
      },
    } as UnifiedSession);

    expect(row.isRunning).toBeUndefined();
    expect(row.safety).toMatchObject({
      status: "paused_for_safety",
      repairAvailable: false,
    });
  });

  test("exposes whether a queued prompt has a live drain owner", () => {
    const row = sessionListRow({
      id: "queued-session",
      claudeSessionId: null,
      source: "opensession",
      branch: null,
      worktreeDir: null,
      startedBy: null,
      title: "Queued work",
      lastActivity: "2026-08-26T12:00:00.000Z",
      createdAt: "2026-08-26T11:00:00.000Z",
      isRunning: false,
      transcriptPath: null,
      queuedCount: 1,
      queueOwnerActive: true,
    } as UnifiedSession);

    expect(row).toMatchObject({ queuedCount: 1, queueOwnerActive: true });
  });
});
