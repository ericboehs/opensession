import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	makeAskHandler,
	pendingAsks,
	pendingAskTimers,
	restorePendingAsks,
	settleRestoredAskAfterRecovery,
} from "./asks";
import { sessionWatchers } from "./ws-hub";

const SESSION = "os-pending-ask-restart-test";
const QUESTION = {
	header: "Choice",
	question: "Which option?",
	options: [{ label: "One" }, { label: "Two" }],
};

let scratch = "";

function resetState(): void {
	for (const timer of pendingAskTimers.values()) clearTimeout(timer.handle);
	pendingAskTimers.clear();
	pendingAsks.clear();
	sessionWatchers.delete(SESSION);
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = "";
}

afterEach(resetState);

describe("pending ask restart persistence", () => {
	test("restores the card and keeps the original escalation deadline", () => {
		scratch = mkdtempSync(join(tmpdir(), "os-asks-restart-"));
		const storePath = join(scratch, "pending-asks.json");
		const askedAt = Date.now() - 60_000;
		writeFileSync(
			storePath,
			JSON.stringify({
				asks: [
					{
						sessionId: SESSION,
						questionId: "q-restored",
						questions: [QUESTION],
						askedAt,
					},
					{
						sessionId: "os-deleted",
						questionId: "q-stale",
						questions: [QUESTION],
						askedAt,
					},
				],
			}),
		);
		const sent: unknown[] = [];
		sessionWatchers.set(
			SESSION,
			new Set([
				{
					data: { watchingSessionId: SESSION, user: "Test" },
					send: (payload: string) => sent.push(JSON.parse(payload)),
				} as never,
			]),
		);

		expect(
			restorePendingAsks({
				storePath,
				now: askedAt + 60_000,
				sessionExists: (id) => id === SESSION,
			}),
		).toBe(1);
		expect(pendingAsks.get(SESSION)).toMatchObject({
			questionId: "q-restored",
			askedAt,
			restored: true,
		});
		expect(pendingAskTimers.get(SESSION)?.dueAt).toBe(askedAt + 4 * 60_000);
		expect(sent).toContainEqual({
			type: "ask_question",
			sessionId: SESSION,
			questionId: "q-restored",
			questions: [QUESTION],
		});
		const persisted = JSON.parse(readFileSync(storePath, "utf8"));
		expect(persisted.asks.map((ask: { sessionId: string }) => ask.sessionId)).toEqual([
			SESSION,
		]);
	});

	test("a re-emitted engine ask adopts the restored card and live promise", async () => {
		scratch = mkdtempSync(join(tmpdir(), "os-asks-adopt-"));
		const storePath = join(scratch, "pending-asks.json");
		const askedAt = Date.now();
		writeFileSync(
			storePath,
			JSON.stringify({
				asks: [
					{
						sessionId: SESSION,
						questionId: "q-same",
						questions: [QUESTION],
						askedAt,
					},
				],
			}),
		);
		restorePendingAsks({ storePath, sessionExists: () => true });

		const resultPromise = makeAskHandler(SESSION)({ questions: [QUESTION] });
		await Bun.sleep(0);
		expect(pendingAsks.get(SESSION)).toMatchObject({
			questionId: "q-same",
			askedAt,
		});
		expect(pendingAsks.get(SESSION)?.restored).toBeUndefined();
		pendingAsks.get(SESSION)?.resolve({ "Which option?": "Two" });

		expect(await resultPromise).toEqual({
			behavior: "allow",
			updatedInput: {
				questions: [QUESTION],
				answers: { "Which option?": "Two" },
			},
		});
		expect(pendingAsks.has(SESSION)).toBe(false);
		expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({ asks: [] });
	});

	test("an answer before adoption resolves the re-emitted tool call", async () => {
		scratch = mkdtempSync(join(tmpdir(), "os-asks-early-answer-"));
		const storePath = join(scratch, "pending-asks.json");
		writeFileSync(
			storePath,
			JSON.stringify({
				asks: [
					{
						sessionId: SESSION,
						questionId: "q-early",
						questions: [QUESTION],
						askedAt: Date.now(),
					},
				],
			}),
		);
		restorePendingAsks({ storePath, sessionExists: () => true });
		pendingAsks.get(SESSION)?.resolve({ "Which option?": "One" });

		expect(pendingAsks.get(SESSION)).toMatchObject({
			questionId: "q-early",
			answerReceived: true,
			earlyAnswer: { "Which option?": "One" },
		});
		const persisted = JSON.parse(readFileSync(storePath, "utf8"));
		expect(persisted.asks[0]).toMatchObject({
			questionId: "q-early",
			answerReceived: true,
			earlyAnswer: { "Which option?": "One" },
		});
		for (const timer of pendingAskTimers.values()) clearTimeout(timer.handle);
		pendingAskTimers.clear();
		pendingAsks.clear();
		const sent: unknown[] = [];
		sessionWatchers.set(
			SESSION,
			new Set([
				{
					data: { watchingSessionId: SESSION, user: "Test" },
					send: (payload: string) => sent.push(JSON.parse(payload)),
				} as never,
			]),
		);
		restorePendingAsks({ storePath, sessionExists: () => true });
		expect(pendingAsks.get(SESSION)).toMatchObject({
			answerReceived: true,
			earlyAnswer: { "Which option?": "One" },
		});
		expect(pendingAskTimers.has(SESSION)).toBe(false);
		expect(sent).not.toContainEqual(expect.objectContaining({ type: "ask_question" }));

		expect(await makeAskHandler(SESSION)({ questions: [QUESTION] })).toEqual({
			behavior: "allow",
			updatedInput: {
				questions: [QUESTION],
				answers: { "Which option?": "One" },
			},
		});
		expect(pendingAsks.has(SESSION)).toBe(false);
		expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({ asks: [] });
	});

	test("retires a restored card when recovery ends without adopting it", () => {
		scratch = mkdtempSync(join(tmpdir(), "os-asks-terminal-"));
		const storePath = join(scratch, "pending-asks.json");
		writeFileSync(
			storePath,
			JSON.stringify({
				asks: [
					{
						sessionId: SESSION,
						questionId: "q-terminal",
						questions: [QUESTION],
						askedAt: Date.now(),
					},
				],
			}),
		);
		restorePendingAsks({ storePath, sessionExists: () => true });

		settleRestoredAskAfterRecovery(SESSION);

		expect(pendingAsks.has(SESSION)).toBe(false);
		expect(pendingAskTimers.has(SESSION)).toBe(false);
		expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({ asks: [] });
	});
});
