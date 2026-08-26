import { describe, expect, test } from "bun:test";
import { AUTO_REPO, NO_REPO } from "./session-repo";
import { newSessionDefaultRepo } from "./new-session-repo";

describe("newSessionDefaultRepo", () => {
	test("starts in Scratch when no repositories are registered", () => {
		expect(newSessionDefaultRepo([], AUTO_REPO)).toBe(NO_REPO);
	});

	test("keeps an available workspace choice", () => {
		expect(
			newSessionDefaultRepo(
				[
					{ id: "app", default: true },
					{ id: "docs" },
				],
				"docs",
			),
		).toBe("docs");
	});

	test("falls back to the registered default", () => {
		expect(
			newSessionDefaultRepo(
				[
					{ id: "app", default: true },
					{ id: "docs" },
				],
				"missing",
			),
		).toBe("app");
	});
});
