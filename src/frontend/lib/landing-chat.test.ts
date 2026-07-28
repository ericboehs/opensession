import { describe, expect, test } from "bun:test";
import {
	chatNeverRan,
	defaultChatWorkspaceView,
	mainChat,
	pinMainChatFirst,
	pickLandingChat,
} from "./landing-chat";
import type { UnifiedSession } from "./types";

function chat(over: Partial<UnifiedSession>): UnifiedSession {
	return {
		id: "bks-x",
		claudeSessionId: null,
		source: "backstage",
		title: "New chat",
		createdAt: "2026-07-01T00:00:00.000Z",
		lastActivity: "2026-07-01T00:00:00.000Z",
		isRunning: false,
		transcriptPath: null,
		...over,
	} as UnifiedSession;
}

describe("chatNeverRan", () => {
	test("true for an untouched New chat shell", () => {
		expect(chatNeverRan(chat({}))).toBe(true);
	});
	test("false once an engine session exists", () => {
		expect(chatNeverRan(chat({ claudeSessionId: "ses_1" }))).toBe(false);
	});
	test("false while running or queued", () => {
		expect(chatNeverRan(chat({ isRunning: true }))).toBe(false);
		expect(chatNeverRan(chat({ queuedCount: 1 }))).toBe(false);
	});
	test("false once activity moved past creation", () => {
		expect(
			chatNeverRan(chat({ lastActivity: "2026-07-02T00:00:00.000Z" })),
		).toBe(false);
	});
});

describe("defaultChatWorkspaceView", () => {
	test("chat-less PR-backed workspaces land on Review", () => {
		expect(defaultChatWorkspaceView({ key: "ghpr-4972" }, false, false)).toBe(
			"review",
		);
		expect(defaultChatWorkspaceView({ prNumber: 4972 }, false, false)).toBe(
			"review",
		);
	});

	test("PR workspaces with chats, plain workspaces, and dismissed Review tabs land on chat", () => {
		expect(
			defaultChatWorkspaceView({ key: "ghpr-4972" }, false, true),
		).toBeNull();
		expect(
			defaultChatWorkspaceView({ key: "plain-th_123" }, false, false),
		).toBeNull();
		expect(
			defaultChatWorkspaceView({ key: "ghpr-4972" }, true, false),
		).toBeNull();
	});
});

describe("mainChat", () => {
	test("prefers the oldest human chat that actually ran", () => {
		const review = chat({
			id: "bks-ghpr-42-review",
			projectId: "prj-1",
			automation: "github-pr-review",
			claudeSessionId: "review-run",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
		const shell = chat({
			id: "shell",
			projectId: "prj-1",
			createdAt: "2026-07-02T00:00:00.000Z",
			lastActivity: "2026-07-02T00:00:00.000Z",
		});
		const human = chat({
			id: "human",
			projectId: "prj-1",
			claudeSessionId: "human-run",
			createdAt: "2026-07-03T00:00:00.000Z",
		});
		expect(mainChat([review, shell, human])?.id).toBe("human");
	});

	test("pins the main chat ahead of a persisted sibling order", () => {
		const main = chat({ id: "main", claudeSessionId: "main-run" });
		const sibling = chat({
			id: "sibling",
			claudeSessionId: "sibling-run",
			createdAt: "2026-07-02T00:00:00.000Z",
		});
		expect(pinMainChatFirst([main, sibling], ["sibling", "main"])).toEqual([
			"main",
			"sibling",
		]);
	});
});

describe("pickLandingChat", () => {
	const prj = "prj-1";
	test("oldest live chat with content wins", () => {
		const a = chat({
			id: "a",
			projectId: prj,
			claudeSessionId: "ses_a",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
		const b = chat({
			id: "b",
			projectId: prj,
			claudeSessionId: "ses_b",
			createdAt: "2026-07-02T00:00:00.000Z",
		});
		expect(pickLandingChat([b, a], prj)?.id).toBe("a");
	});
	test("empty shell loses to archived history (lost-history bug)", () => {
		const shell = chat({
			id: "shell",
			projectId: prj,
			createdAt: "2026-07-23T00:00:00.000Z",
			lastActivity: "2026-07-23T00:00:00.000Z",
		});
		const real = chat({
			id: "real",
			projectId: prj,
			claudeSessionId: "ses_r",
			archived: true,
			createdAt: "2026-07-01T00:00:00.000Z",
			lastActivity: "2026-07-10T00:00:00.000Z",
		});
		expect(pickLandingChat([shell, real], prj)?.id).toBe("real");
	});
	test("newest archived conversation wins among archived", () => {
		const older = chat({
			id: "older",
			projectId: prj,
			claudeSessionId: "s1",
			archived: true,
			lastActivity: "2026-07-05T00:00:00.000Z",
		});
		const newer = chat({
			id: "newer",
			projectId: prj,
			claudeSessionId: "s2",
			archived: true,
			lastActivity: "2026-07-10T00:00:00.000Z",
		});
		expect(pickLandingChat([older, newer], prj)?.id).toBe("newer");
	});
	test("a shell still wins when the workspace has no history anywhere", () => {
		const shell = chat({ id: "shell", projectId: prj });
		expect(pickLandingChat([shell], prj)?.id).toBe("shell");
	});
	test("remembered chat wins over the oldest live chat", () => {
		const a = chat({
			id: "a",
			projectId: prj,
			claudeSessionId: "ses_a",
			createdAt: "2026-07-01T00:00:00.000Z",
		});
		const b = chat({
			id: "b",
			projectId: prj,
			claudeSessionId: "ses_b",
			createdAt: "2026-07-02T00:00:00.000Z",
		});
		expect(pickLandingChat([a, b], prj, "b")?.id).toBe("b");
	});
	test("a stale remembered id (archived / other workspace) falls back", () => {
		const live = chat({ id: "live", projectId: prj, claudeSessionId: "s1" });
		const gone = chat({
			id: "gone",
			projectId: prj,
			claudeSessionId: "s2",
			archived: true,
		});
		expect(pickLandingChat([live, gone], prj, "gone")?.id).toBe("live");
		expect(pickLandingChat([live], prj, "elsewhere")?.id).toBe("live");
	});
	test("legacy hidden chats and other workspaces are ignored", () => {
		const side = chat({
			id: "side",
			projectId: prj,
			claudeSessionId: "s",
			sideChatOf: "parent",
		});
		const other = chat({
			id: "other",
			projectId: "prj-2",
			claudeSessionId: "s",
		});
		expect(pickLandingChat([side, other], prj)).toBeUndefined();
	});
});
