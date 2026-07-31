import React, { useEffect, useRef, useState } from "react";
import {
	AnimatePresence,
	motion,
	useMotionValue,
	useTransform,
	type PanInfo,
} from "motion/react";
import type { PlainThread, SupportThread } from "../lib/types";
import {
	fetchPlainThreadById,
	fetchSupportThreads,
	setPlainThreadSpamApi,
	setPlainThreadStatusApi,
	startPlainTriageApi,
} from "../lib/api";
import { PlainEntryRow, plainThreadUrl } from "./PlainThreadPanel";
import { useCurrentUser } from "./UserPicker";

/**
 * Support Tinder — PR Tinder's sibling for the Plain Todo queue, one ticket at
 * a time:
 *   swipe right / Skip  (→ or k) → leave it as-is (status untouched), next
 *   swipe left  / Spam  (← or s) → mark the customer spam (closes thread), next
 *   Session (e) → jump into the ticket's opensession session (reuses the live
 *                 triage session, or boots a fresh triage run if none exists)
 *   Done  (d) → mark the thread Done, next
 *   Plain (o) → open the thread in the Plain app
 *   Back  (b) → previous card · Esc → leave
 * Spam and Done land on the undo stack (z / header ↩ / toast) like PR Tinder's
 * actions. The deck is shuffled per visit — random order beats the queue's
 * age order here, so old tickets don't wall off the fresh ones.
 */

const SWIPE_DISTANCE = 110; // px of drag past which a release commits
const SWIPE_VELOCITY = 520; // px/s flick that commits regardless of distance
const UNDO_MS = 7000;

type Action = "skip" | "spam" | "done";

/** One reversible deck action; `at` is the card's index, for jumping back. */
type UndoEntry =
	| { kind: "spam"; t: SupportThread; at: number }
	| { kind: "done"; t: SupportThread; at: number };

interface Props {
	/** Leave the deck (back / done). */
	onExit: () => void;
	/** Navigate into a session (the Session button resolves one over HTTP). */
	onOpenSession: (id: string) => void;
}

/** Fisher–Yates, returns a new array — the deck order is rolled once per visit. */
function shuffle<T>(arr: T[]): T[] {
	const out = arr.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function ageDays(ts: string): number {
	return Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000);
}

function ageLabel(ts: string | null): string {
	if (!ts) return "";
	const d = ageDays(ts);
	if (d <= 0) return "today";
	return `${d}d`;
}

/** Fresh green, drifting yellow, stale red — same age tint as PR Tinder. */
function ageTone(ts: string | null): string {
	if (!ts) return "text-faint";
	const d = ageDays(ts);
	if (d < 1) return "text-green";
	if (d < 4) return "text-yellow";
	return "text-red";
}

/** Plain thread priorities, as Plain's own UI names them. */
const PRIORITY: Record<number, { label: string; cls: string }> = {
	0: { label: "Urgent", cls: "border-red/50 text-red" },
	1: { label: "High", cls: "border-yellow/50 text-yellow" },
	2: { label: "Normal", cls: "border-line text-dim" },
	3: { label: "Low", cls: "border-line text-faint" },
};

