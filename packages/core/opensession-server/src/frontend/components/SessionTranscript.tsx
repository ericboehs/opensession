import React, { useLayoutEffect, useSyncExternalStore } from "react";
import { renderMarkdown } from "../lib/markdown";
import type { LiveTurnStore } from "../lib/live-turn-store";
import { msgBodyStreaming, msgRow, msgStreamingRow } from "../lib/msg-classes";
import { useOpenAssetPaths } from "../lib/open-asset";
import { cn } from "../ui/cn";
import { MarkdownBody, useMarkdownRepo } from "./MarkdownBody";
import { TranscriptBlocks } from "./TranscriptBlocks";

type TranscriptBlocksProps = React.ComponentProps<typeof TranscriptBlocks>;

type SessionTranscriptProps = Omit<TranscriptBlocksProps, "sessionId"> & {
	sessionId: string;
	liveTurnStore: LiveTurnStore;
	/** Re-measure the host scroll region after the live bubble DOM commits. */
	onLiveLayout?: () => void;
};

/**
 * The durable transcript and the live assistant tail for any session surface.
 * Full sessions and compact session views use this component so markdown,
 * stream reconciliation, and transcript grouping cannot drift apart.
 */
export const SessionTranscript = function SessionTranscript({
	sessionId,
	liveTurnStore,
	onLiveLayout,
	...blocks
}: SessionTranscriptProps) {
	return (
		<>
			<TranscriptBlocks {...blocks} sessionId={sessionId} />
			<StreamingMessage
				store={liveTurnStore}
				sessionId={sessionId}
				onLayout={onLiveLayout}
			/>
		</>
	);
};

function StreamingMessage({
	store,
	sessionId,
	onLayout,
}: {
	store: LiveTurnStore;
	sessionId: string;
	onLayout?: () => void;
}) {
	const snapshot = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getServerSnapshot,
	);
	const repo = useMarkdownRepo();
	const assetPaths = useOpenAssetPaths();
	useLayoutEffect(() => {
		onLayout?.();
	}, [snapshot.revision, onLayout]);
	const html = (snapshot.text
				? renderMarkdown(snapshot.text, { repo, sessionId, assetPaths })
				: "");
	if (!snapshot.text) return null;

	// Always rendered, never raw source: the server cuts frames at block
	// boundaries, so what arrives here is markdown that stands on its own.
	return (
		/* .msg-streaming + .msg-body-assistant stay as hooks: the streaming caret
		   is a ::after on that pair, and the reduced-motion exception names it. */
		<div className={cn(msgRow, msgStreamingRow)}>
			<MarkdownBody className={cn(msgBodyStreaming, "markdown")} html={html} />
		</div>
	);
}
