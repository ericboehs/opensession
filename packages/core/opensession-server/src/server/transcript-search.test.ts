import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TranscriptStore } from "./transcript-store";
import { transcriptEntryMatchSnippet } from "./transcript-search";
import { searchStoredTranscripts } from "./transcript-search-worker";
import type { TranscriptEntry } from "./types";

describe("transcript search", () => {
	let root = "";
	let path = "";
	let store: TranscriptStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "transcript-search-"));
		path = join(root, "transcripts.db");
		store = new TranscriptStore(path);
	});

	afterEach(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});

	function entry(
		id: string,
		content: string,
		extra: Partial<TranscriptEntry> = {},
	): TranscriptEntry {
		return {
			id,
			type: "assistant",
			content,
			...extra,
			timestamp: extra.timestamp ?? "2026-08-20T10:00:00Z",
		};
	}

	test("matches visible text in requested session order", () => {
		store.appendTranscriptEvents("newer", [
			entry("tool", "Ran a command", {
				type: "tool_use",
				toolInput: { command: "echo NEEDLE" },
			}),
		]);
		store.appendTranscriptEvents("older", [entry("answer", "The needle is here")]);
		store.appendTranscriptEvents("metadata", [entry("needle-only-id", "Nothing visible")]);

		const result = searchStoredTranscripts({
			dbPath: path,
			query: "needle",
			sessionIds: ["newer", "older", "metadata"],
		});
		expect(result.matches.map((match) => match.id)).toEqual(["newer", "older"]);
		expect(result.matches[0].snippet).toContain("NEEDLE");
		expect(result.searchedSessions).toBe(3);
	});

	test("respects the result cap", () => {
		store.appendTranscriptEvents("one", [entry("a", "shared phrase")]);
		store.appendTranscriptEvents("two", [entry("b", "shared phrase")]);
		expect(
			searchStoredTranscripts({
				dbPath: path,
				query: "shared phrase",
				sessionIds: ["one", "two"],
				maxMatches: 1,
			}).matches.map((match) => match.id),
		).toEqual(["one"]);
	});

	test("builds one-line context around a match", () => {
		expect(
			transcriptEntryMatchSnippet(
				entry("a", `before ${"x".repeat(80)}\nNeedle\tafter`),
				"needle",
				12,
			),
		).toMatch(/^….*Needle after$/);
	});
});
