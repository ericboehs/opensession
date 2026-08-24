import { describe, expect, test } from "bun:test";
import {
	classifyQueuedContent,
	mergeTranscriptEntries,
	normalizeLegacyVoiceToolEntries,
	orderTranscriptEntries,
	queueAttribution,
} from "./transcript-state";
import type { TranscriptEntry } from "./types";

function entry(
	id: string,
	seq: number,
	changeSeq: number,
	content = id,
	timestamp = "2026-07-23T12:00:00.000Z",
): TranscriptEntry {
	return { id, seq, changeSeq, content, timestamp, type: "assistant" };
}

describe("transcript client state", () => {
	test("orders v2 history by seq even when timestamps tie", () => {
		expect(
			orderTranscriptEntries([entry("new", 2, 2), entry("old", 1, 1)]).map(
				(e) => e.id,
			),
		).toEqual(["old", "new"]);
	});

	test("a delayed stale frame cannot overwrite a newer rewrite", () => {
		const result = mergeTranscriptEntries(
			[entry("a", 1, 5, "new")],
			[entry("a", 1, 4, "stale")],
			true,
		);
		expect(result[0].content).toBe("new");
		expect(result[0].changeSeq).toBe(5);
	});

	test("overlapping history updates by id instead of dropping corrections", () => {
		const result = mergeTranscriptEntries(
			[entry("b", 2, 2), entry("c", 3, 3)],
			[entry("a", 1, 1), entry("b", 2, 4, "corrected")],
			true,
		);
		expect(result.map((e) => [e.id, e.content])).toEqual([
			["a", "a"],
			["b", "corrected"],
			["c", "c"],
		]);
	});

	test("replaying a frame is idempotent", () => {
		const frame = [entry("a", 1, 1), entry("b", 2, 2)];
		const once = mergeTranscriptEntries([], frame, true);
		const twice = mergeTranscriptEntries(once, frame, true);
		expect(twice).toEqual(once);
	});

	test("synthetic dividers never let timestamps reorder the seq spine", () => {
		const rewrittenOld = entry(
			"old",
			1,
			5,
			"rewritten",
			"2026-07-23T15:00:00.000Z",
		);
		const newer = entry(
			"new",
			2,
			2,
			"new",
			"2026-07-23T13:00:00.000Z",
		);
		const divider: TranscriptEntry = {
			id: "divider",
			type: "system",
			content: "switched",
			timestamp: "2026-07-23T14:00:00.000Z",
		};
		const ordered = orderTranscriptEntries([newer, divider, rewrittenOld]);
		expect(ordered.filter((e) => e.seq !== undefined).map((e) => e.id)).toEqual([
			"old",
			"new",
		]);
	});

	test("normalizes legacy Desk voice actions into linked tool entries", () => {
		const timestamp = "2026-08-07T12:00:00.000Z";
		const legacy: TranscriptEntry[] = [
			{
				id: "voice-tu-call-1",
				type: "tool_use",
				toolName: "steer_session",
				content: '{"id":"os-1","message":"continue"}',
				timestamp,
			},
			{
				id: "voice-tr-call-1",
				type: "tool_result",
				content: '{"status":"steered"}',
				timestamp,
			},
		];
		const normalized = normalizeLegacyVoiceToolEntries(legacy);

		expect(normalized[0]).toMatchObject({
			toolUseId: "voice-tu-call-1",
			toolInput: { id: "os-1", message: "continue" },
		});
		expect(normalized[1].toolUseId).toBe("voice-tu-call-1");
		expect(normalizeLegacyVoiceToolEntries(legacy)[0]).toBe(normalized[0]);
		expect(normalizeLegacyVoiceToolEntries(normalized)[0]).toBe(normalized[0]);
	});

	test("classifies an attributed queued review without exposing its marker", () => {
		const classified = classifyQueuedContent(
			"<!--os:review-handoff-->\n🔍 This session's PR #42 has feedback",
			"GitHub",
		);

		expect(classified.notice).toMatchObject({
			kind: "review-handoff",
			title: "PR #42 review feedback",
		});
		expect(classified.content).not.toContain("os:review-handoff");
	});

	test("classifies queued peer-session messages as notices", () => {
		const id = "os-01a01e56-a1fc-7000-bb91-bc99b916c4ad";
		for (const content of [
			"Please avoid overlapping edits.",
			"<!--os:session-notice-->\nPlease avoid overlapping edits.",
		]) {
			const classified = classifyQueuedContent(content, `agent ${id}`);
			expect(classified.content).toBe("Please avoid overlapping edits.");
			expect(classified.notice).toMatchObject({
				kind: "session-notice",
				title: "Message from another session",
			});
			expect(queueAttribution(classified, "Grant")).toBe(
				"Message from another session",
			);
		}
	});

	test("credits a teammate on a queue chip but never the viewer", () => {
		const mine = classifyQueuedContent("ship it", "Kent");
		const theirs = classifyQueuedContent("ship it", "Michiel");

		expect(queueAttribution(mine, "Kent de Bruin")).toBeNull();
		expect(queueAttribution(theirs, "Kent de Bruin")).toBe("Michiel");
	});
});
