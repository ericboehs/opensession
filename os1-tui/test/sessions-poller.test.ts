/**
 * Scoping the sidebar. The server's list is the whole fleet's — thousands of
 * automation runs on a busy install — so what `os` chooses to show is the
 * difference between a usable sidebar and a wall of `GitHub (automation)`.
 */

import { describe, expect, test } from "bun:test";
import { Api } from "../src/client/api";
import {
	type Identity,
	identityTokens,
	inScope,
	startedByMe,
} from "../src/client/identity";
import { SessionsPoller } from "../src/client/sessions-poller";
import { fakeServer, fakeSession } from "./fakes";

const HOST = "http://server";

const MINE = fakeSession({ id: "bks-mine", title: "my session", startedBy: "Alice" });
const TEAMMATE = fakeSession({ id: "bks-jaap", title: "jaap's session", startedBy: "Jaap" });
const AUTOMATION = fakeSession({
	id: "bks-auto",
	title: "PR review",
	startedBy: "GitHub (automation)",
	automation: "github-review",
});

async function poll(
	sessions = [MINE, TEAMMATE, AUTOMATION],
	identity: Identity = { name: "Alice Smith", login: "asmith", user: "ubuntu" },
	scope: "mine" | "team" | "all" = "mine",
	explicit = false,
) {
	const api = new Api(HOST, "tok", fakeServer({ sessions }).fetch);
	const poller = new SessionsPoller(api, identity, scope, explicit);
	await poller.start();
	poller.stop();
	return poller;
}

describe("identity matching", () => {
	const tokens = identityTokens({ name: "Alice Smith", login: "asmith" });

	test("a first name matches the full name it came from", () => {
		expect(startedByMe("Alice", tokens)).toBe(true);
		expect(startedByMe("alice smith", tokens)).toBe(true);
		expect(startedByMe("asmith", tokens)).toBe(true);
	});

	test("it does not match a teammate whose name merely starts the same", () => {
		const johnny = identityTokens({ name: "Johnny Lin" });
		expect(startedByMe("John", johnny)).toBe(false);
		expect(startedByMe("John Soutar", johnny)).toBe(false);
		expect(startedByMe("Johnny", johnny)).toBe(true);
	});

	test("placeholder users claim nothing", () => {
		const anonymous = identityTokens({ user: "ubuntu" });
		expect(anonymous.size).toBe(0);
		expect(startedByMe("Alice", anonymous)).toBe(false);
	});

	test("automation runs are out of every scope but `all`", () => {
		const tokens = identityTokens({ name: "Alice Smith" });
		expect(inScope(AUTOMATION, "mine", tokens)).toBe(false);
		expect(inScope(AUTOMATION, "team", tokens)).toBe(false);
		expect(inScope(AUTOMATION, "all", tokens)).toBe(true);
	});
});

describe("the poller's scope", () => {
	test("defaults to my sessions — no automations, no teammates", async () => {
		const poller = await poll();
		const state = poller.getState();
		expect(state.scope).toBe("mine");
		expect(state.sessions.map((s) => s.id)).toEqual(["bks-mine"]);
		expect(state.totalSessions).toBe(3);
	});

	test("cycling widens: mine → team → all", async () => {
		const poller = await poll();
		expect(poller.cycleScope()).toBe("team");
		expect(poller.getState().sessions.map((s) => s.id).sort()).toEqual([
			"bks-jaap",
			"bks-mine",
		]);
		expect(poller.cycleScope()).toBe("all");
		expect(poller.getState().sessions).toHaveLength(3);
		expect(poller.cycleScope()).toBe("mine");
	});

	test("an empty scope widens by itself rather than showing an empty sidebar", async () => {
		// Nobody here is me — the failure mode this guards is a sidebar that
		// looks broken with no hint that a filter is on.
		const poller = await poll([TEAMMATE, AUTOMATION], { name: "Someone Else" });
		const state = poller.getState();
		expect(state.scope).toBe("team");
		expect(state.scopeAuto).toBe(true);
		expect(state.sessions.map((s) => s.id)).toEqual(["bks-jaap"]);
	});

	test("a scope the user picked is never widened for them", async () => {
		const poller = await poll([TEAMMATE, AUTOMATION], { name: "Someone Else" }, "mine", true);
		expect(poller.getState().scope).toBe("mine");
		expect(poller.getState().sessions).toHaveLength(0);
	});

	test("the list is capped, newest first, and says how many it hid", async () => {
		const many = Array.from({ length: 260 }, (_, i) =>
			fakeSession({
				id: `bks-${i}`,
				startedBy: "Alice",
				lastActivity: new Date(Date.now() - i * 60_000).toISOString(),
			}),
		);
		const poller = await poll(many);
		const state = poller.getState();
		expect(state.sessions).toHaveLength(200);
		expect(state.matched).toBe(260);
		expect(state.truncated).toBe(true);
		// Newest survived the cap; the oldest didn't.
		expect(state.sessions.map((s) => s.id)).toContain("bks-0");
		expect(state.sessions.map((s) => s.id)).not.toContain("bks-259");
	});
});
