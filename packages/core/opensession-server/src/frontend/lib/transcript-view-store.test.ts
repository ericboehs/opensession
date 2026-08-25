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

	test("publishes durable appends immediately when their index updates with them", () => {
		const originalRaf = globalThis.requestAnimationFrame;
		const originalCancel = globalThis.cancelAnimationFrame;
		globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
		globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
		try {
			const store = new TranscriptViewStore([entry("1")]);
			store.merge([entry("2")]);
			expect(store.getSnapshot().map((item) => item.id)).toEqual(["1"]);
			store.merge([entry("2")], false, true);
			expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2"]);
		} finally {
			globalThis.requestAnimationFrame = originalRaf;
			globalThis.cancelAnimationFrame = originalCancel;
		}
	});

	test("prepends older entries in timestamp order", () => {
		const store = new TranscriptViewStore([entry("2")]);
		store.prepend([entry("1")]);
		expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2"]);
	});

	test("reorders a live tool result when its durable seq arrives", () => {
		const store = new TranscriptViewStore([
			{ ...entry("1"), seq: 1, changeSeq: 1 },
			{ ...entry("3"), seq: 3, changeSeq: 3 },
		]);
		store.merge([{ ...entry("2"), changeSeq: 2 }], false, true);
		expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "3", "2"]);
		store.merge([{ ...entry("2"), seq: 2, changeSeq: 4 }], true, true);
		expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2", "3"]);
	});

	test("rejects delayed mutations and orders v2 entries by immutable seq", () => {
		const store = new TranscriptViewStore([
			{ ...entry("2"), seq: 2, changeSeq: 2 },
		]);
		store.merge([{ ...entry("1"), seq: 1, changeSeq: 3 }], true);
		store.merge(
			[{ ...entry("2"), content: "stale", seq: 2, changeSeq: 1 }],
			true,
		);

		expect(store.getSnapshot().map((item) => item.id)).toEqual(["1", "2"]);
		expect(store.getSnapshot()[1].content).toBe("2");
	});
});
