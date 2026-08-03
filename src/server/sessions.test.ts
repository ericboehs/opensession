import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "./types";

let home: string;
let priorHome: string | undefined;
let priorChatsDir: string | undefined;
let priorCodexHome: string | undefined;
let priorConfig: string | undefined;
let priorGhBackoff: number | undefined;

beforeAll(async () => {
	priorHome = process.env.HOME;
	home = join(tmpdir(), `backstage-sessions-test-${crypto.randomUUID()}`);
	process.env.HOME = home;
	mkdirSync(join(home, ".backstage-chats"), { recursive: true });
	mkdirSync(join(home, ".slack-sessions"), { recursive: true });
	// The PR-cache assertions need a repo that actually carries a ghRepo:
	// prRepos() filters those out, and the only BUILT-IN repo is `opensession`
	// with an empty ghRepo (the registry became config-driven), so with no
	// config there are no PR repos at all — markCachedPrReviewed can't resolve
	// its ghRepo argument to a repo id and returns without mutating anything.
	// OPENSESSION_CONFIG is re-read per call (getConfig caches on path+mtime),
	// so setting it here reaches modules other test files already loaded.
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			repos: {
				backstage: {
					repo: "/home/ubuntu/projects/tella-backstage",
					ghRepo: "tellahq/backstage",
					label: "Backstage",
				},
			},
		}),
	);
	priorConfig = process.env.OPENSESSION_CONFIG;
	process.env.OPENSESSION_CONFIG = join(home, "config.json");
	// Close the GitHub gate for the whole file. Without it the PR cache's
	// SWR refresh fires a real `gh` call on first access and replaces the
	// seeded snapshot with live data — a network call from a unit test, and a
	// race that makes the cached-review assertion pass or fail on timing.
	priorGhBackoff = (
		await import("./github-limit")
	).__setGhBackoffForTest(Date.now() + 60 * 60_000);
	// The HOME override only reaches paths.ts / codex-accounts.ts if nothing
	// evaluated them yet — and bun test file order guarantees nothing
	// (another test file importing the server graph poisons the cached
	// BACKSTAGE_CHATS_DIR / codex-accounts' HOME with the real store, which
	// then leaks live sessions/rollouts into these assertions). The live-
	// binding seams repoint them regardless of who loaded the module first;
	// the cache-busted sessions.ts imports below re-read OPENSESSION_CHATS_DIR
	// at their load (findCodexRollout is reached through a bare import of
	// ./codex-accounts either way, so it needs the same live-binding seam).
	const paths = await import("./paths");
	priorChatsDir = paths.__setChatsDirForTest(join(home, ".backstage-chats"));
	const codexAccounts = await import("./codex-accounts");
	priorCodexHome = codexAccounts.__setCodexHomeForTest(home);
});

afterAll(async () => {
	if (priorHome === undefined) delete process.env.HOME;
	else process.env.HOME = priorHome;
	if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
	else process.env.OPENSESSION_CONFIG = priorConfig;
	if (priorGhBackoff !== undefined) {
		(await import("./github-limit")).__setGhBackoffForTest(priorGhBackoff);
	}
	if (priorChatsDir !== undefined) {
		(await import("./paths")).__setChatsDirForTest(priorChatsDir);
	}
	if (priorCodexHome !== undefined) {
		(await import("./codex-accounts")).__setCodexHomeForTest(priorCodexHome);
	}
	rmSync(home, { recursive: true, force: true });
});

function writeSession(id: string, data: Record<string, unknown>): void {
	writeFileSync(
		join(home, ".backstage-chats", `${id}.json`),
		JSON.stringify(
			{
				id,
				claudeSessionId: "",
				branch: "",
				worktreeDir: "/home/ubuntu/projects/tella-backstage",
				createdBy: "Michael",
				createdAt: "2026-07-02T18:00:00.000Z",
				lastActivity: "2026-07-02T18:00:00.000Z",
				mode: "ask",
				source: "backstage",
				...data,
			},
			null,
			2,
		),
	);
}

