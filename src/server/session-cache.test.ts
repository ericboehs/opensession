import { describe, expect, test } from "bun:test";
import { isLegacySideChat } from "./session-cache";

describe("isLegacySideChat", () => {
	test("recognizes persisted side-chat records", () => {
		expect(isLegacySideChat({ sideChatOf: "bks-parent" })).toBe(true);
	});

	test("keeps ordinary sessions visible", () => {
		expect(isLegacySideChat({})).toBe(false);
		expect(isLegacySideChat({ sideChatOf: null })).toBe(false);
	});
});
