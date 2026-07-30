import { describe, expect, test } from "bun:test";
import { isOutdatedReviewComment } from "./pr-comments";

describe("isOutdatedReviewComment", () => {
	test("recognizes current and legacy superseded review markers", () => {
		expect(isOutdatedReviewComment("<!-- os-review-outdated -->\n<details>...</details>")).toBe(true);
		expect(isOutdatedReviewComment("<!-- michael-review-outdated -->\n<details>...</details>")).toBe(true);
	});

	test("keeps active reviews and ordinary comments", () => {
		expect(isOutdatedReviewComment("<!-- os-review -->\n## Review")).toBe(false);
		expect(isOutdatedReviewComment("Please update this error message.")).toBe(false);
	});
});
