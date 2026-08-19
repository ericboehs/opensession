import React from "react";
import type { SessionNote, SessionWalkthrough, TranscriptEntry } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { NoteBubble } from "./NoteBubble";
import { ToolSection, TurnBlock } from "./TurnBlock";
import {
	turnTouchedFiles,
	TurnFooter,
	TURN_FOOTER_LIFT,
	type TouchedFile,
} from "./TurnFooter";
import { VirtualTranscriptBlock } from "./VirtualTranscriptBlock";
import { WalkthroughCard } from "./WalkthroughCard";
import { walkthroughInsertIndex } from "./walkthrough-placement";
import { normalizeLegacyVoiceToolEntries } from "../lib/transcript-state";
import { collectWrittenAssets } from "../lib/open-asset";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { ReviewLoopBlock } from "./ReviewLoopBlock";
import type { ReviewLoopResult } from "../lib/review-loop";
import {
	ShippedChangeComposer,
	type ShippedChangeComposerProps,
} from "./ShippedChangeComposer";

type RenderBlock =
	| { kind: "entry"; entry: TranscriptEntry }
	| { kind: "turn"; items: TranscriptEntry[] }
	| {
			kind: "footer";
			entry: TranscriptEntry;
			durationMs: number;
			files: TouchedFile[];
			assets: string[];
	  }
	| { kind: "walkthrough"; walkthrough: SessionWalkthrough }
	| { kind: "note"; note: SessionNote }
	| { kind: "review-loop"; blocks: RenderBlock[]; prNumber: number | null; rounds: number };

interface Props {
	entries: TranscriptEntry[];
	/** Whether the conversation is live (last work block shows a spinner / stays open). */
	live?: boolean;
	/** Assistant messages show a "Fork from here" action when provided. */
	onFork?: (entryId: string) => void;
	/** Your own sent messages can be reopened in the composer when provided. */
	onEditMessage?: (entry: TranscriptEntry) => void;
	/** Starts a turn that picks the work back up after a run failed. Offered on
	 *  the last block only: an older failure has already been moved past, and a
	 *  Continue button on it would restart work the session went on to do. */
	onContinue?: () => void;
	/** Called when a Task/Agent block's "Open sub-agent" affordance is clicked. */
	onOpenSubagent?: (agentId: string, label: string) => void;
	/** Session owner (startedBy) — credited on un-attributed user turns. */
	owner?: string;
	/** Lets wire-clamped entries' "Show full message" fetch the full content. */
	sessionId?: string;
	/** Agent-published walkthrough — rendered inline where it was published.
	 *  Pass a referentially stable object (see SessionViewer) so the memo holds. */
	walkthrough?: SessionWalkthrough;
	/** Team notes (src/server/session-notes.ts) interleaved into the timeline
	 *  by timestamp. Agent-invisible; rendered as NoteBubbles. */
	notes?: SessionNote[];
	slackShare?: ShippedChangeComposerProps & {
		prNumber: number;
	};
	/** The current PR verdict, rendered on the final review loop's own row. */
	reviewResult?: ReviewLoopResult;
	/** Preview/test hook; the session viewer leaves review loops folded. */
	reviewLoopsOpen?: boolean;
}

type ReviewBlockRole =
	| { kind: "handoff"; prNumber: number | null }
	| { kind: "user-message" }
	| { kind: "other" };

/** The same classification that chooses MessageBubble's presentation also
 * decides whether a row starts or ends a review phase. Several operational
 * notices have a legacy `type: "user"` wire shape, so the raw type alone
 * cannot distinguish a person's request from status plumbing. */
