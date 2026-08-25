import React, { useEffect, useRef } from "react";
import type { SessionNote, SessionWalkthrough, TranscriptEntry } from "../lib/types";
import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import {
	buildTranscriptRanges,
	type TranscriptIndexedRange,
} from "../lib/transcript-index";
import {
	turnMountKey,
	turnScrollAnchor,
} from "../lib/transcript-block-identity";
import { MessageBubble } from "./MessageBubble";
import { NoteBubble } from "./NoteBubble";
import { ToolSection, TurnBlock } from "./TurnBlock";
import {
	turnTouchedFiles,
	TurnFooter,
	TURN_FOOTER_LIFT,
	type TouchedFile,
} from "./TurnFooter";
import {
	VirtualTranscriptList,
	type VirtualTranscriptItem,
} from "./VirtualTranscriptList";
import { WalkthroughCard } from "./WalkthroughCard";
import { walkthroughInsertIndex } from "./walkthrough-placement";
import {
	normalizeLegacyVoiceToolEntries,
	orderTranscriptEntries,
} from "../lib/transcript-state";
import { collectWrittenAssets } from "../lib/open-asset";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { ReviewLoopBlock } from "./ReviewLoopBlock";
import type { ReviewLoopResult } from "../lib/review-loop";
import {
	ShippedChangeComposer,
	type ShippedChangeComposerProps,
} from "./ShippedChangeComposer";
import { SessionContextMessage } from "./SessionContextMessage";
import * as stylex from "@stylexjs/stylex";
import { motionStyles } from "../styles/animations.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mxAuto: {
			marginInline: "auto"
	},
	mb3: {
			marginBottom: "12px"
	},
	h12: {
			height: "48px"
	},
	wFull: {
			width: "100%"
	},
	maxWVarSessionCol: {
			maxWidth: "var(--session-col)"
	},
	animatePulse: {
			animation: "var(--animate-pulse)"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgHover45: {
			backgroundColor: "var(--hover)"
	},
});

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
	/** Just-sent user turns that have not landed durably yet. They participate in
	 *  transcript ordering so live tools can never render above their prompt. */
	optimisticEntries?: TranscriptEntry[];
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
	onReviewLoopOpenChange?: (open: boolean) => void;
	/** Complete content-free outline. When present, ranges hydrate on demand. */
	transcriptIndex?: TranscriptIndexEntry[];
	/** Changes only to re-arm visible range demand after a dropped response. */
	transcriptRangeRetryGeneration?: number;
	onLoadTranscriptRanges?: (ranges: TranscriptIndexedRange[]) => void;
	/** Fired once every range near the viewport renders from real payload
	 *  rather than an outline placeholder — the open-settle curtain's release. */
	onVisibleRangesSettled?: () => void;
	/** Indexed range rows reuse this renderer without nesting a virtualizer. */
	virtualize?: boolean;
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

/** A blank delivery row renders nothing in MessageBubble, so it cannot be a
 * conversation boundary here. Treating it as one split uninterrupted work
 * into a long stack of meaningless "Worked · 1 step" disclosures. */
