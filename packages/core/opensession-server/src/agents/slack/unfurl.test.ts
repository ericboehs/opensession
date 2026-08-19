import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { UnifiedSession } from "../../server/types";

// Unfurl modules resolve their state directory and UI host at import.
const scratch = mkdtempSync(join(tmpdir(), "opensession-unfurl-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const previousUiBase = process.env.OPENSESSION_UI_BASE;
const previousCardBase = process.env.OPENSESSION_SESSION_CARD_BASE;
const previousCardSecret = process.env.OPENSESSION_SESSION_CARD_SECRET;
process.env.OPENSESSION_STATE_DIR = scratch;
process.env.OPENSESSION_UI_BASE = "https://os.example.test";
process.env.OPENSESSION_SESSION_CARD_BASE = "https://media.example.test";
process.env.OPENSESSION_SESSION_CARD_SECRET = "test-session-social-card-secret-32-bytes";

const { cardTitle, handleLinkShared, unfurlForSession } = await import("./unfurl");

afterAll(() => {
	if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
	else process.env.OPENSESSION_STATE_DIR = previousStateDir;
	if (previousUiBase === undefined) delete process.env.OPENSESSION_UI_BASE;
	else process.env.OPENSESSION_UI_BASE = previousUiBase;
	if (previousCardBase === undefined)
		delete process.env.OPENSESSION_SESSION_CARD_BASE;
	else process.env.OPENSESSION_SESSION_CARD_BASE = previousCardBase;
	if (previousCardSecret === undefined)
		delete process.env.OPENSESSION_SESSION_CARD_SECRET;
	else process.env.OPENSESSION_SESSION_CARD_SECRET = previousCardSecret;
	rmSync(scratch, { recursive: true, force: true });
});

describe("unfurlForSession", () => {
	test("includes the dynamic social card image", () => {
		const unfurl = unfurlForSession(
			session({ id: "sess-card", title: "Ship the card", createdBy: "Kent" }),
			"https://os.example.test/session/sess-card",
		);
		expect(unfurl.blocks).toContainEqual({
			type: "image",
			image_url: expect.stringMatching(
				/^https:\/\/media\.example\.test\/session-card\/sess-card\/[A-Za-z0-9_-]{32}\.png\?v=3$/,
			),
			alt_text: "Ship the card, an Open Session by Kent",
		});
	});
});

describe("handleLinkShared", () => {
	test("sends the generated attachment to chat.unfurl", async () => {
		const calls: Array<{ method: string; params: Record<string, any> }> = [];
		const s = session({ id: "sess-card", title: "Ship the card", createdBy: "Kent" });
		await handleLinkShared(
			{
				channel: "C1",
				message_ts: "1700000000.000100",
				links: [{ url: "https://os.example.test/session/sess-card" }],
			},
			{
				findSession: async () => s,
				unfurl: async (method, params) => {
					calls.push({ method, params });
					return { ok: true };
				},
			},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("chat.unfurl");
		expect(calls[0].params.channel).toBe("C1");
		expect(Object.keys(calls[0].params.unfurls)).toEqual([
			"https://os.example.test/session/sess-card",
		]);
	});

	test("rejects when Slack refuses the attachment", async () => {
		const s = session({ id: "sess-card", title: "Ship the card" });
		expect(
			handleLinkShared(
				{
					channel: "C1",
					message_ts: "1700000000.000100",
					links: [{ url: "https://os.example.test/session/sess-card" }],
				},
				{
					findSession: async () => s,
					unfurl: async () => ({ ok: false, error: "cannot_parse_attachment" }),
				},
			),
		).rejects.toThrow("Slack chat.unfurl failed: cannot_parse_attachment");
	});
});

function session(patch: Partial<UnifiedSession>): UnifiedSession {
	return {
		id: "sess-1",
		lastActivity: new Date().toISOString(),
		...patch,
	} as UnifiedSession;
}

describe("cardTitle", () => {
	test("uses the session title even when it belongs to a workspace", () => {
		expect(
			cardTitle(session({ title: "Fix the seek bar", workspaceId: "ws-1" })),
		).toEqual({ title: "Fix the seek bar" });
	});

	test("uses the session title when there is no workspace", () => {
		expect(cardTitle(session({ title: "Triage the ticket" }))).toEqual({
			title: "Triage the ticket",
		});
	});

	test("falls back when the workspace id no longer resolves", () => {
		expect(
			cardTitle(session({ title: "Triage the ticket", workspaceId: "ws-gone" })),
		).toEqual({ title: "Triage the ticket" });
	});

	test("falls back to the session id when the session is untitled", () => {
		expect(cardTitle(session({ id: "sess-42" }))).toEqual({ title: "sess-42" });
	});
});
