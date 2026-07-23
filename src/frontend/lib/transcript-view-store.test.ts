import { describe, expect, test } from "bun:test";
import { TranscriptViewStore } from "./transcript-view-store";
import type { TranscriptEntry } from "./types";

const entry = (id: string, timestamp = `2026-01-01T00:00:0${id}.000Z`): TranscriptEntry => ({
	id,
	type: "assistant",
	content: id,
	timestamp,
});

describe("TranscriptViewStore", () => {
	test("upserts without replacing untouched entries", () => {
		const a = entry("1");
		const b = entry("2");
		const store = new TranscriptViewStore([a, b]);
		const nextB = { ...b, content: "updated" };
		store.merge([nextB]);
		expect(store.getSnapshot()[0]).toBe(a);
		expect(store.getSnapshot()[1]).toBe(nextB);
	});

	test("prepends older entries in timestamp order", () => {
		const store = new TranscriptViewStore([entry("2")]);
		store.prepend([entry("1")]);
		expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2"]);
	});
});
