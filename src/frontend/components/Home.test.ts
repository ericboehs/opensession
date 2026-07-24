import { expect, test } from "bun:test";
import type { RecentPr } from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { buildWorktreeRows } from "./Home";

test("keeps GitHub merged state authoritative over stale archived session data", () => {
  const url = "https://github.com/tellahq/backstage/pull/59";
  const recentPr = {
    url,
    repo: "backstage",
    branch: "os1-review-sidebar-open",
    state: "MERGED",
    number: 59,
    title: "Review view-tab",
    additions: 10,
    deletions: 2,
    updatedAt: "2026-07-16T14:00:00Z",
    person: "kent",
    author: "tella-butler",
  } as RecentPr;
  const session = {
    id: "bks-review",
    title: "Review view-tab",
    repo: "backstage",
    branch: "os1-review-sidebar-open",
    prUrl: url,
    prState: "OPEN",
    lastActivity: "2026-07-16T13:00:00Z",
    archived: true,
    startedBy: "Kent",
  } as UnifiedSession;

  const rows = buildWorktreeRows([recentPr], [session]);

  expect(rows).toHaveLength(1);
  expect(rows[0].state).toBe("MERGED");
  expect(rows[0].archived).toBe(false);
  expect(rows[0].session).toBe(session);
});
