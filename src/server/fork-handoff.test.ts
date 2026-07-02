import { describe, expect, it } from "bun:test";
import {
	buildForkHandoffNote,
	buildEngineSwitchHandoffNote,
} from "./fork-handoff";
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

describe("buildEngineSwitchHandoffNote", () => {
	it("bridges the conversation when a fresh target engine takes over", () => {
		const note = buildEngineSwitchHandoffNote({
			fromModel: "claude-fable-5",
			fromProvider: "claude",
			toProvider: "codex",
			targetResuming: false,
			entries: [
				entry("u1", "user", "Implement the parser."),
				entry("t1", "tool_use", "Using Edit"),
				entry("a1", "assistant", "Here is the plan."),
			],
		});

		expect(note).toContain("Engine handoff");
		expect(note).toContain("switched mid-conversation from claude-fable-5 (claude)");
		expect(note).toContain("continuing the *same* session");
		expect(note).toContain("- User: Implement the parser.");
		expect(note).toContain("- Assistant: Here is the plan.");
		// Tool calls are omitted — only conversational turns bridge.
		expect(note).not.toContain("Using Edit");
		// Fresh target gets the full-conversation framing, not the resume framing.
		expect(note).toContain("treat the transcript below as the conversation so far");
	});

	it("uses resume framing when the target remembers its own earlier turns", () => {
		const note = buildEngineSwitchHandoffNote({
			fromProvider: "codex",
			toProvider: "claude",
			targetResuming: true,
			entries: [entry("a1", "assistant", "Codex did the migration.")],
		});

		expect(note).toContain("switched mid-conversation from codex to you");
		expect(note).toContain("you remember the conversation up to the switch");
		expect(note).toContain("- Assistant: Codex did the migration.");
	});

	it("degrades gracefully with no transcript entries", () => {
		const note = buildEngineSwitchHandoffNote({
			fromProvider: "claude",
			toProvider: "codex",
			entries: [],
		});
		expect(note).toContain("No prior transcript entries were available.");
	});
});
