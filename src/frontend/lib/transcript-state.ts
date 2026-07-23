import type { TranscriptEntry } from "./types";

function time(entry: TranscriptEntry): number {
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Authoritative transcript ordering: v2 rows use immutable seq; legacy and
 * synthetic decorations fall back to timestamp while preserving stable ties. */
export function orderTranscriptEntries(
	entries: TranscriptEntry[],
): TranscriptEntry[] {
	const sequenced = entries
		.filter((entry) => entry.seq !== undefined)
		.sort((a, b) => a.seq! - b.seq!);
	if (!sequenced.length) {
		return entries
			.map((entry, index) => ({ entry, index }))
			.sort((a, b) => time(a.entry) - time(b.entry) || a.index - b.index)
			.map(({ entry }) => entry);
	}
	// Synthetic decorations have no seq. Insert them by timestamp around the
	// immutable seq spine without ever allowing timestamps to reorder v2 rows.
	const result = [...sequenced];
	const decorations = entries
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => entry.seq === undefined)
		.sort((a, b) => time(a.entry) - time(b.entry) || a.index - b.index);
	for (const { entry } of decorations) {
		const index = result.findIndex((candidate) => time(candidate) > time(entry));
		result.splice(index === -1 ? result.length : index, 0, entry);
	}
	return result;
}

/** Last-write-wins by id, but never let a delayed frame overwrite a newer
 * changeSeq. V2 output is always in seq order; legacy keeps arrival order. */
export function mergeTranscriptEntries(
	previous: TranscriptEntry[],
	incoming: TranscriptEntry[],
	v2 = false,
): TranscriptEntry[] {
	if (!incoming.length) return previous;
	const indexById = new Map(previous.map((entry, index) => [entry.id, index]));
	const next = [...previous];
	for (const entry of incoming) {
		const index = indexById.get(entry.id);
		if (index === undefined) {
			indexById.set(entry.id, next.length);
			next.push(entry);
			continue;
		}
		const current = next[index];
		if (
			current.changeSeq !== undefined &&
			entry.changeSeq !== undefined &&
			entry.changeSeq < current.changeSeq
		) {
			continue;
		}
		next[index] = entry;
	}
	return v2 ? orderTranscriptEntries(next) : next;
}
