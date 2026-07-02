import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "./types";

let home: string;
let priorHome: string | undefined;

beforeEach(() => {
	priorHome = process.env.HOME;
	home = join(tmpdir(), `backstage-sessions-test-${crypto.randomUUID()}`);
	process.env.HOME = home;
	mkdirSync(join(home, ".backstage-chats"), { recursive: true });
});

afterEach(() => {
	if (priorHome === undefined) delete process.env.HOME;
	else process.env.HOME = priorHome;
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

describe("getAllSessions", () => {
	it("keeps Codex worker sessions visible even when they have no workspace", async () => {
		writeSession("bks-codex-worker", {
			title: "Codex worker with no workspace",
			repo: "backstage",
			model: "gpt-5.5",
			codexThreadId: "codex-thread-1",
			projectId: null,
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
		});

		const fable = sessions.find((s: UnifiedSession) => s.id === "bks-fable-orchestrator");
		expect(fable).toMatchObject({
			id: "bks-fable-orchestrator",
			repo: "backstage",
			model: "claude-fable-5",
			projectId: "prj-demo",
		});
	});
});
