import type { TranscriptEntry } from "../lib/types";

interface PlacementBlock {
	kind: string;
	entry?: TranscriptEntry;
	items?: TranscriptEntry[];
}

/** The publish_walkthrough tool call, whatever the engine named it. */
function isWalkthroughPublish(entry: TranscriptEntry): boolean {
	return (
		entry.type === "tool_use" &&
		/(^|_)publish_walkthrough$/.test(entry.toolName || "")
	);
}

/**
 * Place a walkthrough after its publishing turn. If that tool call was trimmed
 * from the loaded transcript, use publishedAt to keep it above later turns.
 */
export function walkthroughInsertIndex(
	blocks: PlacementBlock[],
	publishedAt: string,
): number {
	let publishingBlock = -1;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		const hasPublish =
			block.kind === "turn"
				? block.items?.some(isWalkthroughPublish)
				: block.kind === "entry" && block.entry
					? isWalkthroughPublish(block.entry)
					: false;
		if (hasPublish) {
			publishingBlock = i;
			break;
		}
	}

	if (publishingBlock === -1) {
		const publishedTime = new Date(publishedAt).getTime();
		if (!Number.isFinite(publishedTime)) return blocks.length;
		const firstTimedBlock = blocks.findIndex((block) => {
			const entry = block.entry || block.items?.[0];
			return entry && Number.isFinite(new Date(entry.timestamp).getTime());
		});
		if (firstTimedBlock !== -1) {
			const entry =
				blocks[firstTimedBlock].entry || blocks[firstTimedBlock].items?.[0];
			if (entry && new Date(entry.timestamp).getTime() > publishedTime)
				return firstTimedBlock;
		}
		const nextTurn = blocks.findIndex(
			(block) =>
				block.kind === "entry" &&
				(block.entry?.type === "user" || block.entry?.type === "system") &&
				new Date(block.entry.timestamp).getTime() > publishedTime,
		);
		return nextTurn === -1 ? blocks.length : nextTurn;
	}

	let index = publishingBlock + 1;
	while (
		index < blocks.length &&
		(blocks[index].kind === "footer" ||
			(blocks[index].kind === "entry" &&
				blocks[index].entry?.type === "assistant"))
	)
		index++;
	return index;
}
