import { expect, test } from "bun:test";
import type { TranscriptEntry } from "../lib/types";
import { walkthroughInsertIndex } from "./walkthrough-placement";

const entry = (
	id: string,
	type: TranscriptEntry["type"],
	timestamp: string,
	toolName?: string,
): TranscriptEntry => ({ id, type, timestamp, toolName, content: "" });

test("uses publishedAt when the publishing call is outside the loaded window", () => {
	const blocks = [
		{
			kind: "entry",
			entry: entry("answer", "assistant", "2026-07-24T21:41:00Z"),
		},
		{
			kind: "entry",
			entry: entry("later", "user", "2026-07-24T22:00:00Z"),
		},
	];

	expect(
		walkthroughInsertIndex(blocks, "2026-07-24T21:43:01Z"),
	).toBe(1);
});

test("puts an older walkthrough at the top of a newer transcript window", () => {
	const blocks = [
		{
			kind: "entry",
			entry: entry("answer", "assistant", "2026-07-24T21:55:00Z"),
		},
		{
			kind: "entry",
			entry: entry("later", "user", "2026-07-24T22:00:00Z"),
		},
	];

	expect(
		walkthroughInsertIndex(blocks, "2026-07-24T21:43:01Z"),
	).toBe(0);
});

test("keeps the exact publishing turn authoritative", () => {
	const blocks = [
		{
			kind: "turn",
			items: [
				entry(
					"publish",
					"tool_use",
					"2026-07-24T21:43:01Z",
					"opensession-walkthrough_publish_walkthrough",
				),
			],
		},
		{
			kind: "entry",
			entry: entry("answer", "assistant", "2026-07-24T21:44:00Z"),
		},
		{ kind: "footer" },
		{
			kind: "entry",
			entry: entry("later", "user", "2026-07-24T22:00:00Z"),
		},
	];

	expect(
		walkthroughInsertIndex(blocks, "2026-07-24T21:43:01Z"),
	).toBe(3);
});
