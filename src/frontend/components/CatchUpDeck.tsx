import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	AnimatePresence,
	motion,
	useMotionValue,
	useTransform,
	type PanInfo,
} from "motion/react";
import type {
	UnifiedSession,
	Project,
	TranscriptEntry,
	WSClientMessage,
} from "../lib/types";
import { fetchTranscript } from "../lib/api";
import { getReads, isUnread, markRead } from "../lib/reads";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { useCurrentUser } from "./UserPicker";
import { shortTime } from "../lib/time";

/**
 * Catch-up deck — a Slack-style "swipe through your unread" card stack. Each
 * card is one of your unread workspaces: you can read the full conversation and
 * reply inline, then act to advance:
 *   swipe left  / Archive      → archive the workspace, next
 *   swipe right / Mark as Read → mark it read, next
 *   tap up      / Keep Unread  → skip without changing state, next
 *   reply                      → sends the message, marks read, next
 * The queue is snapshotted once (frozen) so marking-read / archiving / live
 * activity doesn't reshuffle the cards out from under you as you go.
 */

const DEFAULT_REPO = "tella-fusion";
const SWIPE_DISTANCE = 110; // px of drag past which a release commits
const SWIPE_VELOCITY = 520; // px/s flick that commits regardless of distance

type Action = "archive" | "read" | "keep";

interface CatchupCard {
	key: string;
	workspaceId: string | null;
	name: string;
	chats: UnifiedSession[]; // createdAt asc
	repo: string;
	owner: string;
	lastActivity: string;
}

/** The chat a read/reply lands on: the freshest one in the workspace. */
function replyTarget(card: CatchupCard): UnifiedSession {
	return card.chats.reduce((best, c) =>
		c.lastActivity > best.lastActivity ? c : best,
	);
}

interface Props {
	sessions: UnifiedSession[];
	projects: Project[];
	/** WebSocket sender — used to post a reply into a session. */
	send: (msg: WSClientMessage) => void;
	connected: boolean;
	/** Archive every chat in a workspace (reuses App's archive handler). */
	onArchive: (chats: UnifiedSession[]) => void;
	/** Open the real session behind a card. */
	onOpenSession: (id: string) => void;
	/** Leave the deck (back / done). */
	onExit: () => void;
}

