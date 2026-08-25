import type { TranscriptEntry } from "./types";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { personKey } from "./review-queue";

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

const normalizedLegacyVoiceEntries = new WeakMap<
	TranscriptEntry,
	TranscriptEntry
>();

/** Voice actions written before linked tool entries were introduced stored the
 * input in `content` and omitted toolUseId on both rows. Normalize that durable
 * legacy shape so the shared transcript renderer can pair and disclose it. */
export function normalizeLegacyVoiceToolEntries(
	entries: TranscriptEntry[],
): TranscriptEntry[] {
	return entries.map((entry) => {
		const cached = normalizedLegacyVoiceEntries.get(entry);
		if (cached) return cached;
		if (entry.type === "tool_use" && entry.id.startsWith("voice-tu-")) {
			let toolInput = entry.toolInput;
			if (toolInput === undefined) {
				try {
					toolInput = JSON.parse(entry.content);
				} catch {
					toolInput = entry.content;
				}
			}
			if (entry.toolUseId && entry.toolInput !== undefined) return entry;
			const normalized = {
				...entry,
				toolUseId: entry.toolUseId ?? entry.id,
				toolInput,
			};
			normalizedLegacyVoiceEntries.set(entry, normalized);
			return normalized;
		}
		if (entry.type === "tool_result" && entry.id.startsWith("voice-tr-")) {
			if (entry.toolUseId) return entry;
			const normalized = {
				...entry,
				toolUseId: `voice-tu-${entry.id.slice("voice-tr-".length)}`,
			};
			normalizedLegacyVoiceEntries.set(entry, normalized);
			return normalized;
		}
		return entry;
	});
}

/**
 * Read an in-flight message (a queue receipt / steer, which has never been
 * near the server) the way the transcript entry it is about to become will be
 * read: sentinels and "[Name] " prefixes stripped, sender and notice resolved.
 *
 * Same classifier as the durable path, so a message in the queue and the same
 * message a second later in the transcript can't disagree about what it is.
 */
export function classifyQueuedContent(
	content?: string,
	user?: string,
): TranscriptEntry {
	const attributed = user ? `[${user}] ${content ?? ""}` : content ?? "";
	return classifyEntry({
		id: "",
		type: "user",
		content: attributed,
		timestamp: "",
	});
}

/** Model-routing messages can briefly arrive from an older server during a
 * rolling deploy. They drive turns but never belong in the composer queue. */
export function isClientVisibleQueuedContent(
	content?: string,
	user?: string,
): boolean {
	return (
		user !== "auto-continue" &&
		classifyQueuedContent(content, user).notice?.kind !== "workflow"
	);
}

/**
 * Who to credit on a queue chip: a teammate who sent into this session, or a
 * notice's label when that label isn't the whole body.
 *
 * Never the viewer's own name. Every queue item carries a `user` (delivery
 * attribution and edit permission), so without this the person who typed the
 * message reads their own name back on it. The transcript bubble suppresses
 * it the same way.
 */
export function queueAttribution(
	classified: TranscriptEntry,
	currentUser: string,
): string | null {
	const label =
		classified.sender ??
		(classified.notice?.body ? classified.notice.title : null);
	if (!label) return null;
	return personKey(label) === personKey(currentUser) ? null : label;
}
