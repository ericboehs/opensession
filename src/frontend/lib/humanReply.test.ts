import { describe, expect, it } from "bun:test";
import { isGitHubAttribution, parseAttribution, parseReviewHandoff } from "./humanReply";

describe("human reply attribution", () => {
	it("parses bracketed attributions", () => {
		expect(parseAttribution("[Kent] Please check this")).toEqual({
			name: "Kent",
			body: "Please check this",
		});
	});

	it("identifies GitHub automation attributions", () => {
		expect(isGitHubAttribution("GitHub")).toBe(true);
		expect(isGitHubAttribution("GitHub (automation)")).toBe(true);
		expect(isGitHubAttribution("Kent")).toBe(false);
	});
});

describe("review handoff detection", () => {
	it("detects the sentinel form and strips it", () => {
		const parsed = parseReviewHandoff(
			"<!--os:review-handoff-->\n🔍 This session's PR #5109 “Fix previews” (branch `x`) was just reviewed…",
		);
		expect(parsed?.prNumber).toBe(5109);
		expect(parsed?.body.startsWith("🔍 This session's")).toBe(true);
	});

	it("detects pre-sentinel handoffs by their opener", () => {
		const parsed = parseReviewHandoff("🔍 This session's PR #42 “t” was just reviewed…");
		expect(parsed?.prNumber).toBe(42);
	});

	it("ignores other GitHub FYIs", () => {
		expect(parseReviewHandoff("🔀 PR #42 was merged")).toBeNull();
		expect(parseReviewHandoff("plain message")).toBeNull();
	});
});
