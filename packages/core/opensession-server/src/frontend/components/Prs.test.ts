import { expect, test } from "bun:test";
import type { RecentPr } from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { buildWorktreeRows } from "../lib/pr-rows";

test("keeps GitHub merged state authoritative over stale archived session data", () => {
  const url = "https://github.com/tellahq/backstage/pull/59";
  const recentPr = {
    url,
    repo: "opensession",
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
    repo: "opensession",
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

test("keeps line stats for every projected session PR", () => {
  const session = {
    id: "bks-cross-repo",
    title: "Cross-repo change",
    lastActivity: "2026-07-16T13:00:00Z",
    startedBy: "Kent",
    prs: [
      {
        repo: "opensession",
        branch: "feature",
        source: "primary",
        url: "https://github.com/tellahq/opensession/pull/59",
        additions: 10,
        deletions: 2,
      },
      {
        repo: "shared-infra",
        branch: "feature",
        source: "attached",
        url: "https://github.com/tellahq/shared-infra/pull/126",
        additions: 25,
        deletions: 4,
      },
    ],
  } as UnifiedSession;

  const rows = buildWorktreeRows([], [session]);
  const stats = rows.map(({ repo, additions, deletions }) => ({
    repo,
    additions,
    deletions,
  }));

  expect(stats).toEqual([
    { repo: "opensession", additions: 10, deletions: 2 },
    { repo: "shared-infra", additions: 25, deletions: 4 },
  ]);
});
