import { describe, expect, test } from "bun:test";
import {
	markPendingStarted,
	type OptimisticPendingPrompt,
	PENDING_GIVE_UP_MS,
	reconcilePending,
} from "./pending-reconcile";

const SENT = 1_000_000;
const bubble = (id: string, content: string, user?: string) => ({
	id,
	content,
	user,
	sentAt: SENT,
});
const entry = (content: string, at = SENT) => ({
	type: "user",
	content,
	timestamp: new Date(at).toISOString(),
});

describe("markPendingStarted", () => {
	const started: OptimisticPendingPrompt = {
		id: "outbox-a",
		content: "ship it",
		user: "michiel",
		sentAt: SENT,
	};

	test("moves a stale busy send from the queue back to the transcript", () => {
		expect(
			markPendingStarted([{ ...started, busyMode: "queue" as const }], started),
		).toEqual([{ ...started, serverStarted: true }]);
	});

	test("restores a bubble claimed by the transient admission queue", () => {
		expect(markPendingStarted([], started)).toEqual([
			{ ...started, serverStarted: true },
		]);
	});

	test("leaves an already-confirmed transcript bubble alone", () => {
		const current = [{ ...started, serverStarted: true as const }];
		expect(markPendingStarted(current, started)).toBe(current);
	});
});

describe("reconcilePending", () => {
	test("a transcript user entry claims its bubble as landed", () => {
		const { landed, expired } = reconcilePending(
			[bubble("outbox-a", "ship it")],
			[entry("ship it")],
			[],
			SENT,
		);
		expect([...landed]).toEqual(["outbox-a"]);
		expect(expired.size).toBe(0);
	});

	test("a queue or steer echo claims its bubble", () => {
		const { landed } = reconcilePending(
			[bubble("outbox-a", "ship it")],
			[],
			[{ content: "ship it" }],
			SENT,
		);
		expect([...landed]).toEqual(["outbox-a"]);
	});

	test("a transient queue echo does not claim a server-started bubble", () => {
		const { landed } = reconcilePending(
			[{ ...bubble("outbox-a", "ship it"), serverStarted: true }],
			[],
			[{ content: "ship it" }],
			SENT,
		);
		expect(landed.size).toBe(0);
	});

	test("the transcript still claims a server-started bubble", () => {
		const { landed } = reconcilePending(
			[{ ...bubble("outbox-a", "ship it"), serverStarted: true }],
			[entry("ship it")],
			[{ content: "ship it" }],
			SENT,
		);
		expect([...landed]).toEqual(["outbox-a"]);
	});

	test("claims are one-to-one: one entry cannot claim two identical bubbles", () => {
		const { landed } = reconcilePending(
			[bubble("outbox-a", "again"), bubble("outbox-b", "again")],
			[entry("again")],
			[],
			SENT,
		);
		expect(landed.size).toBe(1);
	});

	test("the server's attribution prefix still claims the raw bubble", () => {
		const { landed } = reconcilePending(
			[bubble("outbox-a", "ship it", "michiel")],
			[entry("[michiel] ship it")],
			[],
			SENT,
		);
		expect([...landed]).toEqual(["outbox-a"]);
	});

	test("co-released steers joined into one turn claim every bubble", () => {
		const { landed } = reconcilePending(
			[
				bubble("outbox-a", "first", "michiel"),
				bubble("outbox-b", "second", "michiel"),
			],
			[entry("[michiel] first\n\n[michiel] second")],
			[],
			SENT,
		);
		expect(landed.size).toBe(2);
	});

	test("an entry recorded well before the send does not claim it", () => {
		const { landed } = reconcilePending(
			[bubble("outbox-a", "ship it")],
			[entry("ship it", SENT - 60_000)],
			[],
			SENT,
		);
		expect(landed.size).toBe(0);
	});

	test("an unclaimed bubble expires rather than landing", () => {
		const { landed, expired } = reconcilePending(
			[bubble("outbox-a", "ship it")],
			[],
			[],
			SENT + PENDING_GIVE_UP_MS,
		);
		expect(landed.size).toBe(0);
		expect([...expired]).toEqual(["outbox-a"]);
	});

	test("a young unclaimed bubble is neither landed nor expired", () => {
		const { landed, expired } = reconcilePending(
			[bubble("outbox-a", "ship it")],
			[],
			[],
			SENT + 1_000,
		);
		expect(landed.size).toBe(0);
		expect(expired.size).toBe(0);
	});

	test("non-user entries never claim a bubble", () => {
		const { landed } = reconcilePending(
			[bubble("outbox-a", "ship it")],
			[{ type: "assistant", content: "ship it", timestamp: new Date(SENT).toISOString() }],
			[],
			SENT,
		);
		expect(landed.size).toBe(0);
	});
});
