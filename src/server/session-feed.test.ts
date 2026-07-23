import { describe, expect, test } from "bun:test";
import {
	appendSessionFeed,
	resumeSessionFeed,
	sessionFeedSnapshot,
} from "./session-feed";

describe("session feed", () => {
	test("orders active frames and resumes a true gap", () => {
		const sessionId = `feed-${crypto.randomUUID()}`;
		const start = appendSessionFeed(sessionId, {
			type: "stream_start",
			sessionId,
			by: "Jaap",
		});
		const text = appendSessionFeed(sessionId, {
			type: "stream_text",
			sessionId,
			text: "hello",
		});
		const resumed = resumeSessionFeed(
			sessionId,
			start.feedSeq,
			start.feedEpoch,
		);
		expect(resumed.frames.map((frame) => frame.feedSeq)).toEqual([text.feedSeq]);
		expect(resumed.snapshot.active).toBeNull();
	});

	test("active snapshot contains only text not yet committed", () => {
		const sessionId = `feed-${crypto.randomUUID()}`;
		appendSessionFeed(sessionId, { type: "stream_start", sessionId });
		appendSessionFeed(sessionId, {
			type: "stream_text",
			sessionId,
			text: "landed",
		});
		appendSessionFeed(sessionId, {
			type: "transcript_append",
			sessionId,
			entries: [{ type: "assistant", content: "landed" }],
		});
		expect(sessionFeedSnapshot(sessionId).active?.text).toBe("");
	});

	test("does not replay a completed ephemeral stream", () => {
		const sessionId = `feed-${crypto.randomUUID()}`;
		const start = appendSessionFeed(sessionId, {
			type: "stream_start",
			sessionId,
		});
		appendSessionFeed(sessionId, {
			type: "stream_text",
			sessionId,
			text: "done",
		});
		appendSessionFeed(sessionId, { type: "stream_done", sessionId });
		const resumed = resumeSessionFeed(sessionId, 0, start.feedEpoch);
		expect(resumed.frames).toEqual([]);
		expect(resumed.snapshot.active).toBeNull();
	});
});
