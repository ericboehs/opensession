import React from "react";
import type { TranscriptEntry } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { TurnBlock } from "./TurnBlock";

type RenderBlock =
	| { kind: "entry"; entry: TranscriptEntry }
	| { kind: "turn"; items: TranscriptEntry[] };

interface Props {
	entries: TranscriptEntry[];
	/** Whether the conversation is live (last work block shows a spinner / stays open). */
	live?: boolean;
	/** Assistant messages show a "Fork from here" action when provided. */
	onFork?: (entryId: string) => void;
	/** Called when a Task/Agent block's "Open sub-agent" affordance is clicked. */
	onOpenSubagent?: (agentId: string, label: string) => void;
	/** Session owner (startedBy) — credited on un-attributed user turns. */
	owner?: string;
}

/**
 * Groups a flat transcript into per-turn fold blocks and message bubbles, then
 * renders them. A turn's working (tool calls + intermediate assistant notes)
 * folds into one collapsed TurnBlock; only the turn's final answer stays out
 * as a normal bubble — so the chat reads question → answer, calm by default.
 * Shared by the main session view and the sub-agent sidebar so both render
 * identically.
 */
// Memoized: the transcript is expensive to render (markdown parsing + code
// highlighting across every bubble/work block), and unrelated SessionViewer
// re-renders — most notably toggling the workspace panel on/off — would
// otherwise re-render the whole thing synchronously and stall the interaction.
// With stable props (entries reference unchanged, callbacks memoized upstream)
// this bails out entirely on a panel toggle. See SessionViewer's useCallbacks.
export const TranscriptBlocks = React.memo(function TranscriptBlocks({
	entries,
	live,
	onFork,
	onOpenSubagent,
	owner,
}: Props) {
	// Build tool_use → tool_result map
	const toolResults = new Map<string, TranscriptEntry>();
	for (const e of entries) {
		if (e.type === "tool_result" && e.toolUseId)
			toolResults.set(e.toolUseId, e);
	}

	const blocks: RenderBlock[] = [];
	// The current assistant turn: consecutive assistant/tool_use entries between
	// user/system boundaries, accumulated then flushed as one fold.
	let turn: TranscriptEntry[] = [];

	const flushTurn = () => {
		if (turn.length === 0) return;
		if (!turn.some((e) => e.type === "tool_use")) {
			// Plain answer(s), nothing to fold.
			for (const e of turn) blocks.push({ kind: "entry", entry: e });
		} else {
			// The turn's final answer (when it ended with one) stays visible;
			// everything before it folds. A turn still mid-tools folds entirely.
			const last = turn[turn.length - 1];
			const final = last.type === "assistant" ? last : null;
			const folded = final ? turn.slice(0, -1) : turn;
			if (folded.length > 0) blocks.push({ kind: "turn", items: folded });
			if (final) blocks.push({ kind: "entry", entry: final });
		}
		turn = [];
	};

	for (const entry of entries) {
		if (entry.type === "tool_result") {
			continue; // rendered inside turn blocks via toolResults
		} else if (entry.type === "assistant" || entry.type === "tool_use") {
			turn.push(entry);
		} else {
			flushTurn();
			blocks.push({ kind: "entry", entry });
		}
	}
	flushTurn();

	return (
		<>
			{blocks.map((block, i) =>
				block.kind === "turn" ? (
					<TurnBlock
						key={block.items[0].id}
						items={block.items}
						toolResults={toolResults}
						live={Boolean(live) && i === blocks.length - 1}
						onOpenSubagent={onOpenSubagent}
					/>
				) : (
					<MessageBubble
						key={block.entry.id}
						entry={block.entry}
						onFork={onFork}
						owner={owner}
					/>
				),
			)}
		</>
	);
});