function isRenderlessUserEntry(entry: TranscriptEntry): boolean {
	return (
		entry.type === "user" &&
		!entry.notice &&
		!(entry.sender && entry.senderVia) &&
		!entry.content &&
		!entry.images?.length &&
		!entry.videos?.length &&
		!entry.files?.length
	);
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

function renderBlockEntries(block: RenderBlock): TranscriptEntry[] {
	if (block.kind === "turn") return block.items;
	if (block.kind === "entry" || block.kind === "footer") return [block.entry];
	if (block.kind === "review-loop")
		return block.blocks.flatMap(renderBlockEntries);
	return [];
}

function renderBlockKey(block: RenderBlock, index: number): string {
	if (block.kind === "turn") return turnMountKey(block.items);
	if (block.kind === "walkthrough") return "walkthrough";
	if (block.kind === "note") return `note:${block.note.id}`;
	if (block.kind === "footer") return `${block.entry.id}:footer`;
	if (block.kind === "review-loop") {
		const first = renderBlockEntries(block)[0];
		return `review-loop:${first?.id ?? index}`;
	}
	return block.entry.id;
}

function renderBlockAnchor(block: RenderBlock, key: string): string {
	if (block.kind === "turn") return turnScrollAnchor(block.items);
	return key;
}

function renderBlockEstimate(block: RenderBlock): number {
	if (block.kind === "turn") return 40;
	if (block.kind === "footer") return 32;
	if (block.kind === "review-loop") return 120;
	if (block.kind === "walkthrough") return 320;
	if (block.kind === "note") return 96;
	if (block.kind === "entry" && block.entry.type === "system") return 48;
	if (block.kind === "entry" && block.entry.type === "user") return 88;
	return 160;
}

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
// The React Compiler keeps callbacks and entries identity-stable across
// renders, so this bails out entirely on a panel toggle.
export const TranscriptBlocks = function TranscriptBlocks(
	props: Props,
) {
	const entries = (props.optimisticEntries?.length
				? orderTranscriptEntries([...props.entries, ...props.optimisticEntries])
				: props.entries);
	const renderedProps = entries === props.entries ? props : { ...props, entries };
	return (
		<>
			{props.sessionId && <SessionContextMessage sessionId={props.sessionId} />}
			{props.transcriptIndex ? (
				<IndexedTranscriptBlocks {...renderedProps} />
			) : (
				<LoadedTranscriptBlocks {...renderedProps} />
			)}
		</>
	);
};

const LoadedTranscriptBlocks = function LoadedTranscriptBlocks({
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
	onReviewLoopOpenChange,
	optimisticEntries,
	virtualize = true,
	onVisibleRangesSettled,
}: Props) {
	// Top level only (nested per-range instances pass virtualize={false} and are
	// suppressed): without an outline every block renders real content, so the
	// first commit already IS the settled state.
	const settledRef = useRef(false);
	useEffect(() => {
		if (!virtualize || settledRef.current) return;
		settledRef.current = true;
		onVisibleRangesSettled?.();
	}, [virtualize, onVisibleRangesSettled]);
	const optimisticEntryIds = new Set(
		(optimisticEntries ?? []).map((entry) => entry.id),
	);
	const renderedEntries = normalizeLegacyVoiceToolEntries(entries)
		.map(classifyEntry)
		.filter((entry) => !isRenderlessUserEntry(entry));
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

	const virtualItems: VirtualTranscriptItem[] = groupedBlocks.map((block, i) => {
		const key = renderBlockKey(block, i);
		const entriesInBlock = renderBlockEntries(block);
		if (block.kind === "review-loop") {
			const isLast = i === groupedBlocks.length - 1;
			const isLive = Boolean(live && isLast);
			return {
				key,
				anchorId: renderBlockAnchor(block, key),
				entryIds: entriesInBlock.map((entry) => entry.id),
				estimateSize: renderBlockEstimate(block),
				content: (
					<ReviewLoopBlock
						prNumber={block.prNumber}
						rounds={block.rounds}
						live={isLive}
						result={
							showReviewResult && i === lastReviewLoop && !isLive
								? reviewResult
								: undefined
						}
						defaultOpen={reviewLoopsOpen}
						onOpenChange={onReviewLoopOpenChange}
					>
						{block.blocks.map((inner, innerIndex) => {
							const innerKey = renderBlockKey(inner, innerIndex);
							return (
								<React.Fragment key={innerKey}>
									{inner.kind === "turn" ? (
										<ReviewTurnSteps
											items={inner.items}
											toolResults={toolResults}
											live={Boolean(
												live &&
												isLast &&
												innerIndex === block.blocks.length - 1,
											)}
											owner={owner}
											sessionId={sessionId}
											onOpenSubagent={onOpenSubagent}
										/>
									) : inner.kind === "footer" ? (
										<TurnFooter
											className={TURN_FOOTER_LIFT}
											entry={inner.entry}
											durationMs={inner.durationMs}
											files={inner.files}
											assets={inner.assets}
											onFork={onFork}
										/>
									) : inner.kind === "entry" &&
										reviewBlockRole(inner).kind !== "handoff" ? (
										<MessageBubble
											entry={inner.entry}
											owner={owner}
											sessionId={sessionId}
											onEdit={
												optimisticEntryIds.has(inner.entry.id)
													? undefined
													: onEditMessage
											}
										/>
									) : null}
								</React.Fragment>
							);
						})}
					</ReviewLoopBlock>
				),
			};
		}

		// While streaming, flushTurn splits trailing assistant text out as its
		// own block after the fold. A turn directly before that tail is live too.
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
				<WalkthroughCard walkthrough={block.walkthrough} variant="session" />
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
					onEdit={
						optimisticEntryIds.has(block.entry.id) ? undefined : onEditMessage
					}
					onContinue={
						i === groupedBlocks.length - 1 ? onContinue : undefined
					}
				/>
			);
		const showShareAction =
			block.kind === "entry" && shareAfterEntryIds.has(block.entry.id);
		return {
			key,
			anchorId: renderBlockAnchor(block, key),
			entryIds: entriesInBlock.map((entry) => entry.id),
			estimateSize: renderBlockEstimate(block),
			// A footer overlaps the answer above it, so its margin belongs to the
			// measured wrapper rather than inside the contained row.
			className: block.kind === "footer" ? TURN_FOOTER_LIFT : undefined,
			content: (
				<>
					{content}
					{showShareAction && slackShare && (
						<ShippedChangeComposer {...slackShare} />
					)}
				</>
			),
		};
	});

	return (
		<VirtualTranscriptList
			items={virtualItems}
			trailingMounted={TRAILING_MOUNTED_BLOCKS}
			enabled={virtualize}
			sizeCacheKey={sessionId}
		/>
	);
};