export function CatchUpDeck({
	sessions,
	projects,
	send,
	connected,
	onArchive,
	onOpenSession,
	onExit,
}: Props) {
	const currentUser = useCurrentUser();

	// The unread queue is snapshotted once and then frozen — subsequent refreshes
	// (from our own mark-read / archive / reply, or live WS activity) must not
	// reorder or drop cards mid-swipe. It's frozen on the first render where the
	// session list has actually loaded, NOT on the very first mount: a deep-link
	// to /backstage/catchup mounts before `sessions` arrives, and freezing []
	// there would strand the deck on "All caught up" forever.
	const frozen = useRef<CatchupCard[] | null>(null);
	const cards = useMemo<CatchupCard[]>(() => {
		if (frozen.current) return frozen.current;
		const reads = getReads();
		const me = currentUser.toLowerCase();
		const unread = sessions.filter(
			(s) =>
				!s.archived &&
				!s.automation &&
				!!s.startedBy &&
				s.startedBy.toLowerCase() === me &&
				isUnread(s.id, s.lastActivity, reads),
		);
		const groups = new Map<string, UnifiedSession[]>();
		const order: string[] = [];
		for (const s of unread) {
			const key = s.projectId ? `ws:${s.projectId}` : `chat:${s.id}`;
			if (!groups.has(key)) {
				groups.set(key, []);
				order.push(key);
			}
			groups.get(key)!.push(s);
		}
		const out = order.map((key): CatchupCard => {
			const chats = groups
				.get(key)!
				.slice()
				.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			const wsId = key.startsWith("ws:") ? key.slice(3) : null;
			const ws = wsId ? projects.find((p) => p.id === wsId) : null;
			return {
				key,
				workspaceId: wsId,
				name: ws?.name || chats[0].title,
				chats,
				repo: chats[0].repo || DEFAULT_REPO,
				owner: chats[0].startedBy || "",
				lastActivity: chats.reduce(
					(m, c) => (c.lastActivity > m ? c.lastActivity : m),
					"",
				),
			};
		});
		out.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
		// Freeze once the list has loaded (even to an empty queue — that's a
		// genuine "all caught up"). While it's still empty we keep recomputing.
		if (sessions.length > 0) frozen.current = out;
		return out;
	}, [sessions, currentUser, projects]);

	const [index, setIndex] = useState(0);
	const [dir, setDir] = useState<Action | null>(null);
	const card = cards[index];
	const total = cards.length;
	const remaining = total - index;

	function act(action: Action) {
		if (!card) return;
		if (action === "read") {
			for (const c of card.chats) markRead(c.id, c.lastActivity);
		} else if (action === "archive") {
			onArchive(card.chats);
		}
		setDir(action);
		setIndex((i) => i + 1);
	}

	// Send a reply into the freshest chat, mark the workspace read, advance.
	function reply(text: string) {
		if (!card) return;
		const target = replyTarget(card);
		send({
			type: "prompt",
			sessionId: target.id,
			content: text,
			user: currentUser,
		});
		act("read");
	}

	// Keyboard: ←/→ act, ↑ skip, esc leaves. (Space is left for the composer.)
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") return onExit();
			if (!card) return;
			// Don't hijack arrows while typing a reply.
			const el = e.target as HTMLElement | null;
			if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				act("archive");
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				act("read");
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				act("keep");
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [card, index]);

	const done = index >= total;
	const next = cards[index + 1];

	return (
		<div className="flex min-h-0 flex-1 flex-col items-center bg-surface">
			{/* Header: back + "N Left" counter (Slack-style). */}
			<div className="flex w-full items-center justify-between px-4 py-3">
				<button
					className="flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-dim hover:bg-panel hover:text-fg"
					onClick={onExit}
					title="Back"
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
					{done ? "All caught up" : `${remaining} Left`}
				</div>
				<div className="h-8 w-8" />
			</div>

			{done ? (
				<CaughtUp total={total} onExit={onExit} />
			) : (
				<div className="relative flex w-full max-w-[560px] flex-1 items-center justify-center px-4 pb-4">
					{/* Peek of the next card behind the top one, for depth. */}
					{next && (
						<div
							className="absolute inset-x-4 top-1 bottom-5 scale-[0.97] rounded-lg border border-line bg-panel opacity-60"
							aria-hidden
						/>
					)}
					<AnimatePresence initial={false} custom={dir}>
						<SwipeCard
							key={card.key}
							card={card}
							custom={dir}
							connected={connected}
							onArchive={() => act("archive")}
							onMarkRead={() => act("read")}
							onOpen={() => onOpenSession(replyTarget(card).id)}
							onReply={reply}
						/>
					</AnimatePresence>
				</div>
			)}

			{/* Action bar (works without gestures; mirrors the screenshot). */}
			{!done && (
				<div className="flex w-full max-w-[560px] items-stretch gap-2.5 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
					<button
						className="flex-1 rounded-lg border border-line bg-panel px-4 py-3 text-sm font-semibold text-dim hover:bg-surface hover:text-fg"
						onClick={() => act("keep")}
						title="Keep unread (↑)"
					>
						Keep Unread
					</button>
					<button
						className="flex items-center justify-center rounded-lg border border-red/40 bg-red-soft px-4 py-3 text-sm font-semibold text-red hover:border-red/70"
						onClick={() => act("archive")}
						title="Archive (←)"
						aria-label="Archive"
					>
						<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
							<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
							<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
							<path d="M6.5 8.5h3" strokeLinecap="round" />
						</svg>
					</button>
					<button
						className="flex-1 rounded-lg bg-green px-4 py-3 text-sm font-semibold text-white hover:opacity-90"
						onClick={() => act("read")}
						title="Mark as read (→)"
					>
						Mark as Read
					</button>
				</div>
			)}
		</div>
	);
}

function SwipeCard({
	card,
	custom,
	connected,
	onArchive,
	onMarkRead,
	onOpen,
	onReply,
}: {
	card: CatchupCard;
	custom: Action | null;
	connected: boolean;
	onArchive: () => void;
	onMarkRead: () => void;
	onOpen: () => void;
	onReply: (text: string) => void;
}) {
	const x = useMotionValue(0);
	const rotate = useTransform(x, [-260, 260], [-9, 9]);
	const archiveTint = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);
	const readTint = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);

	function onDragEnd(_: unknown, info: PanInfo) {
		if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY)
			onArchive();
		else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY)
			onMarkRead();
	}

	// Exit is a function variant so AnimatePresence's `custom` (the action taken)
	// picks the fling direction — left for archive, right for read, up for skip.
	const variants = {
		exit: (a: Action | null) => ({
			x: a === "archive" ? -560 : a === "read" ? 560 : 0,
			y: a === "keep" ? -560 : 0,
			rotate: a === "archive" ? -12 : a === "read" ? 12 : 0,
			opacity: 0,
			transition: { duration: 0.26 },
		}),
	};

	return (
		<motion.div
			className="absolute inset-x-4 top-1 bottom-5 flex touch-pan-y flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-[0_8px_30px_rgba(0,0,0,0.28)]"
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
				className="pointer-events-none absolute left-4 top-16 z-10 rounded-md border-2 border-red px-2.5 py-1 text-sm font-bold uppercase tracking-wide text-red"
				style={{ opacity: archiveTint, rotate: -12 }}
			>
				Archive
			</motion.div>
			<motion.div
				className="pointer-events-none absolute right-4 top-16 z-10 rounded-md border-2 border-green px-2.5 py-1 text-sm font-bold uppercase tracking-wide text-green"
				style={{ opacity: readTint, rotate: 12 }}
			>
				Read
			</motion.div>

			<CardBody
				card={card}
				connected={connected}
				onOpen={onOpen}
				onReply={onReply}
			/>
		</motion.div>
	);
}

