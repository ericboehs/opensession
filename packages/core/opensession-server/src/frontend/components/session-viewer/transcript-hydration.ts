import type { TranscriptIndexedRange } from "../../lib/transcript-index";

export interface TranscriptHydrationOutlineItem {
	key: string;
	ranges: readonly TranscriptIndexedRange[];
}

/**
 * Missing payload can only move the opening viewport when its structural range
 * lies between rows in the virtualizer's near-visible window. Missing ranges
 * before or after that window are proven above or below the fold and do not
 * need to hold the transcript curtain.
 *
 * `null` means the virtualizer has not reported a usable window yet. An empty
 * array means the window is fully hydrated and safe to reveal.
 */
export function visibleTranscriptHydrationDemand(
	outline: readonly TranscriptHydrationOutlineItem[],
	visibleKeys: ReadonlySet<string>,
	hasPayload: (entryId: string) => boolean,
): TranscriptIndexedRange[] | null {
	let firstVisible = -1;
	let lastVisible = -1;
	for (let index = 0; index < outline.length; index++) {
		const item = outline[index];
		if (!item || !visibleKeys.has(item.key)) continue;
		if (firstVisible === -1) firstVisible = index;
		lastVisible = index;
	}
	if (firstVisible === -1) return null;

	const wanted: TranscriptIndexedRange[] = [];
	const seen = new Set<string>();
	for (let index = firstVisible; index <= lastVisible; index++) {
		for (const range of outline[index]?.ranges ?? []) {
			if (range.entryIds.every(hasPayload)) continue;
			const key = `${range.firstSeq}:${range.lastSeq}`;
			if (seen.has(key)) continue;
			seen.add(key);
			wanted.push(range);
		}
	}
	return wanted;
}