type IndexedTimelineAtom =
	| {
			kind: "range";
			range: TranscriptIndexedRange;
			/** Live turn entries that have not received durable seq values yet. */
			continuationEntryIds: string[];
			timestampMs: number;
			notes: SessionNote[];
			walkthrough?: SessionWalkthrough;
	  }
	| { kind: "entry"; entry: TranscriptEntry; timestampMs: number }
	| { kind: "note"; note: SessionNote; timestampMs: number }
	| { kind: "walkthrough"; walkthrough: SessionWalkthrough; timestampMs: number };

type IndexedTimelineItem =
	| IndexedTimelineAtom
	| {
			kind: "review";
			atoms: IndexedTimelineAtom[];
			ranges: TranscriptIndexedRange[];
			rounds: number;
			prNumber: number | null;
			timestampMs: number;
	  };

function IndexedTranscriptBlocks(props: Props) {
	const {
		entries,
		transcriptIndex = [],
		notes,
		walkthrough,
		onLoadTranscriptRanges,
	} = props;
	const [openedReviewKeys, setOpenedReviewKeys] = React.useState(
		() => new Set<string>(),
	);
	const setReviewOpen = (key: string, open: boolean) => {
		setOpenedReviewKeys((current) => {
			const next = new Set(current);
			if (open) next.add(key);
			else next.delete(key);
			return next;
		});
	};
	const ranges = buildTranscriptRanges(transcriptIndex);
	const payloadById = new Map(entries.map((entry) => [entry.id, entry]));
	const indexedIds = new Set(ranges.flatMap((range) => range.entryIds));
	const optimisticIds = new Set(
		(props.optimisticEntries ?? []).map((entry) => entry.id),
	);
	let atoms: IndexedTimelineAtom[] = ranges.map((range) => ({
		kind: "range",
		range,
		continuationEntryIds: [],
		timestampMs: range.endTimestampMs,
		notes: [],
	}));
	const rangeAtoms = atoms.filter(
		(atom): atom is Extract<IndexedTimelineAtom, { kind: "range" }> =>
			atom.kind === "range",
	);
	for (const entry of entries) {
		if (typeof entry.seq === "number" || indexedIds.has(entry.id)) continue;
		const timestampMs = Date.parse(entry.timestamp) || 0;
		if (optimisticIds.has(entry.id) && rangeAtoms.length > 0) {
			// A prompt can paint before its durable user row while live tool frames
			// are already arriving. Put it into the range those tools occupy, then
			// order that range by the immutable seq spine plus this timestamp. If no
			// range reaches its send time yet, the durable tail is still the correct
			// predecessor for a new turn.
			const rangeAtom =
				rangeAtoms.find((atom) => atom.range.endTimestampMs >= timestampMs) ??
				rangeAtoms[rangeAtoms.length - 1]!;
			rangeAtom.continuationEntryIds.push(entry.id);
			rangeAtom.timestampMs = Math.max(rangeAtom.timestampMs, timestampMs);
			continue;
		}
		atoms.push({
			kind: "entry",
			entry,
			timestampMs,
		});
	}
	atoms = sortIndexedTimelineAtoms(atoms);
	// Live turn frames arrive before their durable sequence numbers. Keep a
	// separate overlay on the durable tail range so one assistant turn cannot
	// temporarily split into a settled Worked group and a loose call. The range
	// bounds and entry IDs stay durable-only for sparse hydration requests.
	const tailRange = ranges[ranges.length - 1];
	for (let index = 1; index < atoms.length; index++) {
		const atom = atoms[index]!;
		const previous = atoms[index - 1]!;
		if (
			atom.kind !== "entry" ||
			previous.kind !== "range" ||
			previous.range !== tailRange ||
			!isLiveToolEntry(atom.entry)
		)
			continue;
		previous.continuationEntryIds.push(atom.entry.id);
		previous.timestampMs = Math.max(previous.timestampMs, atom.timestampMs);
		atoms.splice(index, 1);
		index--;
	}
	for (const note of notes ?? []) {
		const containing = atoms.find(
			(atom) =>
				atom.kind === "range" &&
				note.ts >= atom.range.startTimestampMs &&
				note.ts <= atom.timestampMs,
		);
		if (containing?.kind === "range") containing.notes.push(note);
		else atoms.push({ kind: "note", note, timestampMs: note.ts });
	}
	if (walkthrough) {
		const publishedEntryId = walkthrough.publishedEntryId;
		const publishedAt = Date.parse(walkthrough.publishedAt) || 0;
		const containing = atoms.find(
			(atom) =>
				atom.kind === "range" &&
				(publishedEntryId
					? indexedAtomEntryIds(atom).includes(publishedEntryId)
					: publishedAt >= atom.range.startTimestampMs &&
						publishedAt <= atom.timestampMs),
		);
		if (containing?.kind === "range") containing.walkthrough = walkthrough;
		else
			atoms.push({
				kind: "walkthrough",
				walkthrough,
				timestampMs: publishedAt,
			});
	}
	atoms = sortIndexedTimelineAtoms(atoms);
	const timeline = groupIndexedReviewLoops(atoms);
	const lastIndex = timeline.length - 1;
	// Nothing to window (an empty or fully-absent outline): the curtain lifts
	// immediately instead of waiting for a demand pass that will never run.
	useEffect(() => {
		if (timeline.length === 0) props.onVisibleRangesSettled?.();
	}, [timeline.length, props.onVisibleRangesSettled]);
	const items: VirtualTranscriptItem[] = timeline.map((item, index) => {
		const itemRanges = indexedItemRanges(item);
		const entryIds = indexedItemEntryIds(item);
		const loaded = itemRanges.every((range) =>
			range.entryIds.every((id) => payloadById.has(id)),
		);
		const itemEntries = orderTranscriptEntries(
			entryIds.flatMap((id) => {
				const entry = payloadById.get(id);
				return entry ? [entry] : [];
			}),
		);
		// The opening tail can begin midway through one structural range. When the
		// complete index arrives, keep rendering the payload already on screen
		// while its missing prefix hydrates. Replacing real content with a 48px
		// placeholder for that round trip makes the transcript flash and briefly
		// remaps scrollTop into an older part of the conversation.
		const rendersPartialRange = item.kind === "range" && itemEntries.length > 0;
		const rendersPayload = loaded || rendersPartialRange;
		const key = indexedItemKey(item, index);
		const estimateSize = indexedItemEstimate(item);
		const isLast = index === lastIndex;
		return {
			key,
			anchorId: key,
			entryIds,
			estimateSize,
			measure: rendersPayload || item.kind !== "range",
			content:
				item.kind === "note" ? (
					<NoteBubble note={item.note} sessionId={props.sessionId} />
				) : item.kind === "walkthrough" ? (
					<WalkthroughCard walkthrough={item.walkthrough} variant="session" />
				) : item.kind === "entry" ? (
					<LoadedTranscriptBlocks
						{...props}
						onVisibleRangesSettled={undefined}
						entries={[item.entry]}
						transcriptIndex={undefined}
						notes={undefined}
						walkthrough={undefined}
						virtualize={false}
						live={Boolean(props.live && isLast)}
						onContinue={isLast ? props.onContinue : undefined}
					/>
				) : rendersPayload ? (
					<LoadedTranscriptBlocks
						{...props}
						entries={itemEntries}
						transcriptIndex={undefined}
						notes={indexedItemNotes(item)}
						walkthrough={indexedItemWalkthrough(item)}
						virtualize={false}
						live={Boolean(props.live && isLast)}
						reviewLoopsOpen={
							item.kind === "review" && openedReviewKeys.has(key)
								? true
								: props.reviewLoopsOpen
						}
						onReviewLoopOpenChange={
							item.kind === "review"
								? (open) => setReviewOpen(key, open)
								: undefined
						}
						onContinue={isLast ? props.onContinue : undefined}
					/>
				) : item.kind === "review" ? (
					<ReviewLoopBlock
						prNumber={item.prNumber}
						rounds={item.rounds}
						live={Boolean(props.live && isLast)}
						result={isLast ? props.reviewResult : undefined}
						onOpenChange={(open) => {
							setReviewOpen(key, open);
							if (open) onLoadTranscriptRanges?.(itemRanges);
						}}
					>
						<TranscriptRangeLoading />
					</ReviewLoopBlock>
				) : (
					<TranscriptRangeLoading />
				),
		};
	});

	return (
		<VirtualTranscriptList
			items={items}
			trailingMounted={TRAILING_MOUNTED_BLOCKS}
			sizeCacheKey={props.sessionId}
			onVisibleItems={(visible) => {
				if (!onLoadTranscriptRanges) return;
				const keys = new Set(visible.map((item) => item.key));
				const wanted = timeline
					.filter(
						(item, index) =>
							(item.kind !== "review" || indexedItemHasDecoration(item)) &&
							keys.has(indexedItemKey(item, index)),
					)
					.flatMap(indexedItemRanges)
					.filter((range) =>
						range.entryIds.some((id) => !payloadById.has(id)),
					);
				if (wanted.length) {
					onLoadTranscriptRanges?.(wanted);
				} else if (visible.length > 0) {
					props.onVisibleRangesSettled?.();
				}
			}}
		/>
	);
}