function CardBody({
	card,
	connected,
	onOpen,
	onReply,
}: {
	card: CatchupCard;
	connected: boolean;
	onOpen: () => void;
	onReply: (text: string) => void;
}) {
	const target = replyTarget(card);
	const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		setEntries(null);
		fetchTranscript(target.id)
			.then((e) => {
				if (alive) setEntries(e);
			})
			.catch(() => {
				if (alive) setEntries([]);
			});
		return () => {
			alive = false;
		};
	}, [target.id]);

	// Open on the newest message (the unread part), like Slack lands you at the
	// bottom of the thread.
	useEffect(() => {
		if (entries && scrollRef.current)
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [entries]);

	const meta = [
		card.repo,
		card.chats.length > 1 ? `${card.chats.length} chats` : null,
		card.lastActivity ? shortTime(card.lastActivity) : null,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<>
			<button
				className="flex w-full shrink-0 flex-col items-start gap-0.5 border-b border-line bg-transparent px-5 py-3.5 text-left"
				onClick={onOpen}
				title="Open the full session"
			>
				<span className="line-clamp-1 text-[15px] font-semibold text-fg">
					{card.name}
				</span>
				<span className="text-xs text-faint">{meta}</span>
			</button>

			<div
				ref={scrollRef}
				className="catchup-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3"
			>
				{entries === null ? (
					<div className="space-y-2">
						<div className="h-3 w-1/3 animate-pulse rounded bg-surface" />
						<div className="h-3 w-full animate-pulse rounded bg-surface" />
						<div className="h-3 w-4/5 animate-pulse rounded bg-surface" />
					</div>
				) : entries.length === 0 ? (
					<div className="text-sm text-faint">No messages yet.</div>
				) : (
					<TranscriptBlocks entries={entries} owner={card.owner} />
				)}
			</div>

			<ReplyBox connected={connected} onSend={onReply} />
		</>
	);
}

function ReplyBox({
	connected,
	onSend,
}: {
	connected: boolean;
	onSend: (text: string) => void;
}) {
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);

	function submit() {
		const t = text.trim();
		if (!t || !connected) return;
		onSend(t);
		setText("");
	}

	function autosize(el: HTMLTextAreaElement) {
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
	}

	return (
		// Stop pointerdown from reaching the card's drag handler so typing and
		// text selection in the reply box never start a swipe.
		<div
			className="shrink-0 border-t border-line p-2.5"
			onPointerDownCapture={(e) => e.stopPropagation()}
		>
			<div className="flex items-end gap-2 rounded-lg border border-line bg-surface px-3 py-2">
				<textarea
					ref={ref}
					rows={1}
					value={text}
					placeholder={connected ? "Reply…" : "Not connected"}
					disabled={!connected}
					onChange={(e) => {
						setText(e.target.value);
						autosize(e.target);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent text-sm leading-snug text-fg outline-none placeholder:text-faint disabled:opacity-60"
				/>
				<button
					className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-white disabled:opacity-40"
					onClick={submit}
					disabled={!connected || !text.trim()}
					title="Send reply (Enter)"
					aria-label="Send reply"
				>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<path
							d="M2.5 8h9M7.5 4l4 4-4 4"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</div>
		</div>
	);
}

function CaughtUp({ total, onExit }: { total: number; onExit: () => void }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
			<div className="text-4xl">✨</div>
			<div className="text-lg font-semibold text-fg">All caught up</div>
			<div className="max-w-xs text-sm text-dim">
				{total > 0
					? `You went through ${total} workspace${total === 1 ? "" : "s"}.`
					: "Nothing unread right now."}
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
