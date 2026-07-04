import { describe, expect, it } from "bun:test";
import { isGitHubAttribution, parseAttribution } from "./humanReply";

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