function isLiveToolEntry(entry: TranscriptEntry): boolean {
	return entry.type === "tool_use" || entry.type === "tool_result";
}

/**
 * Conversation ranges are ordered by the immutable seq spine, exactly like the
 * entries inside them. Only decorations that have no seq are placed by time.
 *
 * A range's timestamp is its LAST row, so a message that arrives mid-turn opens
 * a range stamped earlier than the turn still emitting tool rows above it. That
 * makes range timestamps non-monotonic for as long as the new message has no
 * work under it yet, and sorting the whole timeline by them hoists the newer
 * message above the older turn until the next durable row lands.
 */
function sortIndexedTimelineAtoms(
	atoms: IndexedTimelineAtom[],
): IndexedTimelineAtom[] {
	const byTime = (a: IndexedTimelineAtom, b: IndexedTimelineAtom) =>
		a.timestampMs - b.timestampMs;
	const spine = atoms
		.filter(
			(atom): atom is Extract<IndexedTimelineAtom, { kind: "range" }> =>
				atom.kind === "range",
		)
		.sort((a, b) => a.range.firstSeq - b.range.firstSeq);
	if (!spine.length) return [...atoms].sort(byTime);
	const result: IndexedTimelineAtom[] = [...spine];
	for (const atom of atoms.filter((atom) => atom.kind !== "range").sort(byTime)) {
		const index = result.findIndex(
			(candidate) => candidate.timestampMs > atom.timestampMs,
		);
		result.splice(index === -1 ? result.length : index, 0, atom);
	}
	return result;
}

