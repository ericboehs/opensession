import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
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
		// Returned records carry no claim stamp…
		expect(run.claimedAt).toBeUndefined();
		// …but the on-disk record survives as CLAIMED (not wiped) until the
		// resume outcome re-registers or clears it, so a restart that kills the
		// sweep mid-reattach hands the run to the next boot instead of losing it.
		const [claimed] = mod.activeRunRecords();
		expect(claimed.runKey).toBe("run-1");
		expect(claimed.claimedAt).toBeTruthy();
		// The same process never takes an already-claimed run twice.
		expect(mod.takeInterruptedRuns()).toEqual([]);
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
