import { describe, expect, test } from "bun:test";
import { maxValueLength } from "./ui-prefs";

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

	test("ordinary scalar preferences remain tightly bounded", () => {
		expect(maxValueLength("turn-activity")).toBe(200);
	});
});
