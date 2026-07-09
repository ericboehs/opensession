import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
let oldJournal: string | undefined;
let oldForceLimit: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "backstage-run-journal-test-"));
	oldJournal = process.env.BACKSTAGE_RUN_JOURNAL;
	oldForceLimit = process.env.MICHAEL_FORCE_LIMIT;
	process.env.BACKSTAGE_RUN_JOURNAL = join(dir, "active-runs.json");
});

afterEach(() => {
	if (oldJournal === undefined) delete process.env.BACKSTAGE_RUN_JOURNAL;
	else process.env.BACKSTAGE_RUN_JOURNAL = oldJournal;
	if (oldForceLimit === undefined) delete process.env.MICHAEL_FORCE_LIMIT;
	else process.env.MICHAEL_FORCE_LIMIT = oldForceLimit;
	rmSync(dir, { recursive: true, force: true });
});

describe("run journal", () => {
	it("preserves human-confirmed tool policy across restart drains", async () => {
		const mod = await import(`./run-journal.ts?journal=${crypto.randomUUID()}`);
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

	it("emits recovered run stream events during restart resume", async () => {
		process.env.MICHAEL_FORCE_LIMIT = "1";
		const journal = await import(`./run-journal.ts?journal=${crypto.randomUUID()}`);
		journal.journalSet({
			runKey: "run-2",
			bksSessionId: "bks-2",
			claudeSessionId: "engine-2",
			prompt: "continue",
			cwd: "/tmp",
			model: "claude-fable-5",
			startedAt: "2026-07-02T00:00:00.000Z",
		});

		const agent = await import(`./agent-runner.ts?resume=${crypto.randomUUID()}`);
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
