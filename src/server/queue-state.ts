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

import { copyFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { setTranscriptAppendListener } from "./file-watcher";
import { stripContext } from "./prompt-context";
import { SESSIONS_DIR } from "./session-cache";
import { setAppendHook } from "./transcript-store";
import type { TranscriptEntry } from "./types";
import { broadcastToSession } from "./ws-hub";

const g = globalThis as any;

export type QueueItem = {
	id?: string;
	content: string;
	user?: string;
	images?: string[];
	files?: unknown;
	/** Slack thread this message came from — the turn's reply is mirrored back
	 *  there (rides the queue + persistence so a busy run can't drop it). */
	slackReplyTo?: { channel: string; threadTs: string };
	/** Human composer send made while the agent was busy: held until the agent
	 *  FULLY finishes (no run and no running child workers), not just until the
	 *  next turn boundary. Orchestration items (worker reports, auto-continues,
	 *  GitHub FYIs) leave it unset and flow at any boundary. */
	hold?: boolean;
};
export const promptQueues: Map<string, QueueItem[]> = (g.__promptQueues ??=
	new Map());

export function isGitHubQueueItem(item?: QueueItem): boolean {
	return item?.user === "GitHub" || item?.user === "GitHub (automation)";
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

// Both maps are persisted to disk so a real restart/crash (not just a hot
// reload, which keeps the globalThis maps) doesn't silently drop queued or
// just-steered messages. Restored + re-drained on boot (restorePromptQueues).
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

export function persistQueues(): void {
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
		if (existsSync(QUEUE_STORE)) {
			try {
				copyFileSync(QUEUE_STORE, `${QUEUE_STORE}.bak`);
			} catch {}
		}
		writeJsonAtomic(
			QUEUE_STORE,
			{
				queued: entries(promptQueues),
				steered: entries(steeredReceipts),
			},
			false,
		);
	} catch (e) {
		console.error("[queue] Failed to persist prompt queues:", e);
	}
}

export function broadcastQueue(sessionId: string) {
	const queued = queueWithIds(promptQueues.get(sessionId));
	const steered = queueWithIds(steeredReceipts.get(sessionId));
	if (queued.length > 0) promptQueues.set(sessionId, queued);
	if (steered.length > 0) steeredReceipts.set(sessionId, steered);
	// Display copy only: fenced <backstage:context> blocks (e.g. the queued
	// auto-continue nudge) are model plumbing, not something the queue chip
	// should render raw. The stored items keep the full content for delivery.
	const forDisplay = (items: typeof queued) =>
		items.map((i) => {
			const shown = stripContext(i.content);
			return shown === i.content
				? i
				: { ...i, content: shown || "(auto-continue)" };
		});
	broadcastToSession(sessionId, {
		type: "queue_update",
		sessionId,
		queued: forDisplay(queued),
		steered: forDisplay(steered),
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
	return userTexts.some((u) => u === attributed || u.includes(attributed));
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
	const remaining = steered.filter((item) => !steerDelivered(item, users));
	if (remaining.length === steered.length) return;
	if (remaining.length > 0) steeredReceipts.set(sessionId, remaining);
	else steeredReceipts.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
}

setTranscriptAppendListener(reconcileSteerReceiptsOnAppend);
// Transcript v2 (docs/transcript-v2-design.md §4a): v2 viewers retire the
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
): number {
	const steered = steeredReceipts.get(sessionId);
	if (!steered?.length) return 0;
	const undelivered = deliveredUserTexts?.length
		? steered.filter((item) => !steerDelivered(item, deliveredUserTexts))
		: steered;
	if (undelivered.length > 0) {
		const queue = promptQueues.get(sessionId) || [];
		promptQueues.set(sessionId, [...undelivered, ...queue]);
	}
	steeredReceipts.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
	return undelivered.length;
}

export function queuedPromptIndex(
	queue: QueueItem[],
	queueId?: string,
	queueIndex?: number,
): number {
	if (queueId) {
		const byId = queue.findIndex((item) => item.id === queueId);
		if (byId >= 0) return byId;
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
): boolean {
	const queue = promptQueues.get(sessionId);
	if (queue) {
		const index = queuedPromptIndex(queue, queueId, queueIndex);
		if (index >= 0) {
			const next = queue.filter((_, i) => i !== index);
			if (next.length > 0) promptQueues.set(sessionId, next);
			else promptQueues.delete(sessionId);
			persistQueues();
			broadcastQueue(sessionId);
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
			persistQueues();
			broadcastQueue(sessionId);
			return true;
		}
	}
	return false;
}

export function updateQueuedPrompt(
	sessionId: string,
	queueId: string | undefined,
	queueIndex: number | undefined,
	content: string,
): boolean {
	const queue = promptQueues.get(sessionId);
	if (!queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const item = queue[index];
	if (!item) return false;
	if (isGitHubQueueItem(item)) return false;
	item.content = content;
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
export function reorderQueuedPrompt(sessionId: string, order: string[]): boolean {
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
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}
