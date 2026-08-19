import { describe, expect, test } from "bun:test";
import {
	shippedChangeOutcome,
	suggestedShippedChangeMessage,
} from "./shipped-change-copy";

describe("suggestedShippedChangeMessage", () => {
	test("turns an imperative PR title into a short team update", () => {
		expect(
			suggestedShippedChangeMessage("Adopt the OpenSession toggle style", "tella-fusion"),
		).toBe("The toggle style is now updated in Tella.");
	});

	test("does not repeat the product name", () => {
		expect(suggestedShippedChangeMessage("Update Tella's toggle style", "tella-fusion")).toBe(
			"Tella's toggle style is now updated.",
		);
	});

	test("turns a visibility title into an outcome", () => {
		expect(suggestedShippedChangeMessage("Show background names via tooltips", "tella-fusion")).toBe(
			"Background names are now visible via tooltips in Tella.",
		);
	});

	test("turns a naming title into a product outcome", () => {
		expect(suggestedShippedChangeMessage("Name built-in video backgrounds", "tella-fusion")).toBe(
			"Built-in video backgrounds now have names in Tella.",
		);
	});

	test("keeps an unfamiliar title declarative and editable", () => {
		expect(suggestedShippedChangeMessage("Toggle polish", "tella-fusion")).toBe(
			"Toggle polish is now available in Tella.",
		);
	});

	test("prefers the first outcome from a walkthrough summary", () => {
		expect(
			suggestedShippedChangeMessage(
				"Update backgrounds",
				"tella-fusion",
				"Backgrounds now have names that are visible via tooltips.\n\nVerified on mobile.",
			),
		).toBe("Backgrounds now have names that are visible via tooltips.");
		expect(shippedChangeOutcome("Deployment is live — Background names now appear on hover."))
			.toBe("Background names now appear on hover.");
	});

	test("uses an implementation summary to name the concrete outcome", () => {
		expect(
			suggestedShippedChangeMessage(
				"Name built-in video backgrounds",
				"tella-fusion",
				"Updated all 40 to their real macOS release names and variants, including:\n\n- Mac Tahoe Beach Dawn",
			),
		).toBe(
			"All 40 built-in video backgrounds now use their real macOS release names and variants.",
		);
	});
});