export function SupportTinder({ onExit, onOpenSession }: Props) {
	const currentUser = useCurrentUser();

	// One fetch per visit; the deck is shuffled once and then frozen — acting
	// on cards never reorders the rest.
	const [deck, setDeck] = useState<SupportThread[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchSupportThreads()
			.then((threads) => {
				if (alive) setDeck(shuffle(threads));
			})
			.catch((e) => {
				if (alive) setError(e.message || String(e));
			});
		return () => {
			alive = false;
		};
	}, []);

	const [index, setIndex] = useState(0);
	const [dir, setDir] = useState<Action | null>(null);
	const [toast, setToast] = useState<{
		text: string;
		undo?: () => void;
	} | null>(null);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [busy, setBusy] = useState(false);
	// The busy flag, readable from long-lived closures (toast undo buttons).
	const busyRef = useRef(false);
	busyRef.current = busy;
	// Undo stack, newest last. Lives in a ref so toast/keyboard closures always
	// see the current stack; the length mirror re-renders the header ↩ button.
	const historyRef = useRef<UndoEntry[]>([]);
	const [historyLen, setHistoryLen] = useState(0);
	function pushHistory(e: UndoEntry) {
		historyRef.current.push(e);
		setHistoryLen(historyRef.current.length);
	}

	const cards = deck || [];
	const card: SupportThread | undefined = cards[index];
	const done = deck !== null && index >= cards.length;
	const next = cards[index + 1];

	// The card shows the whole conversation, so timelines are fetched lazily —
	// current card + one ahead — and cached for the visit (back stays instant).
	const [timelines, setTimelines] = useState<
		Record<string, PlainThread | "error">
	>({});
	const fetching = useRef(new Set<string>());
	useEffect(() => {
		let alive = true;
		for (const t of [card, next]) {
			if (!t || timelines[t.id] || fetching.current.has(t.id)) continue;
			fetching.current.add(t.id);
			fetchPlainThreadById(t.id)
				.then((thread) => {
					if (alive)
						setTimelines((prev) => ({ ...prev, [t.id]: thread || "error" }));
				})
				.catch(() => {
					if (alive) setTimelines((prev) => ({ ...prev, [t.id]: "error" }));
				});
		}
		return () => {
			alive = false;
		};
	}, [card?.id, next?.id, timelines]);

	// A new card always starts at the top (the deck area is one normal scroll).
	const deckScrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		deckScrollRef.current?.scrollTo(0, 0);
	}, [index]);

	function showToast(text: string, undo?: () => void) {
		if (toastTimer.current) clearTimeout(toastTimer.current);
		setToast({ text, undo });
		toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
	}
	useEffect(
		() => () => {
			if (toastTimer.current) clearTimeout(toastTimer.current);
		},
		[],
	);

	function advance(action: Action) {
		setDir(action);
		setIndex((i) => i + 1);
	}

	function customerLabel(t: SupportThread): string {
		return t.customer.name || t.customer.email || "customer";
	}

	function skip() {
		if (!card) return;
		advance("skip");
	}

	function spam() {
		if (!card || busy) return;
		const target = card;
		const at = index;
		setBusy(true);
		setPlainThreadSpamApi(target.id, true, currentUser)
			.then(() => {
				setBusy(false);
				pushHistory({ kind: "spam", t: target, at });
				advance("spam");
				showToast(`Marked ${customerLabel(target)} as spam`, undoLast);
			})
			.catch((e) => {
				setBusy(false);
				showToast(`Spam failed: ${e.message}`);
			});
	}

	function markDone() {
		if (!card || busy) return;
		const target = card;
		const at = index;
		setBusy(true);
		setPlainThreadStatusApi(target.id, "done", { user: currentUser })
			.then(() => {
				setBusy(false);
				pushHistory({ kind: "done", t: target, at });
				advance("done");
				showToast(`Marked "${target.title || customerLabel(target)}" Done`, undoLast);
			})
			.catch((e) => {
				setBusy(false);
				showToast(`Done failed: ${e.message}`);
			});
	}

	// Jump into the ticket's opensession session. The API reuses the newest
	// live session linked to the thread (instant) or boots a fresh triage run
	// (~15-60s) — keep the button in a visible in-progress state the whole way.
	// Navigating away leaves the deck; the ticket's status is untouched.
	const [opening, setOpening] = useState(false);
	function openSession() {
		if (!card || opening) return;
		const target = card;
		setOpening(true);
		startPlainTriageApi(target.id)
			.then((sessionId) => {
				setOpening(false);
				onOpenSession(sessionId);
			})
			.catch((e) => {
				setOpening(false);
				showToast(`Session failed: ${e.message}`);
			});
	}

	// Reverse the newest action on the stack and jump back to its card. Works
	// any time (z / header ↩ / the toast button) — not just while a toast shows.
	function undoLast() {
		if (busyRef.current) return;
		const entry = historyRef.current[historyRef.current.length - 1];
		if (!entry) return;
		const finish = (msg: string) => {
			historyRef.current.pop();
			setHistoryLen(historyRef.current.length);
			setBusy(false);
			setDir(null);
			setIndex(entry.at);
			showToast(msg);
		};
		const fail = (e: any) => {
			setBusy(false);
			showToast(`Undo failed: ${e.message || e}`);
		};
		setBusy(true);
		if (entry.kind === "spam") {
			// Plain reopens the customer's threads itself on unmark.
			setPlainThreadSpamApi(entry.t.id, false, currentUser)
				.then(() => finish(`Unmarked ${customerLabel(entry.t)} as spam`))
				.catch(fail);
		} else {
			setPlainThreadStatusApi(entry.t.id, "todo", { user: currentUser })
				.then(() => finish(`Back to Todo: ${entry.t.title || customerLabel(entry.t)}`))
				.catch(fail);
		}
	}

	function back() {
		setDir(null);
		setIndex((i) => Math.max(0, i - 1));
	}

	// Keyboard: →/k skip, ←/s spam, e session, d done, o Plain, b back, z undo;
	// Esc leaves the deck.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				return onExit();
			}
			const el = e.target as HTMLElement | null;
			if (
				el &&
				(el.tagName === "TEXTAREA" ||
					el.tagName === "INPUT" ||
					el.isContentEditable)
			)
				return;
			// Undo works even on the "Deck done" screen (no card left). Plain z,
			// and ⌘Z/^Z for muscle memory.
			if (e.key === "z") {
				e.preventDefault();
				return undoLast();
			}
			if (!card) return;
			if (e.key === "ArrowRight" || e.key === "k") {
				e.preventDefault();
				skip();
			} else if (e.key === "ArrowLeft" || e.key === "s") {
				e.preventDefault();
				spam();
			} else if (e.key === "e") {
				e.preventDefault();
				openSession();
			} else if (e.key === "d") {
				e.preventDefault();
				markDone();
			} else if (e.key === "o" || e.key === "p") {
				e.preventDefault();
				window.open(plainThreadUrl(card.id), "_blank", "noopener");
			} else if (e.key === "b") {
				e.preventDefault();
				back();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [card, index, busy, opening, onExit]);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col items-center bg-surface">
			{/* Header: back + "N Left" counter (same chrome as PR Tinder). */}
			<div className="flex w-full items-center justify-between px-4 py-3">
				<button
					className="flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-dim hover:bg-panel hover:text-fg"
					onClick={onExit}
					title="Back (Esc)"
					aria-label="Back"
				>
					<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
						<path
							d="M10 3.5 5.5 8l4.5 4.5"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
				<div className="text-sm font-semibold text-fg">
					{deck === null
						? "Support Tinder"
						: done
							? "Queue clear"
							: `${cards.length - index} Left`}
				</div>
				<button
					className="flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-dim hover:bg-panel hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
					onClick={undoLast}
					disabled={historyLen === 0 || busy}
					title="Undo last action (z)"
					aria-label="Undo last action"
				>
					<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
						<path
							d="M6.5 3.5 3 7l3.5 3.5M3 7h6.75A3.25 3.25 0 0 1 13 10.25v.25"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</div>

			{error ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
					<div className="text-sm font-semibold text-red">
						Couldn't load the queue
					</div>
					<div className="max-w-sm text-sm text-dim">{error}</div>
				</div>
			) : deck === null ? (
				<div className="flex flex-1 items-center justify-center text-sm text-faint">
					Dealing support tickets…
				</div>
			) : done ? (
				<DeckDone reviewed={index} onExit={onExit} />
			) : (
				/* The deck area scrolls like a normal page: the card is auto-height
				   (the full conversation, no inner scroll pane) and long threads
				   just flow past the fold. */
				<div
					ref={deckScrollRef}
					className="min-h-0 w-full flex-1 overflow-y-auto px-4 pb-4"
				>
					<div className="relative mx-auto w-full max-w-[640px]">
						{/* Peek of the next card behind the top one, for depth. */}
						{next && (
							<div
								className="absolute inset-x-0 -bottom-1.5 top-3 scale-x-[0.97] rounded-lg border border-line bg-panel opacity-60"
								aria-hidden
							/>
						)}
						<AnimatePresence initial={false} custom={dir}>
							<SwipeCard
								key={card!.id}
								thread={card!}
								timeline={timelines[card!.id]}
								custom={dir}
								onSkip={skip}
								onSpam={spam}
							/>
						</AnimatePresence>
					</div>
				</div>
			)}

			{/* Action bar (works without gestures). */}
			{deck !== null && !done && !error && (
				<div className="flex w-full max-w-[640px] items-stretch gap-2.5 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
					<button
						className="flex items-center justify-center rounded-lg border border-red/40 bg-red-soft px-4 py-3 text-sm font-semibold text-red hover:border-red/70 disabled:opacity-50"
						onClick={spam}
						disabled={busy}
						title="Mark customer as spam, closes the thread (← or s) — undo available"
					>
						Spam
					</button>
					<button
						className="flex-1 rounded-lg border border-line bg-panel px-3 py-3 text-sm font-semibold text-dim hover:bg-surface hover:text-green disabled:opacity-50"
						onClick={markDone}
						disabled={busy}
						title="Mark this thread Done (d) — undo available"
					>
						Done
					</button>
					<button
						className="flex-1 rounded-lg border border-line bg-panel px-3 py-3 text-sm font-semibold text-dim hover:bg-surface hover:text-fg disabled:opacity-50"
						onClick={openSession}
						disabled={opening}
						title="Open the ticket's opensession session — starts triage if none exists (e)"
					>
						{opening ? "Opening…" : "Session"}
					</button>
					<button
						className="flex-1 rounded-lg border border-line bg-panel px-3 py-3 text-sm font-semibold text-dim hover:bg-surface hover:text-fg"
						onClick={() =>
							card && window.open(plainThreadUrl(card.id), "_blank", "noopener")
						}
						title="Open in Plain (o)"
					>
						Plain
					</button>
					<button
						className="flex-1 rounded-lg bg-green px-4 py-3 text-sm font-semibold text-white hover:opacity-90"
						onClick={skip}
						title="Skip — leave the ticket as-is (→ or k)"
					>
						Skip
					</button>
				</div>
			)}

			{/* Undo / status toast. */}
			{toast && (
				<div className="pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2">
					<div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-line-strong bg-panel px-4 py-2.5 text-sm text-fg shadow-[0_6px_20px_rgba(0,0,0,0.35)]">
						{toast.text}
						{toast.undo && (
							<button
								className="font-semibold text-accent hover:underline"
								onClick={toast.undo}
							>
								Undo
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function SwipeCard({
	thread,
	timeline,
	custom,
	onSkip,
	onSpam,
}: {
	thread: SupportThread;
	timeline: PlainThread | "error" | undefined;
	custom: Action | null;
	onSkip: () => void;
	onSpam: () => void;
}) {
	const x = useMotionValue(0);
	const rotate = useTransform(x, [-260, 260], [-9, 9]);
	const spamTint = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);
	const skipTint = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);

	function onDragEnd(_: unknown, info: PanInfo) {
		if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY)
			onSpam();
		else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY)
			onSkip();
	}

	// Exit flings left for spam/done (dealt with and gone), right for skip.
	// The card lives in normal flow (auto height), so the exiting one is popped
	// to absolute for its fling — otherwise it would hold layout and shove the
	// incoming card down while both are mounted.
	const variants = {
		exit: (a: Action | null) => ({
			position: "absolute" as const,
			top: 0,
			left: 0,
			right: 0,
			x: a === "spam" || a === "done" ? -640 : 640,
			rotate: a === "spam" || a === "done" ? -12 : 12,
			opacity: 0,
			transition: { duration: 0.26 },
		}),
	};

	const prio = thread.priority != null ? PRIORITY[thread.priority] : null;

	return (
		<motion.div
			className="relative z-10 flex w-full touch-pan-y flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-[0_8px_30px_rgba(0,0,0,0.28)]"
			style={{ x, rotate }}
			drag="x"
			dragConstraints={{ left: 0, right: 0 }}
			dragElastic={0.7}
			onDragEnd={onDragEnd}
			variants={variants}
			initial={{ scale: 0.97, opacity: 0, y: 12 }}
			animate={{ scale: 1, opacity: 1, y: 0 }}
			exit="exit"
			custom={custom}
			transition={{ type: "spring", stiffness: 400, damping: 34 }}
		>
			{/* Swipe intent stamps. */}
			<motion.div
				className="pointer-events-none absolute left-4 top-16 z-10 rounded-md border-2 border-red px-2.5 py-1 text-sm font-bold tracking-wide text-red"
				style={{ opacity: spamTint, rotate: -12 }}
			>
				Spam
			</motion.div>
			<motion.div
				className="pointer-events-none absolute right-4 top-16 z-10 rounded-md border-2 border-green px-2.5 py-1 text-sm font-bold tracking-wide text-green"
				style={{ opacity: skipTint, rotate: 12 }}
			>
				Skip
			</motion.div>

			{/* Card head: customer, ages, priority, title. */}
			<div className="shrink-0 border-b border-line px-5 py-3.5">
				<div className="flex flex-wrap items-center gap-2 text-xs text-faint">
					<span className="font-semibold text-dim">
						{thread.customer.name || thread.customer.email || "Unknown customer"}
					</span>
					{thread.customer.name && thread.customer.email && (
						<span className="truncate">{thread.customer.email}</span>
					)}
					{thread.createdAt && (
						<>
							<span>·</span>
							<span className={ageTone(thread.createdAt)}>
								{ageLabel(thread.createdAt)} old
							</span>
						</>
					)}
					{prio && (
						<span
							className={`rounded border px-1.5 py-px text-meta font-bold tracking-[-0.01em] ${prio.cls}`}
						>
							{prio.label}
						</span>
					)}
				</div>
				<div className="mt-1 text-item-title font-semibold leading-snug text-fg">
					{thread.title || "(no subject)"}
				</div>
			</div>

			{/* Full-height conversation: every message renders, no inner scroll —
			    overflow flows into the deck's normal page scroll. */}
			<div className="flex flex-col gap-3 px-5 py-4">
				{timeline === undefined ? (
					thread.previewText ? (
						<div className="text-[13px] leading-relaxed text-dim">
							{thread.previewText}
						</div>
					) : (
						<div className="text-sm italic text-faint">Loading conversation…</div>
					)
				) : timeline === "error" ? (
					<div className="text-sm text-red">
						Couldn't load the conversation — open it in Plain.
					</div>
				) : timeline.entries.length === 0 ? (
					<div className="text-sm italic text-faint">
						No messages in this thread yet.
					</div>
				) : (
					timeline.entries.map((e) => <PlainEntryRow key={e.id} entry={e} />)
				)}
			</div>
		</motion.div>
	);
}

function DeckDone({
	reviewed,
	onExit,
}: {
	reviewed: number;
	onExit: () => void;
}) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
			<div className="text-4xl">🎉</div>
			<div className="text-item-title font-semibold text-fg">Queue clear</div>
			<div className="max-w-xs text-sm text-dim">
				{reviewed > 0
					? `You went through ${reviewed} ticket${reviewed === 1 ? "" : "s"}.`
					: "No Todo tickets right now."}
			</div>
			<button
				className="mt-2 rounded-lg bg-panel px-4 py-2.5 text-sm font-semibold text-fg hover:bg-surface"
				onClick={onExit}
			>
				Done
			</button>
		</div>
	);
}
