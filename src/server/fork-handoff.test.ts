import { describe, expect, it } from "bun:test";
import { buildForkHandoffNote } from "./fork-handoff";
import type { TranscriptEntry } from "./types";

function entry(id: string, type: TranscriptEntry["type"], content: string): TranscriptEntry {
	return {
		id,
		type,
		content,
		timestamp: "2026-07-02T00:00:00.000Z",
	};
}

describe("buildForkHandoffNote", () => {
	it("summarizes recent user/assistant/system transcript entries for a new engine fork", () => {
		const note = buildForkHandoffNote({
			sourceId: "bks-source",
			sourceTitle: "Investigate Codex support",
			sourceModel: "gpt-5.5",
			entries: [
				entry("u1", "user", "Please inspect this."),
				entry("t1", "tool_use", "Using Bash"),
				entry("a1", "assistant", "I found the issue."),
			],
		});

		expect(note).toContain("bks-source");
		expect(note).toContain("Investigate Codex support");
		expect(note).toContain("gpt-5.5");
		expect(note).toContain("- User: Please inspect this.");
		expect(note).toContain("- Assistant: I found the issue.");
		expect(note).not.toContain("Using Bash");
	});

	it("cuts the transcript at the requested fork message when present", () => {
		const note = buildForkHandoffNote({
			sourceId: "bks-source",
			messageId: "a1",
			entries: [
				entry("u1", "user", "before"),
				entry("a1", "assistant", "fork here"),
				entry("u2", "user", "after"),
			],
		});

		expect(note).toContain("message a1");
		expect(note).toContain("before");
		expect(note).toContain("fork here");
		expect(note).not.toContain("after");
	});
});
