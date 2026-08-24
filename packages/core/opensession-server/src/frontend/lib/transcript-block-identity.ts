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