function writeSlackSession(id: string, data: Record<string, unknown>): void {
	writeFileSync(
		join(home, ".slack-sessions", `${id}.json`),
		JSON.stringify(data, null, 2),
	);
}

function uuidV7ForDate(iso: string): string {
	const hex = Date.parse(iso).toString(16).padStart(12, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

describe("getAllSessions", () => {
	it("keeps Codex worker sessions visible even when they have no workspace", async () => {
		writeSession("bks-codex-worker", {
			title: "Codex worker with no workspace",
			repo: "backstage",
			model: "gpt-5.5",
			codexThreadId: "codex-thread-1",
			projectId: null,
			automation: "Nightly review",
			automationId: "auto-nightly-review",
		});
		writeSession("bks-fable-orchestrator", {
			title: "Fable orchestrator with workspace",
			repo: "backstage",
			model: "claude-fable-5",
			claudeSessionId: "claude-session-1",
			workspaceId: "prj-demo",
			projectId: "legacy-project-ignored",
		});

		const { getAllSessions } = await import(`./sessions.ts?test=${crypto.randomUUID()}`);
		const sessions = getAllSessions();

		const codex = sessions.find((s: UnifiedSession) => s.id === "bks-codex-worker");
		expect(codex).toMatchObject({
			id: "bks-codex-worker",
			source: "backstage",
			repo: "backstage",
			model: "gpt-5.5",
			codexThreadId: "codex-thread-1",
			projectId: null,
			automation: "Nightly review",
			automationId: "auto-nightly-review",
		});

		const fable = sessions.find((s: UnifiedSession) => s.id === "bks-fable-orchestrator");
		expect(fable).toMatchObject({
			id: "bks-fable-orchestrator",
			repo: "backstage",
			model: "claude-fable-5",
			projectId: "prj-demo",
		});
	});

	it("deduplicates Codex sessions by thread id and keeps dropped ids as aliases", async () => {
		writeSession("bks-codex-shared-thread", {
			title: "Backstage Codex thread",
			repo: "backstage",
			model: "gpt-5.5",
			codexThreadId: "codex-thread-shared",
		});
		writeSlackSession("C123-1719860000.000000", {
			branch: "codex-thread-branch",
			userId: "Michael",
			worktreeDir: "/home/ubuntu/projects/tella-backstage",
			claudeSessionId: null,
			codexThreadId: "codex-thread-shared",
			model: "gpt-5.5",
			channel: "C123",
			threadTs: "1719860000.000000",
			createdAt: "2026-07-02T18:01:00.000Z",
			lastActivity: "2026-07-02T18:01:00.000Z",
		});

		const { getAllSessions } = await import(`./sessions.ts?test=${crypto.randomUUID()}`);
		const sessions = getAllSessions();
		const matches = sessions.filter(
			(s: UnifiedSession) => s.codexThreadId === "codex-thread-shared",
		);

		expect(matches).toHaveLength(1);
		expect(matches[0]).toMatchObject({
			id: "bks-codex-shared-thread",
			source: "backstage",
			aliasIds: ["slack-C123-1719860000.000000"],
		});
	});

	it("resolves engine transcript paths for Claude and Codex sessions", async () => {
		const { getEngineTranscriptPath, getTranscriptPath, engineSessionPatch } = await import(
			`./sessions.ts?test=${crypto.randomUUID()}`
		);

		const cwd = "/home/ubuntu/projects/tella-backstage";
		expect(getEngineTranscriptPath(cwd, "claude-session-1", "claude")).toBe(
			getTranscriptPath(cwd, "claude-session-1"),
		);
		expect(engineSessionPatch("claude", "claude-session-1")).toEqual({
			claudeSessionId: "claude-session-1",
		});

		const threadId = uuidV7ForDate("2026-07-02T18:30:00.000Z");
		const rolloutDir = join(home, ".codex", "sessions", "2026", "07", "02");
		mkdirSync(rolloutDir, { recursive: true });
		const rolloutPath = join(
			rolloutDir,
			`rollout-2026-07-02T18-30-00-${threadId}.jsonl`,
		);
		writeFileSync(rolloutPath, "");

		expect(getEngineTranscriptPath(cwd, threadId, "codex")).toBe(rolloutPath);
		expect(engineSessionPatch("codex", threadId)).toEqual({
			codexThreadId: threadId,
		});
		expect({
			claudeSessionId: "claude-session-1",
			...engineSessionPatch("codex", threadId),
		}).toEqual({
			claudeSessionId: "claude-session-1",
			codexThreadId: threadId,
		});
	});

	it("falls back to the other engine transcript when the active provider has none", async () => {
		const codexThreadId = uuidV7ForDate("2026-07-02T18:45:00.000Z");
		const rolloutDir = join(home, ".codex", "sessions", "2026", "07", "02");
		mkdirSync(rolloutDir, { recursive: true });
		const rolloutPath = join(
			rolloutDir,
			`rollout-2026-07-02T18-45-00-${codexThreadId}.jsonl`,
		);
		writeFileSync(rolloutPath, "");
		writeSession("bks-switched-back-to-claude", {
			title: "Switched back to Claude before Claude transcript exists",
			model: "claude-fable-5",
			claudeSessionId: "missing-claude-transcript",
			codexThreadId,
		});

		const claudeDir = join(
			home,
			".claude",
			"projects",
			"-home-ubuntu-projects-tella-backstage",
		);
		mkdirSync(claudeDir, { recursive: true });
		const claudePath = join(claudeDir, "claude-only-transcript.jsonl");
		writeFileSync(claudePath, "");
		writeSession("bks-switched-to-codex", {
			title: "Switched to Codex before Codex transcript exists",
			model: "gpt-5.5",
			claudeSessionId: "claude-only-transcript",
			codexThreadId: "missing-codex-rollout",
		});

		const { getAllSessions } = await import(`./sessions.ts?test=${crypto.randomUUID()}`);
		const sessions = getAllSessions();

		expect(
			sessions.find((s: UnifiedSession) => s.id === "bks-switched-back-to-claude")
				?.transcriptPath,
		).toBe(rolloutPath);
		expect(
			sessions.find((s: UnifiedSession) => s.id === "bks-switched-to-codex")
				?.transcriptPath,
		).toBe(claudePath);
	});

	it("removes a submitted review from the cached sidebar request immediately", async () => {
		writeFileSync(
			join(home, ".opensession-pr-cache.json"),
			JSON.stringify({
				version: 3,
				repos: {
					backstage: {
						"review-cache": {
							url: "https://github.com/tellahq/backstage/pull/123",
							state: "OPEN",
							number: 123,
							title: "Review cache test",
							isDraft: false,
							additions: 1,
							deletions: 0,
							changedFiles: 1,
							reviewDecision: "",
							author: "jfrolich",
							createdAt: "2026-07-27T09:00:00.000Z",
							updatedAt: "2026-07-27T09:00:00.000Z",
							checks: { total: 0, passed: 0, failed: 0, pending: 0 },
							mergeable: "MERGEABLE",
							reviewRequested: ["kent"],
							reviewedBy: [],
							assignees: [],
						},
					},
				},
				recentLimits: { backstage: 500 },
				probeEtags: {},
				lastFullRefresh: {},
			}),
		);
		writeSession("bks-review-cache", {
			title: "Review cache test",
			repo: "backstage",
			branch: "review-cache",
			startedBy: "Jaap",
		});

		const sessionsModule = await import(`./sessions.ts?test=${crypto.randomUUID()}`);
		sessionsModule.markCachedPrReviewed(
			"tellahq/backstage",
			"review-cache",
			"kent",
			"COMMENT",
		);

		expect(sessionsModule.getOpenPrs()[0]?.reviewRequested).toEqual([]);
		expect(
			sessionsModule
				.getAllSessions()
				.find((session: UnifiedSession) => session.id === "bks-review-cache")
				?.prReviewedBy,
		).toEqual(["kent"]);
	});
});