function groupIndexedReviewLoops(
	atoms: IndexedTimelineAtom[],
): IndexedTimelineItem[] {
	const grouped: IndexedTimelineItem[] = [];
	for (let index = 0; index < atoms.length; index++) {
		const atom = atoms[index]!;
		if (atom.kind !== "range" || atom.range.headRole !== "review_handoff") {
			grouped.push(atom);
			continue;
		}
		const loop: IndexedTimelineAtom[] = [atom];
		let rounds = atom.range.reviewRounds;
		let prNumber = atom.range.reviewPrNumber;
		while (index + 1 < atoms.length) {
			const next = atoms[index + 1]!;
			if (next.kind === "range" && next.range.headRole === "user") break;
			index++;
			loop.push(next);
			if (next.kind === "range" && next.range.headRole === "review_handoff") {
				rounds += next.range.reviewRounds;
				prNumber ??= next.range.reviewPrNumber;
			}
		}
		grouped.push({
			kind: "review",
			atoms: loop,
			ranges: loop.flatMap((item) =>
				item.kind === "range" ? [item.range] : [],
			),
			rounds,
			prNumber,
			timestampMs: atom.timestampMs,
		});
	}
	return grouped;
}

function indexedItemRanges(item: IndexedTimelineItem): TranscriptIndexedRange[] {
	if (item.kind === "range") return [item.range];
	if (item.kind === "review") return item.ranges;
	return [];
}