function reviewBlockRole(block: RenderBlock): ReviewBlockRole {
	if (block.kind !== "entry") return { kind: "other" };
	const entry = classifyEntry(block.entry);
	if (entry.notice?.kind === "review-handoff") {
		const match = entry.notice.title.match(/PR #(\d+)/);
		return { kind: "handoff", prNumber: match ? Number(match[1]) : null };
	}
	return entry.type === "user" && !entry.notice
		? { kind: "user-message" }
		: { kind: "other" };
}

/** A review handoff and the agent work it triggers form one quiet phase. A
 * real user message always ends it, so people never lose their own request in
 * a collapsed automation trail. */
function groupReviewLoops(blocks: RenderBlock[]): RenderBlock[] {
	const grouped: RenderBlock[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const first = blocks[i];
		const firstRole = reviewBlockRole(first);
		if (firstRole.kind !== "handoff") {
			grouped.push(first);
			continue;
		}
		const loop: RenderBlock[] = [first];
		let rounds = 1;
		let prNumber = firstRole.prNumber;
		while (i + 1 < blocks.length) {
			const next = blocks[i + 1];
			const nextRole = reviewBlockRole(next);
			// Notes and walkthroughs have their own placement and must never vanish
			// inside an automation disclosure.
			if (next.kind === "note" || next.kind === "walkthrough") break;
			// A normal user message is a new conversation phase. A second review
			// handoff belongs to this loop and starts its next round.
			if (nextRole.kind === "user-message") break;
			i++;
			loop.push(next);
			if (nextRole.kind === "handoff") {
				rounds++;
				prNumber ??= nextRole.prNumber;
			}
		}
		grouped.push({ kind: "review-loop", blocks: loop, prNumber, rounds });
	}
	return grouped;
}

function mergedNoticePrNumber(entry: TranscriptEntry): number | null {
	if (entry.notice?.kind !== "system") return null;
	// Both merge wordings session-notify.ts has shipped: today's
	// "PR #12 merged by …", and the older "PR #12 “title” was merged into main".
	const match = entry.content.match(/\bPR #(\d+)\b(?:.*\bwas)? merged\b/i);
	return match ? Number(match[1]) : null;
}

// How many blocks at the end of the transcript are never windowed. The reader
// lands here on open and stays here while a turn runs, so these keep their real
// content and their real height rather than a measured placeholder.
//
// It counts GROUPED blocks, which is the array actually rendered: a review loop
// swallows the blocks it contains, so measuring the window against the flat
// `blocks` array shrank it by however many rows those loops absorbed. Measured
// on the biggest session in the store (9,689 entries, 3 review loops), the
// trailing window came out as 1 block instead of 24.
const TRAILING_MOUNTED_BLOCKS = 24;

/**
 * Groups a flat transcript into per-turn fold blocks and message bubbles, then
 * renders them. A turn's working (tool calls + intermediate assistant notes)
 * folds into one collapsed TurnBlock; only the turn's final answer stays out
 * as a normal bubble — so the session reads question → answer, calm by default.
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
	onEditMessage,
	onContinue,
	onOpenSubagent,
	owner,
	sessionId,
	walkthrough,
	notes,
	slackShare,
	reviewResult,
	reviewLoopsOpen,
}: Props) {
	const renderedEntries = normalizeLegacyVoiceToolEntries(entries);
	const shareAfterEntryIds = new Set<string>();
	if (slackShare) {
		for (let i = 0; i < renderedEntries.length; i++) {
			if (mergedNoticePrNumber(renderedEntries[i]) !== slackShare.prNumber) continue;
			let targetId = renderedEntries[i].id;
			for (let j = i + 1; j < renderedEntries.length; j++) {
				const candidate = renderedEntries[j];
				if (candidate.type === "user" || candidate.type === "system") break;
				if (candidate.type === "assistant") targetId = candidate.id;
			}
			shareAfterEntryIds.add(targetId);
		}
	}
	// Build tool_use → tool_result map
	const toolResults = new Map<string, TranscriptEntry>();
	for (const e of renderedEntries) {
		if (e.type === "tool_result" && e.toolUseId)
			toolResults.set(e.toolUseId, e);
	}

	const blocks: RenderBlock[] = [];
	// The current assistant turn: consecutive assistant/tool_use entries between
	// user/system boundaries, accumulated then flushed as one fold.
	let turn: TranscriptEntry[] = [];

	const flushTurn = (trailing = false) => {
		if (turn.length === 0) return;
		const last = turn[turn.length - 1];
		const final = last.type === "assistant" ? last : null;
		if (!turn.some((e) => e.type === "tool_use")) {
			// Plain answer(s), nothing to fold.
			for (const e of turn) blocks.push({ kind: "entry", entry: e });
		} else {
			// The turn's final answer (when it ended with one) stays visible;
			// everything before it folds. A turn still mid-tools folds entirely.
			const folded = final ? turn.slice(0, -1) : turn;
			if (folded.length > 0) blocks.push({ kind: "turn", items: folded });
			if (final) blocks.push({ kind: "entry", entry: final });
		}
		// Quiet actions under the settled answer, the files the turn wrote, and
		// scratch files that have no other direct route from the transcript.
		if (final && !(live && trailing)) {
			blocks.push({
				kind: "footer",
				entry: final,
				durationMs:
					new Date(final.timestamp).getTime() -
					new Date(turn[0].timestamp).getTime(),
				files: turnTouchedFiles(turn),
				assets: collectWrittenAssets(turn),
			});
		}
		turn = [];
	};

	for (const entry of renderedEntries) {
		if (entry.type === "tool_result") {
			continue; // rendered inside turn blocks via toolResults
		} else if (entry.type === "assistant" || entry.type === "tool_use") {
			turn.push(entry);
		} else {
			flushTurn();
			blocks.push({ kind: "entry", entry });
		}
	}
	flushTurn(true);

	if (walkthrough)
		blocks.splice(walkthroughInsertIndex(blocks, walkthrough), 0, {
			kind: "walkthrough",
			walkthrough,
		});

	// Interleave team notes by timestamp: each note lands after the last block
	// whose time is at or before it (footers share their answer's time, so a
	// note never splits an answer from its footer). Notes newer than the whole
	// window append at the end.
	if (notes?.length) {
		const blockTime = (b: RenderBlock): number => {
			if (b.kind === "walkthrough")
				return new Date(b.walkthrough.publishedAt).getTime();
			if (b.kind === "note") return b.note.ts;
			if (b.kind === "review-loop") {
				const last = b.blocks[b.blocks.length - 1];
				return last ? blockTime(last) : 0;
			}
			const entry =
				b.kind === "turn" ? b.items[b.items.length - 1] : b.entry;
			return entry ? new Date(entry.timestamp).getTime() : 0;
		};
		const sorted = [...notes].sort((a, b) => a.ts - b.ts);
		let at = 0;
		for (const note of sorted) {
			while (at < blocks.length && blockTime(blocks[at]!) <= note.ts) at++;
			blocks.splice(at, 0, { kind: "note", note });
			at++;
		}
	}
	const groupedBlocks = groupReviewLoops(blocks);
	const lastReviewLoop = groupedBlocks.findLastIndex(
		(block) => block.kind === "review-loop",
	);
	// A later human turn makes the old verdict stale in spirit even before GitHub
	// has observed a new push. Operational notices and recaps do not: they are
	// allowed to follow the result without hiding it.
	const showReviewResult =
		!!reviewResult &&
		lastReviewLoop >= 0 &&
		!groupedBlocks.slice(lastReviewLoop + 1).some(
			(block) => reviewBlockRole(block).kind === "user-message",
		);

	return (
		<>
			{groupedBlocks.map((block, i) => {
				if (block.kind === "review-loop") {
					const isLast = i === groupedBlocks.length - 1;
					const isLive = Boolean(live && isLast);
					return (
						<React.Fragment key={`review-loop:${block.blocks[0]?.kind === "entry" ? block.blocks[0].entry.id : i}`}>
							<ReviewLoopBlock
								prNumber={block.prNumber}
								rounds={block.rounds}
								live={isLive}
								// A live loop is always pending, whatever GitHub last
								// reported about the PR.
								result={
									showReviewResult && i === lastReviewLoop && !isLive
										? reviewResult
										: undefined
								}
								defaultOpen={reviewLoopsOpen}
							>
								{block.blocks.map((inner, innerIndex) => {
									const innerKey = inner.kind === "turn"
										? inner.items[0].id
										: inner.kind === "footer"
											? `${inner.entry.id}:footer`
											: inner.kind === "entry"
												? inner.entry.id
												: `inner:${innerIndex}`;
									return (
										<React.Fragment key={innerKey}>
											{inner.kind === "turn" ? (
												<ReviewTurnSteps
													items={inner.items}
													toolResults={toolResults}
													live={Boolean(live && isLast && innerIndex === block.blocks.length - 1)}
													owner={owner}
													sessionId={sessionId}
													onOpenSubagent={onOpenSubagent}
												/>
											) : inner.kind === "footer" ? (
												// Inside the fold the row is one child among many, so it
												// carries its own lift onto the answer above it.
												<TurnFooter className={TURN_FOOTER_LIFT} entry={inner.entry} durationMs={inner.durationMs} files={inner.files} assets={inner.assets} onFork={onFork} />
											) : inner.kind === "entry" && reviewBlockRole(inner).kind !== "handoff" ? (
												<MessageBubble
													entry={inner.entry}
													owner={owner}
													sessionId={sessionId}
													onEdit={onEditMessage}
												/>
											) : null}
										</React.Fragment>
									);
								})}
							</ReviewLoopBlock>
						</React.Fragment>
					);
				}
				const key =
					block.kind === "turn"
						// History prepends can extend the start of an existing turn. Its
						// tail survives that merge, so key the wrapper there and keep its
						// measured height and visibility state instead of remounting it.
						? block.items[block.items.length - 1].id
						: block.kind === "walkthrough"
							? "walkthrough"
							: block.kind === "note"
								? `note:${block.note.id}`
								: block.kind === "footer"
									? `${block.entry.id}:footer`
									: block.entry.id;
				const anchorId =
					block.kind === "turn"
						? `${block.items[block.items.length - 1].id}#turn`
						: key;
				// While streaming, flushTurn splits trailing assistant text out as
				// its own block after the fold, so the live turn alternates between
				// being last and second-to-last as text and tool calls interleave —
				// a turn fold directly before the tail is still the live turn.
				const isLiveTail =
					Boolean(live) &&
					(i === groupedBlocks.length - 1 ||
						(block.kind === "turn" && i === groupedBlocks.length - 2));
				const content =
					block.kind === "turn" ? (
					<TurnBlock
						items={block.items}
						toolResults={toolResults}
						live={isLiveTail}
						onOpenSubagent={onOpenSubagent}
						sessionId={sessionId}
					/>
				) : block.kind === "walkthrough" ? (
					<WalkthroughCard
						walkthrough={block.walkthrough}
						variant="session"
					/>
				) : block.kind === "note" ? (
					<NoteBubble note={block.note} sessionId={sessionId} />
				) : block.kind === "footer" ? (
					<TurnFooter
						entry={block.entry}
						durationMs={block.durationMs}
						files={block.files}
						assets={block.assets}
						onFork={onFork}
					/>
				) : (
					<MessageBubble
						entry={block.entry}
						owner={owner}
						sessionId={sessionId}
						onEdit={onEditMessage}
						onContinue={
							i === groupedBlocks.length - 1 ? onContinue : undefined
						}
					/>
				);
				const showShareAction =
					block.kind === "entry" && shareAfterEntryIds.has(block.entry.id);
				return (
					<React.Fragment key={key}>
						<VirtualTranscriptBlock
							anchorId={anchorId}
							enabled={!isLiveTail && i < groupedBlocks.length - TRAILING_MOUNTED_BLOCKS}
							// A footer overlaps the answer block above it, and only the
							// wrapper can: the windowed branch contains its contents.
							className={block.kind === "footer" ? TURN_FOOTER_LIFT : undefined}
						>
							{content}
						</VirtualTranscriptBlock>
						{showShareAction && slackShare && (
							<ShippedChangeComposer {...slackShare} />
						)}
					</React.Fragment>
				);
			})}
		</>
	);
});

/** Review work uses the same grouped step rows as a normal turn, without
 * introducing another outer worker disclosure inside the review loop. */
function ReviewTurnSteps({
	items,
	toolResults,
	live,
	owner,
	sessionId,
	onOpenSubagent,
}: {
	items: TranscriptEntry[];
	toolResults: Map<string, TranscriptEntry>;
	live: boolean;
	owner?: string;
	sessionId?: string;
	onOpenSubagent?: (agentId: string, label: string) => void;
}) {
	const sections: Array<
		| { kind: "tools"; items: TranscriptEntry[] }
		| { kind: "message"; entry: TranscriptEntry }
	> = [];
	for (const entry of items) {
		if (entry.type === "tool_use") {
			const last = sections[sections.length - 1];
			if (last?.kind === "tools") last.items.push(entry);
			else sections.push({ kind: "tools", items: [entry] });
		} else {
			sections.push({ kind: "message", entry });
		}
	}

	return sections.map((section) =>
		section.kind === "tools" ? (
			<ToolSection
				key={section.items[0].id}
				items={section.items}
				toolResults={toolResults}
				live={live}
				expandAll={false}
				sessionId={sessionId}
				onOpenSubagent={onOpenSubagent}
			/>
		) : (
			<MessageBubble
				key={section.entry.id}
				entry={section.entry}
				owner={owner}
				sessionId={sessionId}
			/>
		),
	);
}
