import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
let oldJournal: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "backstage-run-journal-test-"));
	oldJournal = process.env.BACKSTAGE_RUN_JOURNAL;
	process.env.BACKSTAGE_RUN_JOURNAL = join(dir, "active-runs.json");
});

afterEach(() => {
	if (oldJournal === undefined) delete process.env.BACKSTAGE_RUN_JOURNAL;
	else process.env.BACKSTAGE_RUN_JOURNAL = oldJournal;
	rmSync(dir, { recursive: true, force: true });
});

describe("run journal", () => {
	it("preserves human-confirmed tool policy across restart drains", async () => {
		const mod = await import(`./claude-runner.ts?journal=${crypto.randomUUID()}`);
		mod.journalSet({
			runKey: "run-1",
			bksSessionId: "bks-1",
			claudeSessionId: "engine-1",
			prompt: "continue",
			cwd: "/tmp",
			mcpServers: [],
			deniedTools: { mcp__danger__delete: "No deletes" },
			confirmTools: { mcp__stripe__create_refund: "Create a refund" },
			startedAt: "2026-07-02T00:00:00.000Z",
		});

		const [run] = mod.takeInterruptedRuns();
		expect(run.confirmTools).toEqual({
			mcp__stripe__create_refund: "Create a refund",
		});
		expect(run.deniedTools).toEqual({ mcp__danger__delete: "No deletes" });
		expect(mod.activeRunRecords()).toEqual([]);
	});
});
