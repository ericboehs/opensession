import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as mod from "./run-journal";
import * as agent from "./agent-runner";

// __setActiveRunsPathForTest repoints the LIVE ACTIVE_RUNS_PATH binding, so
// agent-runner.ts's own (already-cached, possibly earlier-imported-with-the-
// real-HOME) bare import of ./run-journal picks the scratch path up too —
// unlike a plain env-var-before-import, which only affects whichever test
// file happens to trigger the FIRST bare import of ./run-journal in the
// whole `bun test` process (order-dependent, and this file previously
// journaled into — and read back — the developer's real active-runs.json
// when run as part of the full suite).
let dir: string;
let oldJournal: string;
let oldForceLimit: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "backstage-run-journal-test-"));
	oldForceLimit = process.env.MICHAEL_FORCE_LIMIT;
	oldJournal = mod.__setActiveRunsPathForTest(join(dir, "active-runs.json"));
});

afterEach(() => {
	mod.__setActiveRunsPathForTest(oldJournal);
	if (oldForceLimit === undefined) delete process.env.MICHAEL_FORCE_LIMIT;
	else process.env.MICHAEL_FORCE_LIMIT = oldForceLimit;
	rmSync(dir, { recursive: true, force: true });
});

describe("run journal", () => {
	it("fails closed when the journal cannot be persisted", () => {
		const blockedParent = join(dir, "not-a-directory");
		writeFileSync(blockedParent, "blocked");
		mod.__setActiveRunsPathForTest(join(blockedParent, "active-runs.json"));

		expect(() =>
			mod.journalSet({
				runKey: "unpersisted-run",
				cwd: "/tmp",
				startedAt: "2026-07-22T00:00:00.000Z",
			}),
		).toThrow();
	});

	it("does not remove a replacement lock when a stale owner releases", () => {
		const lockPath = join(dir, "active-runs.json.lock");
		mkdirSync(lockPath);
		writeFileSync(join(lockPath, "owner"), "replacement-owner");

		mod.__releaseRunJournalLockForTest(lockPath, "stale-owner");

		expect(existsSync(lockPath)).toBe(true);
		expect(readFileSync(join(lockPath, "owner"), "utf8")).toBe("replacement-owner");
	});

	it("preserves human-confirmed tool policy across restart drains", async () => {
		mod.journalSet({
			runKey: "run-1",
			bksSessionId: "bks-1",
			claudeSessionId: "engine-1",
			prompt: "continue",
			cwd: "/tmp",
			mcpServers: [],
			deniedTools: { mcp__danger__delete: "No deletes" },
			confirmTools: { mcp__stripe__create_refund: "Create a refund" },
			model: "claude-fable-5",
			fallbackModel: "gpt-5.5",
			startedAt: "2026-07-02T00:00:00.000Z",
		});

		const [run] = mod.takeInterruptedRuns();
		expect(run.confirmTools).toEqual({
			mcp__stripe__create_refund: "Create a refund",
		});
		expect(run.deniedTools).toEqual({ mcp__danger__delete: "No deletes" });
		expect(run.fallbackModel).toBe("gpt-5.5");
		expect(mod.activeRunRecords()).toEqual([]);
	});

	it("retains selected interrupted records until asynchronous recovery acknowledges them", () => {
		mod.journalSet({
			runKey: "mac-run",
			bksSessionId: "bks-mac",
			prompt: "continue",
			cwd: "/remote/workspace",
			sandboxId: "macos-bks-mac",
			sandboxProvider: "macos",
			startedAt: "2026-07-22T00:00:00.000Z",
		});

		const [run] = mod.takeInterruptedRuns((record) => record.sandboxProvider === "macos");
		expect(run.runKey).toBe("mac-run");
		expect(mod.activeRunRecords().map((record) => record.runKey)).toEqual(["mac-run"]);
		mod.journalClear("mac-run");
		expect(mod.activeRunRecords()).toEqual([]);
	});

	it("atomically replaces an interrupted run record during recovery handoff", () => {
		mod.journalSet({
			runKey: "old-run",
			bksSessionId: "bks-mac",
			cwd: "/remote/workspace",
			sandboxId: "macos-bks-mac",
			sandboxProvider: "macos",
			startedAt: "2026-07-22T00:00:00.000Z",
		});

		mod.journalReplace("old-run", {
			runKey: "replacement-run",
			bksSessionId: "bks-mac",
			cwd: "/remote/workspace",
			sandboxId: "macos-bks-mac",
			sandboxProvider: "macos",
			startedAt: "2026-07-22T00:01:00.000Z",
		});

		expect(mod.activeRunRecords().map((record) => record.runKey)).toEqual([
			"replacement-run",
		]);
	});

	it("recovers only the newest record from a legacy macOS replacement pair", () => {
		for (const [runKey, startedAt] of [
			["old-run", "2026-07-22T00:00:00.000Z"],
			["replacement-run", "2026-07-22T00:01:00.000Z"],
		] as const) {
			mod.journalSet({
				runKey,
				bksSessionId: "bks-mac",
				cwd: "/remote/workspace",
				sandboxId: "macos-bks-mac",
				sandboxProvider: "macos",
				startedAt,
			});
		}

		const interrupted = mod.takeInterruptedRuns(
			(record) => record.sandboxProvider === "macos",
		);
		expect(interrupted.map((record) => record.runKey)).toEqual(["replacement-run"]);
		expect(mod.activeRunRecords().map((record) => record.runKey)).toEqual([
			"replacement-run",
		]);
	});

	it("emits recovered run stream events during restart resume", async () => {
		process.env.MICHAEL_FORCE_LIMIT = "1";
		mod.journalSet({
			runKey: "run-2",
			bksSessionId: "bks-2",
			claudeSessionId: "engine-2",
			prompt: "continue",
			cwd: "/tmp",
			model: "claude-fable-5",
			startedAt: "2026-07-02T00:00:00.000Z",
		});

		const observed = new Promise<{ id: string; event: unknown }>((resolve) => {
			const resumed = agent.resumeInterruptedRuns(
				undefined,
				undefined,
				undefined,
				undefined,
				(id: string, event: unknown) => resolve({ id, event }),
			);
			expect(resumed).toEqual(["bks-2"]);
		});

		const result = await Promise.race([
			observed,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("resume event callback timed out")), 1000),
			),
		]);

		expect(result).toMatchObject({
			id: "bks-2",
			event: {
				type: "done",
				provider: "opencode",
				model: "opencode/anthropic/claude-fable-5",
				usageLimitExhausted: true,
			},
		});
	});
});