function indexedAtomEntryIds(atom: IndexedTimelineAtom): string[] {
	if (atom.kind === "entry") return [atom.entry.id];
	if (atom.kind === "range")
		return [...atom.range.entryIds, ...atom.continuationEntryIds];
	return [];
}

function indexedItemEntryIds(item: IndexedTimelineItem): string[] {
	if (item.kind === "review") return item.atoms.flatMap(indexedAtomEntryIds);
	return indexedAtomEntryIds(item);
}

function indexedItemNotes(item: IndexedTimelineItem): SessionNote[] | undefined {
	if (item.kind === "range") return item.notes.length ? item.notes : undefined;
	if (item.kind === "review") {
		const notes = item.atoms.flatMap((atom) =>
			atom.kind === "range"
				? atom.notes
				: atom.kind === "note"
					? [atom.note]
					: [],
		);
		return notes.length ? notes : undefined;
	}
	return undefined;
}

function indexedItemWalkthrough(
	item: IndexedTimelineItem,
): SessionWalkthrough | undefined {
	if (item.kind === "range") return item.walkthrough;
	if (item.kind === "review") {
		for (const atom of item.atoms) {
			if (atom.kind === "walkthrough") return atom.walkthrough;
			if (atom.kind === "range" && atom.walkthrough) return atom.walkthrough;
		}
	}
	return undefined;
}

function indexedItemHasDecoration(item: IndexedTimelineItem): boolean {
	return Boolean(indexedItemNotes(item)?.length || indexedItemWalkthrough(item));
}

function indexedItemKey(item: IndexedTimelineItem, index: number): string {
	if (item.kind === "entry") return item.entry.id;
	if (item.kind === "range") return item.range.key;
	if (item.kind === "review") return `review-index:${item.ranges[0]?.key ?? index}`;
	if (item.kind === "note") return `note:${item.note.id}`;
	return "walkthrough";
}

function indexedItemEstimate(item: IndexedTimelineItem): number {
	if (item.kind === "range") return item.range.estimateSize;
	if (item.kind === "review") return 48;
	if (item.kind === "note") return 96;
	if (item.kind === "walkthrough") return 320;
	return 48;
}

function TranscriptRangeLoading() {
	return (
		<div
			{...stylex.props(sx.mxAuto, sx.mb3, sx.h12, sx.wFull, sx.maxWVarSessionCol, motionStyles.pulse, sx.roundedLg, sx.bgHover45)}
			aria-label="Loading messages"
		/>
	);
}

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
