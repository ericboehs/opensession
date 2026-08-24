import { describe, expect, test } from "bun:test";
import { expectedUiPrefsMatch, maxValueLength } from "./ui-prefs";

describe("UI preference limits", () => {
	test("repository orders can hold a large configured repo list", () => {
		const order = JSON.stringify(
			Array.from({ length: 100 }, (_, index) =>
				`repository-${index}-${"x".repeat(40)}`,
			),
		);
		expect(order.length).toBeGreaterThan(200);
		expect(order.length).toBeLessThanOrEqual(maxValueLength("repo-order"));
	});

	test("keyboard shortcut maps can hold account bindings", () => {
		const shortcuts = JSON.stringify(
			Object.fromEntries(
				Array.from({ length: 25 }, (_, index) => [
					`command-${index}`,
					[`mod+shift+f${(index % 24) + 1}`],
				]),
			),
		);
		expect(shortcuts.length).toBeGreaterThan(200);
		expect(shortcuts.length).toBeLessThanOrEqual(maxValueLength("shortcuts"));
	});

	test("recent models can hold twelve routed model IDs", () => {
		const recents = JSON.stringify(
			Array.from(
				{ length: 12 },
				(_, index) => `pi/provider-${index}/configured-model-${index}`,
			),
		);
		expect(recents.length).toBeGreaterThan(200);
		expect(recents.length).toBeLessThanOrEqual(maxValueLength("recent-models"));
	});

	test("ordinary scalar preferences remain tightly bounded", () => {
		expect(maxValueLength("turn-activity")).toBe(200);
	});

	test("conditional patches reject a stale legacy preference snapshot", () => {
		const current = { "turn-activity": "auto", "tool-calls": "open" };
		expect(
			expectedUiPrefsMatch(current, {
				"turn-activity": "auto",
				"tool-calls": null,
			}),
		).toBeFalse();
		expect(
			expectedUiPrefsMatch(current, {
				"turn-activity": "auto",
				"tool-calls": "open",
			}),
		).toBeTrue();
	});
});
