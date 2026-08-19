import { describe, expect, test } from "bun:test";
import { sandboxEnvironmentInvalidationNeeded } from "./pr-webhook";

describe("sandbox environment webhook invalidation", () => {
	test("accepts only actual default-branch source updates", () => {
		expect(
			sandboxEnvironmentInvalidationNeeded(
				"push",
				{ ref: "refs/heads/main" },
				"main",
			),
		).toBe(true);
		expect(
			sandboxEnvironmentInvalidationNeeded(
				"push",
				{ ref: "refs/heads/feature" },
				"main",
			),
		).toBe(false);
		expect(
			sandboxEnvironmentInvalidationNeeded(
				"pull_request",
				{
					action: "closed",
					pull_request: { merged: true, base: { ref: "main" } },
				},
				"main",
			),
		).toBe(true);
	});

	test("does not invalidate for ordinary default-branch workflow activity", () => {
		expect(
			sandboxEnvironmentInvalidationNeeded(
				"workflow_run",
				{ workflow_run: { head_branch: "main" } },
				"main",
			),
		).toBe(false);
		expect(
			sandboxEnvironmentInvalidationNeeded(
				"check_run",
				{ check_run: { check_suite: { head_branch: "main" } } },
				"main",
			),
		).toBe(false);
	});
});
