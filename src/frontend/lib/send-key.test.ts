import { describe, expect, test } from "bun:test";
import { isSendCombo } from "./send-key";

const key = (overrides: Partial<Parameters<typeof isSendCombo>[0]> = {}) => ({
	key: "Enter",
	shiftKey: false,
	metaKey: false,
	ctrlKey: false,
	...overrides,
});

describe("isSendCombo", () => {
	test("accepts plain and modified Enter with the default preference", () => {
		expect(isSendCombo(key(), "enter")).toBe(true);
		expect(isSendCombo(key({ metaKey: true }), "enter")).toBe(true);
		expect(isSendCombo(key({ ctrlKey: true }), "enter")).toBe(true);
	});

	test("keeps Shift+Enter as a newline with the default preference", () => {
		expect(isSendCombo(key({ shiftKey: true }), "enter")).toBe(false);
	});

	test("requires modified Enter when that preference is selected", () => {
		expect(isSendCombo(key(), "mod-enter")).toBe(false);
		expect(isSendCombo(key({ metaKey: true }), "mod-enter")).toBe(true);
		expect(isSendCombo(key({ ctrlKey: true }), "mod-enter")).toBe(true);
	});
});
