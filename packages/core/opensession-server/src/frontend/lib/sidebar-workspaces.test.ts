import { describe, expect, test } from "bun:test";
import {
	activeSubagentsForWorkspace,
	isAskWorkspace,
	isScratchWorkspace,
	spawnedSessionBelongsInSidebar,
	workspaceMainSession,
	workspaceRowOwnsSelection,
	workspaceRowOwnsSession,
} from "./sidebar-workspaces";
import type { UnifiedSession } from "./types";

function session(
	id: string,
	overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
	return {
		id,
		claudeSessionId: null,
		source: "opensession",
		branch: null,
		worktreeDir: null,
		startedBy: "Michiel",
		title: id,
		lastActivity: "2026-08-18T10:00:00Z",
		createdAt: `2026-08-18T10:00:0${id.length}Z`,
		isRunning: false,
		transcriptPath: null,
		...overrides,
	};
}

describe("isScratchWorkspace", () => {
	test("recognizes a workspace containing scratch sessions", () => {
		expect(isScratchWorkspace([{ mode: "scratch" }, { mode: "scratch" }])).toBe(
			true,
		);
	});

	test("does not treat repo-backed or empty workspaces as scratch", () => {
		expect(isScratchWorkspace([{ mode: "scratch" }, { mode: "code" }])).toBe(
			false,
		);
		expect(isScratchWorkspace([])).toBe(false);
	});
});

describe("isAskWorkspace", () => {
	test("recognizes a workspace of repo-less ask sessions", () => {
		expect(
			isAskWorkspace([
				{ mode: "ask", repoLess: true },
				{ mode: "ask", repoLess: true },
			]),
		).toBe(true);
	});

	test("a repo-scoped ask session stays in its repo's band", () => {
		// The regression this guards: thousands of older ask sessions record no
		// repo yet sit in a real checkout, so a `!repo` test would empty every
		// project band into the Ask band. Only the stored decision counts.
		expect(isAskWorkspace([{ mode: "ask" }])).toBe(false);
		expect(isAskWorkspace([{ mode: "ask", repoLess: false }])).toBe(false);
	});

	test("scratch is repo-less but is not Ask", () => {
		expect(isAskWorkspace([{ mode: "scratch", repoLess: true }])).toBe(false);
	});

	test("a mixed or empty workspace is not an Ask workspace", () => {
		expect(
			isAskWorkspace([
				{ mode: "ask", repoLess: true },
				{ mode: "code" },
			]),
		).toBe(false);
		expect(isAskWorkspace([])).toBe(false);
	});
});

describe("spawnedSessionBelongsInSidebar", () => {
	test("keeps an unclaimed spawned deep link out of the sidebar", () => {
		expect(spawnedSessionBelongsInSidebar({ spawnedBy: "parent" }, false, false)).toBe(
			false,
		);
	});

	test("includes spawned sessions that need attention or were claimed", () => {
		const session = { spawnedBy: "parent" };
		expect(spawnedSessionBelongsInSidebar(session, true, false)).toBe(true);
		expect(spawnedSessionBelongsInSidebar(session, false, true)).toBe(true);
	});
});

describe("activeSubagentsForWorkspace", () => {
	test("returns only active children of the selected workspace", () => {
		const sessions = [
			session("parent", { workspaceId: "ws-1" }),
			session("running", {
				parentSessionId: "parent",
				workspaceId: "ws-1",
				isRunning: true,
			}),
			session("waiting", {
				parentSessionId: "parent",
				waitingForInput: true,
			}),
			session("queued", {
				parentSessionId: "parent",
				queuedCount: 1,
			}),
			session("idle", { parentSessionId: "parent" }),
			session("archived", {
				parentSessionId: "parent",
				isRunning: true,
				archived: true,
			}),
			session("other", {
				workspaceId: "ws-2",
				parentSessionId: "other-parent",
				isRunning: true,
			}),
		];

		expect(
			activeSubagentsForWorkspace(sessions, "ws-1").map(({ session }) =>
				session.id,
			),
		).toEqual(["queued", "running", "waiting"]);
		expect(activeSubagentsForWorkspace(sessions, "ws-3")).toEqual([]);
		expect(activeSubagentsForWorkspace(sessions, null)).toEqual([]);
	});

	test("follows nested parent edges across temporary child workspaces", () => {
		const sessions = [
			session("root", { workspaceId: "ws-1" }),
			session("child", {
				workspaceId: "ws-child",
				parentSessionId: "root",
				isRunning: true,
				createdAt: "2026-08-18T10:00:01Z",
			}),
			session("grandchild", {
				parentSessionId: "child",
				isRunning: true,
				createdAt: "2026-08-18T10:00:02Z",
			}),
		];

		expect(
			activeSubagentsForWorkspace(sessions, "ws-1").map(({ session, depth }) => [
				session.id,
				depth,
			]),
		).toEqual([
			["child", 1],
			["grandchild", 2],
		]);
	});

	test("deduplicates child sessions by id", () => {
		const child = session("child", {
			workspaceId: "ws-1",
			parentSessionId: "parent",
			isRunning: true,
		});
		const rows = activeSubagentsForWorkspace(
			[session("parent", { workspaceId: "ws-1" }), child, { ...child }],
			"ws-1",
		);
		expect(rows.map(({ session }) => session.id)).toEqual(["child"]);
	});
});

describe("workspaceMainSession", () => {
	test("opens the workspace root even when a subagent was opened last", () => {
		const root = session("root", { workspaceId: "ws-1" });
		const child = session("child", {
			workspaceId: "ws-1",
			parentSessionId: "root",
		});
		expect(workspaceMainSession({ sessions: [child, root] })?.id).toBe("root");
	});

	test("uses the oldest row session when no parent edge is available", () => {
		const first = session("first", { workspaceId: "ws-1" });
		const second = session("second", { workspaceId: "ws-1" });
		expect(workspaceMainSession({ sessions: [first, second] })?.id).toBe("first");
		expect(workspaceMainSession({ sessions: [] })).toBeNull();
	});
});

describe("workspaceRowOwnsSelection", () => {
	test("selects a parked workspace draft without a session", () => {
		const draft = {
			key: "workspace:ws-draft",
			workspace: { id: "ws-draft" },
			sessions: [],
		};
		expect(workspaceRowOwnsSelection(draft, null, "ws-draft")).toBe(true);
		expect(workspaceRowOwnsSelection(draft, null, "ws-other")).toBe(false);
	});
});

describe("workspaceRowOwnsSession", () => {
	test("selects the parent workspace for an automation tab", () => {
		expect(
			workspaceRowOwnsSession(
				{ key: "workspace:ws-1", workspace: { id: "ws-1" }, sessions: [{ id: "main" }] },
				{ id: "automation", workspaceId: "ws-1", worktreeDir: "/tmp/worktree" },
			),
		).toBe(true);
	});

	test("selects a standalone shared-worktree parent", () => {
		expect(
			workspaceRowOwnsSession(
				{ key: "wt:/tmp/worktree", workspace: null, sessions: [{ id: "main" }] },
				{ id: "automation", workspaceId: null, worktreeDir: "/tmp/worktree" },
			),
		).toBe(true);
	});

	test("does not select an unrelated workspace", () => {
		expect(
			workspaceRowOwnsSession(
				{ key: "workspace:ws-2", workspace: { id: "ws-2" }, sessions: [{ id: "other" }] },
				{ id: "automation", workspaceId: "ws-1", worktreeDir: "/tmp/worktree" },
			),
		).toBe(false);
	});
});
