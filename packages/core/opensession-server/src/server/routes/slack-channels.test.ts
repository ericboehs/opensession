import { describe, expect, test } from "bun:test";
import { defaultSlackChannel } from "./slack-channels";

describe("Slack channel selection", () => {
	test("prefers engineering regardless of configured order or case", () => {
		expect(defaultSlackChannel([
			{ id: "C1", name: "product" },
			{ id: "C2", name: "Engineering" },
		])).toBe("C2");
	});

	test("falls back to the first configured channel", () => {
		expect(defaultSlackChannel([
			{ id: "C1", name: "product" },
			{ id: "C2", name: "general" },
		])).toBe("C1");
		expect(defaultSlackChannel([])).toBeUndefined();
	});
});
