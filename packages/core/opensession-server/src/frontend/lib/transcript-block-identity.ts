type TranscriptEntryIdentity = { id: string };

/**
 * A mounted live turn keeps the identity of its first entry while later steps
 * append. This is separate from its scroll anchor, which follows the tail.
 */
export function turnMountKey(
	entries: readonly TranscriptEntryIdentity[],
): string {
	const first = entries[0];
	if (!first) throw new Error("Turn blocks require at least one entry");
	return first.id;
}

/** How many tail positions count as the live edge for arrival animation. A
 * turn block, its answer, and its footer can mount in one build, so the window
 * covers the trio; anything further back is history, not an arrival. */
const TAIL_ARRIVAL_WINDOW = 3;

/**
 * Keys of blocks that mounted at the live edge since the previous build, and so
 * should play the arrival fade. The first build (null previous) seeds without
 * animating: opening a session or hydrating history is not an arrival.
 */
export function newTailBlockKeys(
	previous: ReadonlySet<string> | null,
	keys: readonly string[],
): string[] {
	if (!previous) return [];
	const fresh: string[] = [];
	for (
		let index = Math.max(0, keys.length - TAIL_ARRIVAL_WINDOW);
		index < keys.length;
		index++
	) {
		const key = keys[index];
		if (key && !previous.has(key)) fresh.push(key);
	}
	return fresh;
}

/**
 * History hydration can prepend entries to a partially loaded turn. Its last
 * entry remains stable through that operation, so the scroll hold anchors here.
 */
export function turnScrollAnchor(
	entries: readonly TranscriptEntryIdentity[],
): string {
	const last = entries[entries.length - 1];
	if (!last) throw new Error("Turn blocks require at least one entry");
	return `${last.id}#turn`;
}
