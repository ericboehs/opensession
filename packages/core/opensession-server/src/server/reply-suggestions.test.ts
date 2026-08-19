import { describe, expect, it } from "bun:test";
import {
	MAX_SUGGESTIONS,
	parseSuggestions,
	sanitizeSuggestion,
} from "./reply-suggestions";

describe("sanitizeSuggestion", () => {
	it("keeps a well-formed chip", () => {
		expect(
			sanitizeSuggestion({
				label: "Fix both",
				text: "Fix both the queue race and the stale cache read, then run bun test.",
			}),
		).toEqual({
			label: "Fix both",
			text: "Fix both the queue race and the stale cache read, then run bun test.",
		});
	});

	it("strips quoting, trailing punctuation and collapsed whitespace", () => {
		expect(
			sanitizeSuggestion({ label: '"Ship it."', text: "  Ship  it now.  " }),
		).toEqual({ label: "Ship it", text: "Ship it now." });
	});

	it("replaces an em dash in a label rather than keeping one", () => {
		// The house rule bans them, and a chip is UI copy like any other.
		expect(sanitizeSuggestion({ label: "Fix—both", text: "Fix both." })?.label).toBe(
			"Fix both",
		);
	});

	it("rejects a label that is really a sentence", () => {
		expect(
			sanitizeSuggestion({
				label: "Fix both of the issues you found",
				text: "Fix both.",
			}),
		).toBeNull();
		expect(
			sanitizeSuggestion({ label: "Reconsider the whole approach", text: "Go on." }),
		).toBeNull();
	});

	it("rejects a chip with no label or no instruction behind it", () => {
		expect(sanitizeSuggestion({ label: "", text: "Fix both." })).toBeNull();
		expect(sanitizeSuggestion({ label: "Fix", text: "" })).toBeNull();
		expect(sanitizeSuggestion({ label: "Fix", text: "ok" })).toBeNull();
		expect(sanitizeSuggestion("Fix both")).toBeNull();
		expect(sanitizeSuggestion(null)).toBeNull();
	});
});

describe("parseSuggestions", () => {
	const two = [
		{ label: "Fix both", text: "Fix both issues you listed, then re-run the tests." },
		{ label: "Only step 1", text: "Only fix step 1 for now and stop there." },
	];

	it("parses a clean JSON array", () => {
		expect(parseSuggestions(JSON.stringify(two))).toEqual(two);
	});

	it("tolerates a markdown fence and surrounding narration", () => {
		expect(parseSuggestions("```json\n" + JSON.stringify(two) + "\n```")).toEqual(
			two,
		);
		expect(
			parseSuggestions(`Here are the chips:\n${JSON.stringify(two)}\nHope that helps.`),
		).toEqual(two);
	});

	it("returns nothing for the empty answer, which is the common one", () => {
		expect(parseSuggestions("[]")).toEqual([]);
		expect(parseSuggestions(null)).toEqual([]);
		expect(parseSuggestions("I don't think there is a decision here.")).toEqual([]);
		expect(parseSuggestions("{ not an array }")).toEqual([]);
	});

	it("drops a lone chip: one option is a nudge, not a choice", () => {
		expect(parseSuggestions(JSON.stringify([two[0]]))).toEqual([]);
		// ...including when the second chip was the one that failed validation.
		expect(
			parseSuggestions(
				JSON.stringify([two[0], { label: "A whole sentence of a label here", text: "Go" }]),
			),
		).toEqual([]);
	});

	it("collapses chips that read the same and caps the row", () => {
		expect(
			parseSuggestions(
				JSON.stringify([two[0], { label: "fix both", text: "Different text." }, two[1]]),
			),
		).toEqual(two);
		const many = Array.from({ length: 8 }, (_, i) => ({
			label: `Option ${i}`,
			text: `Take option ${i}, please.`,
		}));
		expect(parseSuggestions(JSON.stringify(many))).toHaveLength(MAX_SUGGESTIONS);
	});
});
