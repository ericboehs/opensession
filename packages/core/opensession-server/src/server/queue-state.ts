/**
 * Prompt-queue state: messages sent while a run is in flight queue up and
 * deliver afterwards, the same way Claude Code handles interruptions.
 * Attachments ride along: `images` as composer `data:` URLs (parsed to
 * ImageInput at delivery), `files` as the raw composer payload (staged-path or
 * inline refs). Both are persisted with the queue so a restart doesn't
 * silently drop a message's attachments.
 *
 * This module owns the queue/receipt STATE and its persistence + broadcast.
 * The run-coupled operations (enqueue-and-arm-drain, steer, interrupt, drain)
 * live in run-session.ts — they need the runner.
 */

import { copyFileSync, existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { setTranscriptAppendListener } from "./file-watcher";
import { stripContext } from "./prompt-context";
import { SESSIONS_DIR } from "./session-cache";
import { setAppendHook } from "./transcript-store";
import type { TranscriptEntry } from "./types";
import { broadcastToSession } from "./ws-hub";
import { AUTO_CONTINUE_USER } from "./auto-continue";
import { userMatchesAny } from "./shared/user-mappings";

const g = globalThis as any;

export type QueueItem = {
	id?: string;
	/** Stable transcript UUID for a prompt that was accepted before a restart.
	 * Reusing it lets a recovery upsert the existing visible user line instead
	 * of rendering the message twice. */
	promptEntryId?: string;
	content: string;
	user?: string;
	images?: string[];
	files?: unknown;
	/** Sibling-session transcript ids attached when this message starts a turn. */
	contextSessions?: string[];
	/** Slack thread this message came from — the turn's reply is mirrored back
	 *  there (rides the queue + persistence so a busy run can't drop it). */
	slackReplyTo?: { channel: string; threadTs: string };
	/** Human composer send made while the agent was busy: held until the agent
	 *  FULLY finishes (no run and no running child workers), not just until the
	 *  next turn boundary. Orchestration items (worker reports, auto-continues,
	 *  GitHub FYIs) leave it unset and flow at any boundary. */
	hold?: boolean;
	/** Review feedback must start its own turn after any user work already in
	 * flight. Never batch it into that work or steer it mid-turn. */
	reviewHandoff?: boolean;
};
export const promptQueues: Map<string, QueueItem[]> = (g.__promptQueues ??=
	new Map());

/** A batch removed from the queue and handed to the runner. It remains durable
 * until the runner has written its own active-run journal. This closes the
 * crash window between showing a user's message in the transcript and making
 * it recoverable on boot. */
export type PromptDispatch = {
	promptEntryId: string;
	items: QueueItem[];
};
export const promptDispatches: Map<string, PromptDispatch> = (g.__promptDispatches ??=
	new Map());

export function isGitHubQueueItem(item?: QueueItem): boolean {
	return item?.user === "GitHub" || item?.user === "GitHub (automation)";
}

/** Only ordinary composer messages can be moved back into a draft. Routed
 * items carry queue-only metadata that a composer send cannot reconstruct. */
export function isEditableQueueItem(item?: QueueItem): boolean {
	return !!item &&
		!!item.user &&
		!isGitHubQueueItem(item) &&
		item.user !== AUTO_CONTINUE_USER &&
		!item.contextSessions?.length &&
		!item.slackReplyTo &&
		!item.reviewHandoff;
}

function queueActorMatches(item: QueueItem, actor?: string): boolean {
	return !!actor && !!item.user && userMatchesAny(actor, [item.user]);
}

/** Atomically remove an ordinary human message so a client can put its full
 * payload back in the normal composer. Routed/system items stay queue-owned. */
export function takeQueuedPrompt(
	sessionId: string,
	queueId: string,
	actor?: string,
	effects = true,
): QueueItem | undefined {
	const queue = promptQueues.get(sessionId);
	if (!queue) return;
	const index = queue.findIndex((candidate) => candidate.id === queueId);
	const item = queue[index];
	if (!isEditableQueueItem(item) || !item || !queueActorMatches(item, actor)) return;
	queue.splice(index, 1);
	if (queue.length === 0) promptQueues.delete(sessionId);
	if (effects) {
		persistQueues();
		broadcastQueue(sessionId);
	}
	return item;
}

// Steered messages (folded into a live run, delivered at the run's next turn
// boundary) aren't in promptQueues — the drain would re-deliver them. But until
// their turn lands they're invisible on reload, so we keep a display-only
// receipt here: shown as "folded in" in the UI and reconciled away once the real
// transcript entry appears. Cleared when the run finishes (or is cancelled).
export const steeredReceipts: Map<string, QueueItem[]> = (g.__steeredReceipts ??=
	new Map());

// Sessions whose run the user explicitly stopped. The queue drain skips these:
// without the flag, stop would requeue the held steers and drainQueue would
// immediately deliver them into a fresh run — "stop then instantly resume".
// Cleared by the next explicit action (any new runSessionPrompt). In-memory
// only: after a real restart a stop is stale anyway, and boot re-drains.
export const stoppedSessions: Set<string> = (g.__stoppedSessions ??= new Set());

/**
 * Lift a Stop so this session's queue can drain again. Call this on any
 * explicit human send. The latch is normally lifted by runSessionPrompt, but
 * the drain is what calls that: a message sent after a Stop enters the durable
 * queue and drainQueueInner returns at the latch, so without this the message
 * is parked forever and reads as lost (most visible right after a create, when
 * the opening turn is stopped before it settles).
 */
export function liftUserStop(sessionId: string): void {
	stoppedSessions.delete(sessionId);
}

// Both maps are persisted to disk so a real restart/crash (not just a hot
// reload, which keeps the globalThis maps) doesn't silently drop queued or
// just-steered messages. Queued prompts re-drain on boot; steer receipts stay
// display-only until their transcript entry lands or cancellation requeues them.
export const QUEUE_STORE = `${SESSIONS_DIR}/prompt-queues.json`;
export function queueItem(item: QueueItem): QueueItem {
	return item.id ? item : { ...item, id: crypto.randomUUID() };
}

export function queueWithIds(items: QueueItem[] | undefined): QueueItem[] {
	return (items || []).map((item) => {
		if (item.id) return item;
		return queueItem(item);
	});
}

export function persistQueues(storePath = QUEUE_STORE): void {
	try {
		const entries = (m: Map<string, QueueItem[]>) =>
			Object.fromEntries(
				[...m]
					.map(([k, v]) => [k, queueWithIds(v)] as const)
					.filter(([, v]) => v.length > 0),
			);
		// Keep the previous copy as .bak before overwriting: if the store on disk
		// ever ends up unparsable, restorePromptQueues falls back to it instead of
		// silently dropping every queued message.
		if (existsSync(storePath)) {
			try {
				copyFileSync(storePath, `${storePath}.bak`);
			} catch {}
		}
		writeJsonAtomic(
			storePath,
			{
				queued: entries(promptQueues),
				steered: entries(steeredReceipts),
				dispatching: Object.fromEntries(promptDispatches),
			},
			false,
		);
	} catch (e) {
		console.error("[queue] Failed to persist prompt queues:", e);
	}
}

export type PersistedQueueState = {
	queued?: Record<string, QueueItem[]>;
	steered?: Record<string, QueueItem[]>;
	dispatching?: Record<string, PromptDispatch>;
};

function readPersistedQueueState(storePath: string): PersistedQueueState | null {
	try {
		return JSON.parse(readFileSync(storePath, "utf8"));
	} catch (e) {
		console.error("[queue] Failed to read persisted queues:", e);
		try {
			const recovered = JSON.parse(readFileSync(`${storePath}.bak`, "utf8"));
			console.warn("[queue] Recovered persisted queues from .bak");
			return recovered;
		} catch (backupError) {
			console.error(
				"[queue] Backup queue store unreadable too; queued messages lost:",
				backupError,
			);
			return null;
		}
	}
}

/** Load raw durable maps before the server accepts writes. Ownership and
 * transcript reconciliation happen after recovery identifies adopted runs. */
export function hydratePersistedQueueState(storePath = QUEUE_STORE): number {
	if (!existsSync(storePath)) return 0;
	const data = readPersistedQueueState(storePath);
	if (!data) return 0;
	promptQueues.clear();
	steeredReceipts.clear();
	promptDispatches.clear();
	for (const [sessionId, items] of Object.entries(data.queued || {})) {
		if (items?.length) promptQueues.set(sessionId, queueWithIds(items));
	}
	for (const [sessionId, items] of Object.entries(data.steered || {})) {
		if (items?.length) steeredReceipts.set(sessionId, queueWithIds(items));
	}
	for (const [sessionId, dispatch] of Object.entries(data.dispatching || {})) {
		if (dispatch?.promptEntryId && dispatch.items?.length) {
			promptDispatches.set(sessionId, {
				promptEntryId: dispatch.promptEntryId,
				items: queueWithIds(dispatch.items),
			});
		}
	}
	return (
		[...promptQueues.values(), ...steeredReceipts.values()].reduce(
			(count, items) => count + items.length,
			0,
		) + promptDispatches.size
	);
}

/** Restore queue-owned state without deciding when queued prompts should drain.
 * The caller supplies journal/session/transcript facts and arms drains for the
 * returned queuedSessionIds. */
export function restorePersistedQueueState(options: {
	storePath?: string;
	sessionExists: (sessionId: string) => boolean;
	journalOwnsPrompt: (sessionId: string, promptEntryId: string) => boolean;
	runOwnsSteers: (sessionId: string) => boolean;
	deliveredUserTexts: (sessionId: string) => string[];
	effects?: boolean;
}): { queuedSessionIds: string[]; queuedCount: number; steeredCount: number } {
	const storePath = options.storePath ?? QUEUE_STORE;
	if (!existsSync(storePath)) {
		return { queuedSessionIds: [], queuedCount: 0, steeredCount: 0 };
	}
	const data = readPersistedQueueState(storePath);
	if (!data) return { queuedSessionIds: [], queuedCount: 0, steeredCount: 0 };

	const queued = new Map<string, QueueItem[]>();
	for (const [sessionId, items] of Object.entries(data.queued || {})) {
		if (options.sessionExists(sessionId) && items?.length) {
			queued.set(sessionId, queueWithIds(items));
		}
	}
	for (const [sessionId, dispatch] of Object.entries(data.dispatching || {})) {
		if (
			!options.sessionExists(sessionId) ||
			!dispatch?.items?.length ||
			!dispatch.promptEntryId ||
			options.journalOwnsPrompt(sessionId, dispatch.promptEntryId)
		) {
			continue;
		}
		const items = dispatch.items.map((item, index) =>
			index === 0 ? { ...item, promptEntryId: dispatch.promptEntryId } : item,
		);
		queued.set(sessionId, [...items, ...(queued.get(sessionId) || [])]);
	}

	promptQueues.clear();
	steeredReceipts.clear();
	promptDispatches.clear();
	for (const [sessionId, items] of queued) promptQueues.set(sessionId, items);

	let steeredCount = 0;
	for (const [sessionId, items] of Object.entries(data.steered || {})) {
		if (!options.sessionExists(sessionId) || !items?.length) continue;
		const delivered = options.deliveredUserTexts(sessionId);
		const pending = queueWithIds(undeliveredSteers(items, delivered));
		if (!pending.length) continue;
		if (options.runOwnsSteers(sessionId)) {
			steeredReceipts.set(sessionId, pending);
			steeredCount += pending.length;
		} else {
			queued.set(sessionId, [...pending, ...(queued.get(sessionId) || [])]);
			promptQueues.set(sessionId, queued.get(sessionId)!);
		}
	}

	if (options.effects !== false) {
		persistQueues(storePath);
		for (const sessionId of new Set([
			...promptQueues.keys(),
			...steeredReceipts.keys(),
		])) {
			broadcastQueue(sessionId);
		}
	}
	return {
		queuedSessionIds: [...promptQueues.keys()],
		queuedCount: [...promptQueues.values()].reduce((n, items) => n + items.length, 0),
		steeredCount,
	};
}

/** Move a selected queue batch into durable dispatching state before starting
 * runner work. The caller has already removed the batch from promptQueues, so
 * this single persistence point records either the old queued copy (if we die
 * before it) or the dispatching copy (if we die after it). */
export function beginPromptDispatch(
	sessionId: string,
	items: QueueItem[],
	promptEntryId = items.length === 1 ? items[0]?.promptEntryId : undefined,
	effects = true,
): string {
	const id = promptEntryId || crypto.randomUUID();
	promptDispatches.set(sessionId, {
		promptEntryId: id,
		items: items.map((item) => ({ ...item })),
	});
	if (effects) persistQueues();
	return id;
}

/** The engine's active-run journal is now durable, so it owns recovery and the
 * intake dispatch record can be removed. */
export function acknowledgePromptDispatch(
	sessionId: string | undefined,
	promptEntryId: string | undefined,
	effects = true,
): void {
	if (!sessionId || !promptEntryId) return;
	const dispatch = promptDispatches.get(sessionId);
	if (!dispatch || dispatch.promptEntryId !== promptEntryId) return;
	promptDispatches.delete(sessionId);
	if (effects) {
		persistQueues();
		broadcastQueue(sessionId);
	}
}

export function queueDisplayState(sessionId: string) {
	const queued = queueWithIds(promptQueues.get(sessionId));
	const steered = queueWithIds(steeredReceipts.get(sessionId));
	if (queued.length > 0) promptQueues.set(sessionId, queued);
	if (steered.length > 0) steeredReceipts.set(sessionId, steered);
	// Display copy only: fenced <opensession:context> blocks (e.g. the queued
	// auto-continue nudge) are model plumbing, not something the queue chip
	// should render raw. The stored items keep the full content for delivery.
	const forDisplay = (items: typeof queued) =>
		items.map((i) => {
			const shown = stripContext(i.content);
			return {
				...i,
				content: shown === i.content ? i.content : shown || "(auto-continue)",
				editable: isEditableQueueItem(i),
			};
		});
	return { queued: forDisplay(queued), steered: forDisplay(steered) };
}

export function broadcastQueue(sessionId: string) {
	broadcastToSession(sessionId, {
		type: "queue_update",
		sessionId,
		...queueDisplayState(sessionId),
	});
}

/** Record a steered message as a visible receipt until its run finishes. */
export function recordSteer(sessionId: string, item: QueueItem): void {
	const list = steeredReceipts.get(sessionId) || [];
	list.push(queueItem(item));
	steeredReceipts.set(sessionId, list);
	persistQueues();
	broadcastQueue(sessionId);
}

/** Clear a session's steer receipts once the run that owned them is done. */
export function clearSteerReceipts(sessionId: string): void {
	if (!steeredReceipts.has(sessionId)) return;
	steeredReceipts.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
}

// Clear a steer receipt the moment its message lands in the transcript (the
// file-watcher reports appended entries). Waiting for run end left delivered
// messages showing as "queued" whenever the client's transcript tail didn't
// reach back to their user entry — and a mid-run restart would have re-queued
// (re-delivered) them via restorePromptQueues. Matches the frontend reconcile:
// exact attributed form, or containment for turns joined at one boundary.
// Registered at module scope so every hot reload re-installs the current code.
/** Whether a steer receipt's message already appears among the transcript's
 *  user texts (same matching as the frontend reconcile: exact attributed
 *  form, or containment for turns joined at one boundary). */
export function steerDelivered(item: QueueItem, userTexts: string[]): boolean {
	const attributed = (
		item.user ? `[${item.user}] ${item.content}` : item.content
	).trim();
	return userTexts.some((text) => userTextContainsSteer(text, attributed));
}

function userTextContainsSteer(text: string, attributed: string): boolean {
	return steerRange(text, attributed) !== null;
}

function steerRange(text: string, attributed: string): [number, number] | null {
	let start = text.indexOf(attributed);
	while (start >= 0) {
		const end = start + attributed.length;
		const startsAtBoundary = start === 0 || text.slice(start - 2, start) === "\n\n";
		const endsAtBoundary = end === text.length || text.slice(end, end + 2) === "\n\n";
		if (startsAtBoundary && endsAtBoundary) return [start, end];
		start = text.indexOf(attributed, start + 1);
	}
	return null;
}

/** Match receipts to transcript entries one-for-one. Two identical steers need
 * two landed user entries; one transcript occurrence cannot retire both. */
export function undeliveredSteers(
	items: QueueItem[],
	userTexts: string[],
): QueueItem[] {
	if (!userTexts.length) return items;
	const remainingTexts = [...userTexts];
	return items.filter((item) => {
		const attributed = (
			item.user ? `[${item.user}] ${item.content}` : item.content
		).trim();
		const textIndex = remainingTexts.findIndex(
			(text) => steerRange(text, attributed) !== null,
		);
		if (textIndex < 0) return true;
		const range = steerRange(remainingTexts[textIndex], attributed)!;
		const text = remainingTexts[textIndex];
		remainingTexts[textIndex] =
			text.slice(0, range[0]) + "\0".repeat(attributed.length) + text.slice(range[1]);
		return false;
	});
}

function reconcileSteerReceiptsOnAppend(
	sessionId: string,
	entries: TranscriptEntry[],
): void {
	const steered = steeredReceipts.get(sessionId);
	if (!steered?.length) return;
	const users = entries
		.filter((e) => e.type === "user")
		.map((e) => e.content.trim());
	if (users.length === 0) return;
	const remaining = undeliveredSteers(steered, users);
	if (remaining.length === steered.length) return;
	if (remaining.length > 0) steeredReceipts.set(sessionId, remaining);
	else steeredReceipts.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
}

setTranscriptAppendListener(reconcileSteerReceiptsOnAppend);
// Transcript v2 (docs/transcripts.md §4a): v2 viewers retire the
// mirror file-watcher, so delivered-steer reconciliation ALSO rides the
// store's post-commit append hook (same contract, same function; fires only
// when the flag-gated store path writes). Single globalThis slot — each hot
// reload replaces the registration rather than stacking, and the reconcile
// is idempotent, so both channels firing for one append is harmless.
setAppendHook(reconcileSteerReceiptsOnAppend);

/**
 * Put unconfirmed steers back into the normal queue when their run is
 * cancelled. A steer is a noReply engine-history append — once it's in the
 * store the next turn on that session already sees it, so requeueing it
 * delivers a duplicate turn (live 2026-07-16: a worker's two report-back
 * steers came back as queued prompts after the user interrupted the run,
 * despite both sitting in the engine history the interrupting turn ran with).
 * Callers pass the transcript's user texts (engineUserTexts) so receipts
 * that already landed are dropped instead of requeued; only steers the
 * engine never got (a failed fire-and-forget POST) go back into the queue.
 */
export function requeueSteerReceipts(
	sessionId: string,
	deliveredUserTexts?: string[],
	effects = true,
): number {
	const steered = steeredReceipts.get(sessionId);
	if (!steered?.length) return 0;
	const undelivered = undeliveredSteers(steered, deliveredUserTexts || []);
	if (undelivered.length > 0) {
		const queue = promptQueues.get(sessionId) || [];
		promptQueues.set(sessionId, [...undelivered, ...queue]);
	}
	steeredReceipts.delete(sessionId);
	if (effects) {
		persistQueues();
		broadcastQueue(sessionId);
	}
	return undelivered.length;
}

export function queuedPromptIndex(
	queue: QueueItem[],
	queueId?: string,
	queueIndex?: number,
): number {
	if (queueId) {
		return queue.findIndex((item) => item.id === queueId);
	}
	if (
		typeof queueIndex === "number" &&
		Number.isInteger(queueIndex) &&
		queueIndex >= 0 &&
		queueIndex < queue.length
	) {
		return queueIndex;
	}
	return -1;
}

export function deleteQueuedPrompt(
	sessionId: string,
	queueId?: string,
	queueIndex?: number,
	effects = true,
): boolean {
	const queue = promptQueues.get(sessionId);
	if (queue) {
		const index = queuedPromptIndex(queue, queueId, queueIndex);
		if (index >= 0) {
			const next = queue.filter((_, i) => i !== index);
			if (next.length > 0) promptQueues.set(sessionId, next);
			else promptQueues.delete(sessionId);
			if (effects) {
				persistQueues();
				broadcastQueue(sessionId);
			}
			return true;
		}
	}
	// Steer receipts are dismissable too (by id only — indexes are queue-
	// relative). A receipt normally reconciles away when its message lands,
	// but it lives server-side until the run finishes; on a long run a stale
	// one must be deletable without waiting for that.
	if (queueId) {
		const steered = steeredReceipts.get(sessionId);
		const index = (steered || []).findIndex((item) => item.id === queueId);
		if (steered && index >= 0) {
			const next = steered.filter((_, i) => i !== index);
			if (next.length > 0) steeredReceipts.set(sessionId, next);
			else steeredReceipts.delete(sessionId);
			if (effects) {
				persistQueues();
				broadcastQueue(sessionId);
			}
			return true;
		}
	}
	return false;
}

/** Compatibility path for clients shipped before queued messages moved back
 * into the normal composer. Current clients use takeQueuedPrompt instead. */
export function updateQueuedPrompt(
	sessionId: string,
	queueId: string | undefined,
	queueIndex: number | undefined,
	content: string,
	images?: string[],
): boolean {
	const queue = promptQueues.get(sessionId);
	if (!queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const item = queue[index];
	if (!item || isGitHubQueueItem(item)) return false;
	item.content = content;
	if (images) {
		if (images.length > 0) item.images = images;
		else delete item.images;
	}
	if (
		!item.content.trim() &&
		!item.images?.length &&
		!(Array.isArray(item.files) && item.files.length > 0)
	) {
		queue.splice(index, 1);
	}
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

/**
 * Reorder a session's queue to match `order` (queue-item ids in their new send
 * order). Items named in `order` are placed first in that order; any queued item
 * not named — one that arrived after the client took its snapshot — keeps its
 * relative position at the tail, so a racing enqueue is never dropped. No-ops
 * (unknown session, <2 items, or an order that doesn't change anything) return
 * false without a broadcast.
 */
export function reorderQueuedPrompt(
	sessionId: string,
	order: string[],
	effects = true,
): boolean {
	const queue = promptQueues.get(sessionId);
	if (!queue || queue.length < 2) return false;
	const byId = new Map(
		queue.filter((it) => it.id).map((it) => [it.id!, it] as const),
	);
	const placed = new Set<string>();
	const next: QueueItem[] = [];
	for (const id of order) {
		const item = byId.get(id);
		if (item && !placed.has(id)) {
			next.push(item);
			placed.add(id);
		}
	}
	for (const item of queue) {
		if (!item.id || !placed.has(item.id)) next.push(item);
	}
	// Same references in the same slots ⇒ nothing moved.
	if (next.every((item, i) => item === queue[i])) return false;
	promptQueues.set(sessionId, next);
	if (effects) {
		persistQueues();
		broadcastQueue(sessionId);
	}
	return true;
}
