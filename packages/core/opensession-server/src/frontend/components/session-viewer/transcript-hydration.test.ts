import { describe, expect, test } from "bun:test";
import type { TranscriptIndexedRange } from "../../lib/transcript-index";
import {
	visibleTranscriptHydrationDemand,
	type TranscriptHydrationOutlineItem,
} from "./transcript-hydration";

function range(key: string, seq: number, entryIds = [key]): TranscriptIndexedRange {
	return {
		key,
		firstSeq: seq,
		lastSeq: seq,
		entryIds,
		estimateSize: 100,
		startTimestampMs: seq,
		endTimestampMs: seq,
		headRole: "user",
		reviewPrNumber: null,
		reviewRounds: 0,
	};
}

const ranges = [range("above", 1), range("visible", 2), range("below", 3)];
const outline: TranscriptHydrationOutlineItem[] = ranges.map((item) => ({
	key: item.key,
	ranges: [item],
}));

describe("visible transcript hydration", () => {
	test("settles when every range in the near-visible window is loaded", () => {
		const loaded = new Set(["above", "visible", "below"]);
		expect(
			visibleTranscriptHydrationDemand(
				outline,
				new Set(["above", "visible", "below"]),
				(id) => loaded.has(id),
			),
		).toEqual([]);
	});

	test("does not wait for missing data proven above or below the fold", () => {
		expect(
			visibleTranscriptHydrationDemand(
				outline,
				new Set(["visible"]),
				(id) => id === "visible",
			),
		).toEqual([]);
	});

	test("requests missing data between visible rows", () => {
		expect(
			visibleTranscriptHydrationDemand(
				outline,
				new Set(["above", "below"]),
				(id) => id !== "visible",
			),
		).toEqual([ranges[1]]);
	});

	test("waits when a visible structural range is only partially loaded", () => {
		const partial = range("partial", 4, ["loaded", "missing"]);
		expect(
			visibleTranscriptHydrationDemand(
				[{ key: partial.key, ranges: [partial] }],
				new Set([partial.key]),
				(id) => id === "loaded",
			),
		).toEqual([partial]);
	});

	test("does not claim readiness before the virtualizer reports a window", () => {
		expect(
			visibleTranscriptHydrationDemand(outline, new Set(), () => true),
		).toBeNull();
	});
});
