import { test, expect, describe } from "bun:test";
import { turnTimeoutError, turnTimeoutNotice } from "./opencode-config";

// The frontend colours these lines red by matching their opening words
// (packages/core/protocol/src/notices.ts) — a reword that breaks the match turns a
// dead run back into a grey pill, so the phrasing is pinned here.
describe("turn timeout copy", () => {
	test("says the limit the way a person would", () => {
		expect(turnTimeoutError(180 * 60_000)).toBe(
			"Stopped after 3 hours, the limit for a single turn.",
		);
		expect(turnTimeoutError(60 * 60_000)).toBe(
			"Stopped after 1 hour, the limit for a single turn.",
		);
		expect(turnTimeoutError(90 * 60_000)).toBe(
			"Stopped after 90 minutes, the limit for a single turn.",
		);
	});

	test("the transcript line adds what happens next", () => {
		expect(turnTimeoutNotice(180 * 60_000)).toBe(
			"Stopped after 3 hours, the limit for a single turn. " +
				"Everything up to here is saved; send a message to continue.",
		);
	});

	test("both open with the words the transcript colours on", () => {
		for (const line of [turnTimeoutError(180 * 60_000), turnTimeoutNotice(180 * 60_000)]) {
			expect(line).toMatch(/^Stopped after \d/);
		}
	});
});
