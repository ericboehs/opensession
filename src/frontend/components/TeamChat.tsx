import React, {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type {
	ChatMessage,
	ChatReplyTo,
	UnifiedSession,
	WSClientMessage,
	WSServerMessage,
} from "../lib/types";
import type { ChatImage } from "../lib/types";
import {
	fetchChatMessagesApi,
	postChatMessageApi,
	toggleChatReactionApi,
	uploadChatImageApi,
	chatImageUrl,
} from "../lib/api";
import { imageFilesFromPaste } from "../lib/images";
import { TEAM } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import {
	IconArrowUp,
	IconEmoji,
	IconImage,
	IconMessage,
	IconReply,
	IconX,
} from "./icons";
import { cn } from "../ui/cn";

/**
 * Native Backstage team chat (nothing to do with Slack). One component, two
 * rooms: the team-wide Watercooler (`channel="watercooler"`, page variant,
 * left-sidebar entry) and a per-session room (`channel="session:<id>"`, panel
 * variant, the session panel's Chat tab). Messages arrive live over the app
 * WebSocket; typing indicators are ephemeral relays. `@Name` tags a teammate
 * (they get a web push), `@session:<id>` tags a session and renders as a chip
 * that navigates there — both inserted via the composer's `@` autocomplete.
 *
 * Slack-style affordances: hover a message for quick reactions, "reply in
 * thread" (replies collapse under the parent, opened in a side panel), and
 * quote-reply (a snapshot of the original rendered above the new message).
 */

interface Props {
	channel: string;
	user: string;
	/** All sessions — powers @-session autocomplete and tag-chip titles. */
	sessions: UnifiedSession[];
	/** Workspace names — lets @-session search match on the workspace too. */
	projects?: Array<{ id: string; name: string }>;
	send: (msg: WSClientMessage) => void;
	addHandler: (h: (msg: WSServerMessage) => void) => () => void;
	onOpenSession: (id: string) => void;
	/** "page" = full detail-pane view (Watercooler); "panel" = right-rail tab. */
	variant?: "page" | "panel";
}

type Suggestion =
	| { kind: "person"; name: string }
	| { kind: "session"; id: string; title: string; workspace?: string };

// The reaction picker's quick set — the toolbar also surfaces the first two.
const QUICK_EMOJI = ["👍", "✅", "❤️", "😂", "🎉", "👀", "🚀", "🙏"];

/**
 * The active `@`-mention token at the caret, or null. Spaces are allowed in
 * the query (session titles are multi-word) — the popup simply closes when
 * nothing matches anymore, so ordinary prose after a completed tag doesn't
 * keep it open. Capped so a stray `@` far back doesn't hijack typing forever.
 */
function mentionAt(
	value: string,
	caret: number,
): { start: number; query: string } | null {
	let i = caret - 1;
	let len = 0;
	while (i >= 0 && len < 60) {
		const ch = value[i];
		if (ch === "@") {
			const prev = i > 0 ? value[i - 1] : " ";
			if (prev === " " || prev === "\n") {
				const query = value.slice(i + 1, caret);
				// "@ " is punctuation, not a mention being typed.
				if (query.startsWith(" ")) return null;
				return { start: i, query };
			}
			return null;
		}
		if (ch === "\n") return null;
		i--;
		len++;
	}
	return null;
}

function timeOf(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function dayLabel(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	const yesterday = new Date(today.getTime() - 86400_000);
	if (d.toDateString() === today.toDateString()) return "Today";
	if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
	return d.toLocaleDateString([], {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
}

/** Short label standing in for a message with no text (image-only). */
function excerptOf(m: ChatMessage): string {
	if (m.text) return m.text.length > 200 ? `${m.text.slice(0, 199)}…` : m.text;
	return m.images?.length ? "🖼️ image" : "";
}

// One token per @-tag: session chips first (longer match), then people.
const TAG_RE = /(@session:[A-Za-z0-9._-]+|@[A-Za-z][\w.-]*)/g;
const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

/** Plain text with bare URLs rendered as links (Slack-style). */
function linkify(text: string): React.ReactNode {
	const segs = text.split(URL_RE);
	if (segs.length === 1) return text;
	return segs.map((s, i) =>
		/^https?:\/\//.test(s) ? (
			<a
				key={i}
				href={s}
				target="_blank"
				rel="noreferrer"
				className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
			>
				{s}
			</a>
		) : (
			<React.Fragment key={i}>{s}</React.Fragment>
		),
	);
}

/** Message text with `@Name` / `@session:<id>` tokens rendered as tags. */
function MessageText({
	text,
	me,
	sessionLabels,
	onOpenSession,
}: {
	text: string;
	me: string;
	/** id → sidebar-style label (workspace name when it has one, else title). */
	sessionLabels: Map<string, { label: string; title: string }>;
	onOpenSession: (id: string) => void;
}) {
	const parts = text.split(TAG_RE);
	return (
		<>
			{parts.map((p, i) => {
				if (p.startsWith("@session:")) {
					const id = p.slice("@session:".length);
					const s = sessionLabels.get(id);
					return (
						<button
							key={i}
							className="mx-0.5 inline-flex max-w-60 items-baseline gap-1 rounded-sm border border-line bg-panel px-1.5 align-baseline text-[12px] font-medium text-fg hover:border-line-strong hover:bg-hover"
							onClick={() => onOpenSession(id)}
							title={s ? `Open “${s.title}”` : "Open session"}
						>
							<span className="translate-y-0.5 self-center text-dim">
								<IconMessage size={13} />
							</span>
							<span className="truncate">
								{s?.label || `${id.slice(0, 8)}…`}
							</span>
						</button>
					);
				}
				if (/^@[A-Za-z]/.test(p)) {
					const name = p.slice(1);
					const member = TEAM.find(
						(n) => n.toLowerCase() === name.toLowerCase(),
					);
					if (member) {
						const isMe = member.toLowerCase() === me.toLowerCase();
						return (
							<span
								key={i}
								className={cn(
									"rounded-xs px-0.5 font-semibold text-accent",
									isMe && "bg-accent-soft",
								)}
							>
								@{member}
							</span>
						);
					}
				}
				return <React.Fragment key={i}>{linkify(p)}</React.Fragment>;
			})}
		</>
	);
}

// ── Composer ────────────────────────────────────────────────────────────────
// Extracted so the main room and an open thread each get their own instance
// (own draft, own mention popup, own pending images).

interface ComposerProps {
	channel: string;
	user: string;
	placeholder: string;
	sessions: UnifiedSession[];
	workspaceNames: Map<string, string>;
	send: (msg: WSClientMessage) => void;
	autoFocus?: boolean;
	/** Quote chip shown above the input; sent along with the next message. */
	replyTo?: ChatReplyTo | null;
	onCancelReply?: () => void;
	/** Posts the message; throws to surface a send error under the input. */
	onSend: (text: string, images: ChatImage[]) => Promise<void>;
}

function ChatComposer({
	channel,
	user,
	placeholder,
	sessions,
	workspaceNames,
	send,
	autoFocus,
	replyTo,
	onCancelReply,
	onSend,
}: ComposerProps) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<ChatImage[]>([]);
	const [uploading, setUploading] = useState(0);
	const [posting, setPosting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [mention, setMention] = useState<{
		start: number;
		query: string;
	} | null>(null);
	const [mentionIdx, setMentionIdx] = useState(0);
	// The popup is portaled to <body> with fixed viewport coords measured from
	// the input wrapper — otherwise the session-viewer tab panel's overflow
	// clips it (it grows upward past the panel's top edge). Null until measured.
	const mentionWrapRef = useRef<HTMLDivElement | null>(null);
	const [mentionPos, setMentionPos] = useState<React.CSSProperties | null>(
		null,
	);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const lastTypingSentRef = useRef(0);

	// Auto-grow the single-row textarea with the draft — without this a
	// Shift+Enter newline lands invisibly (the box stays one line tall).
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	}, [text]);

	useEffect(() => {
		if (autoFocus) inputRef.current?.focus();
	}, [autoFocus]);

	// Quoting a message should put the caret where you'll type the reply.
	useEffect(() => {
		if (replyTo) inputRef.current?.focus();
	}, [replyTo]);

	// Upload picked/pasted/dropped images and stage them as pending attachments.
	async function addImages(files: File[] | FileList) {
		const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
		if (!imgs.length) return;
		setError(null);
		setUploading((n) => n + imgs.length);
		for (const f of imgs) {
			try {
				const ref = await uploadChatImageApi(f);
				setImages((prev) => [...prev, ref]);
			} catch (e: any) {
				setError(e?.message || "Image upload failed");
			} finally {
				setUploading((n) => n - 1);
			}
		}
	}

	const suggestions = useMemo<Suggestion[]>(() => {
		if (!mention) return [];
		const q = mention.query.toLowerCase().trim();
		const tokens = q.split(/\s+/).filter(Boolean);
		// People are single names — only offer them while the query is one word.
		const people: Suggestion[] =
			tokens.length > 1
				? []
				: TEAM.filter((n) => n.toLowerCase().startsWith(q)).map((name) => ({
						kind: "person",
						name,
					}));
		// Sessions: every query word must appear in the title, workspace name, or
		// id (AND-match, so multi-word fragments of a title work). On a bare "@",
		// surface the recent few so the affordance is discoverable.
		const live = sessions
			.filter((s) => !s.archived)
			.sort((a, b) =>
				(b.lastActivity || "").localeCompare(a.lastActivity || ""),
			);
		const matched = tokens.length
			? live.filter((s) => {
					const hay =
						`${s.title} ${(s.projectId && workspaceNames.get(s.projectId)) || ""} ${s.id}`.toLowerCase();
					return tokens.every((t) => hay.includes(t));
				})
			: live.slice(0, 3);
		const chats: Suggestion[] = matched.slice(0, 6).map((s) => ({
			kind: "session",
			id: s.id,
			// Sidebar-style hierarchy: workspace name first, chat title second.
			title: s.title,
			workspace: (s.projectId && workspaceNames.get(s.projectId)) || undefined,
		}));
		return [...people, ...chats].slice(0, 9);
	}, [mention, sessions, workspaceNames]);

	const mentionOpen = !!mention && suggestions.length > 0;

	// Position the portaled popup against the input wrapper: opens upward by
	// default, flips down when there isn't room above, and caps its height so it
	// scrolls internally instead of overrunning (and being clipped by) the panel.
	useLayoutEffect(() => {
		if (!mentionOpen) {
			setMentionPos(null);
			return;
		}
		const measure = () => {
			const el = mentionWrapRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const POPUP_MAX = 260;
			const spaceAbove = rect.top;
			const spaceBelow = window.innerHeight - rect.bottom;
			const down = spaceAbove < POPUP_MAX && spaceBelow > spaceAbove;
			setMentionPos({
				left: rect.left,
				width: Math.min(288, rect.width),
				...(down
					? {
							top: rect.bottom + 6,
							maxHeight: Math.min(POPUP_MAX, spaceBelow - 12),
						}
					: {
							bottom: window.innerHeight - rect.top + 6,
							maxHeight: Math.min(POPUP_MAX, spaceAbove - 12),
						}),
			});
		};
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [mentionOpen, suggestions.length]);

	function syncMention() {
		const el = inputRef.current;
		if (!el) return;
		setMention(mentionAt(el.value, el.selectionStart ?? el.value.length));
		setMentionIdx(0);
	}

	function applySuggestion(s: Suggestion) {
		if (!mention) return;
		const insert = s.kind === "person" ? `@${s.name}` : `@session:${s.id}`;
		const before = text.slice(0, mention.start);
		const after = text.slice(
			(inputRef.current?.selectionStart ?? text.length) as number,
		);
		setText(`${before}${insert} ${after}`);
		setMention(null);
		const caret = before.length + insert.length + 1;
		requestAnimationFrame(() => {
			const el = inputRef.current;
			if (el) {
				el.focus();
				el.setSelectionRange(caret, caret);
			}
		});
	}

	function noteTyping() {
		const now = Date.now();
		if (now - lastTypingSentRef.current < 2000) return;
		lastTypingSentRef.current = now;
		send({ type: "chat_typing", channel, user });
	}

	async function submit() {
		const t = text.trim();
		if ((!t && images.length === 0) || posting || uploading > 0) return;
		setPosting(true);
		setError(null);
		try {
			await onSend(t, images);
			setText("");
			setImages([]);
			setMention(null);
		} catch (e: any) {
			setError(e?.message || "Send failed");
		} finally {
			setPosting(false);
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}

	return (
		<div>
			<div className="relative" ref={mentionWrapRef}>
				{mentionOpen &&
					mentionPos &&
					createPortal(
						<div
							role="listbox"
							className="fixed z-[7000] overflow-y-auto rounded-md border border-line-strong bg-panel py-1 shadow-lg"
							style={mentionPos}
						>
							{suggestions.map((s, i) => (
								<div
									key={s.kind === "person" ? `p:${s.name}` : `s:${s.id}`}
									className={cn(
										"flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px] font-medium text-fg",
										i === mentionIdx && "bg-active",
									)}
									onMouseDown={(e) => {
										e.preventDefault();
										applySuggestion(s);
									}}
									onMouseEnter={() => setMentionIdx(i)}
								>
									{s.kind === "person" ? (
										<>
											<UserAvatar name={s.name} size={20} />
											<span>{s.name}</span>
										</>
									) : (
										<>
											<span className="grid h-5 w-5 shrink-0 place-items-center text-dim">
												<IconMessage size={16} />
											</span>
											<span className="truncate">
												{s.workspace || s.title}
											</span>
											{s.workspace && (
												<span className="ml-auto max-w-32 shrink-0 truncate text-[11px] text-faint">
													{s.title}
												</span>
											)}
										</>
									)}
								</div>
							))}
						</div>,
						document.body,
					)}
				<div
					className="rounded-lg border border-line bg-panel p-2 focus-within:border-line-strong"
					onDrop={(e) => {
						if (e.dataTransfer?.files?.length) {
							e.preventDefault();
							void addImages(e.dataTransfer.files);
						}
					}}
					onDragOver={(e) => {
						if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
					}}
				>
					{/* Quote chip: the message the next send replies to. */}
					{replyTo && (
						<div className="mb-2 flex items-start gap-2 rounded-md border-l-2 border-accent bg-hover px-2.5 py-1.5">
							<div className="min-w-0 flex-1">
								<div className="text-[11px] font-semibold text-accent">
									Replying to {replyTo.user}
								</div>
								<div className="truncate text-xs font-medium text-dim">
									{replyTo.text || "🖼️ image"}
								</div>
							</div>
							<button
								type="button"
								className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim hover:bg-panel hover:text-fg"
								onClick={onCancelReply}
								aria-label="Cancel reply"
							>
								<IconX size={20} />
							</button>
						</div>
					)}
					{/* Pending image attachments (uploaded, not yet sent). */}
					{(images.length > 0 || uploading > 0) && (
						<div className="mb-2 flex flex-wrap gap-1.5 px-1">
							{images.map((img, i) => (
								<div
									key={img.id}
									className="group relative h-14 w-14 overflow-hidden rounded-md border border-line"
								>
									<img
										src={chatImageUrl(img.id)}
										alt={img.name}
										className="h-full w-full object-cover"
									/>
									<button
										type="button"
										className="absolute right-0.5 top-0.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
										onClick={() =>
											setImages((prev) => prev.filter((_, idx) => idx !== i))
										}
										aria-label={`Remove ${img.name}`}
									>
										<IconX size={20} />
									</button>
								</div>
							))}
							{Array.from({ length: uploading }).map((_, i) => (
								<div
									key={`up:${i}`}
									className="grid h-14 w-14 place-items-center rounded-md border border-dashed border-line text-[10px] font-medium text-faint"
								>
									…
								</div>
							))}
						</div>
					)}
					<div className="flex items-end gap-2">
						<button
							type="button"
							className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-fg disabled:opacity-40"
							onClick={() => fileInputRef.current?.click()}
							disabled={posting}
							aria-label="Attach image"
						>
							<IconImage size={20} />
						</button>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							hidden
							onChange={(e) => {
								if (e.target.files?.length) void addImages(e.target.files);
								e.target.value = "";
							}}
						/>
						<textarea
							ref={inputRef}
							className="max-h-40 min-h-[32px] flex-1 resize-none border-0 bg-transparent px-1 py-[7px] text-[13px] font-medium leading-snug text-fg shadow-none outline-none placeholder:text-faint"
							aria-label="Message"
							rows={1}
							placeholder={placeholder}
							value={text}
							disabled={posting}
							onChange={(e) => {
								setText(e.target.value);
								if (e.target.value.trim()) noteTyping();
								requestAnimationFrame(syncMention);
							}}
							onClick={syncMention}
							onPaste={(e) => {
								const pasted = imageFilesFromPaste(e);
								if (pasted.length) {
									e.preventDefault();
									void addImages(pasted);
								}
							}}
							onKeyUp={(e) => {
								if (
									!["Enter", "ArrowUp", "ArrowDown", "Tab"].includes(e.key)
								)
									syncMention();
							}}
							onKeyDown={(e) => {
								if (mention && suggestions.length > 0) {
									if (e.key === "ArrowDown") {
										e.preventDefault();
										setMentionIdx((i) => (i + 1) % suggestions.length);
										return;
									}
									if (e.key === "ArrowUp") {
										e.preventDefault();
										setMentionIdx(
											(i) =>
												(i - 1 + suggestions.length) % suggestions.length,
										);
										return;
									}
									if (e.key === "Enter" || e.key === "Tab") {
										e.preventDefault();
										applySuggestion(suggestions[mentionIdx]);
										return;
									}
									if (e.key === "Escape") {
										// Consume it — Escape otherwise closes an open thread.
										e.stopPropagation();
										setMention(null);
										return;
									}
								}
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									submit();
								}
							}}
						/>
						<button
							className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-white disabled:opacity-40"
							onClick={submit}
							disabled={
								posting ||
								uploading > 0 ||
								(!text.trim() && images.length === 0)
							}
							aria-label="Send"
						>
							<IconArrowUp size={20} />
						</button>
					</div>
				</div>
			</div>
			{error && (
				<div className="px-1 pt-1 text-xs font-medium text-red">{error}</div>
			)}
		</div>
	);
}

// ── Message row ─────────────────────────────────────────────────────────────

interface RowProps {
	m: ChatMessage;
	/** Continuation of the same sender within 5 minutes — no avatar/header. */
	compact: boolean;
	me: string;
	sessionLabels: Map<string, { label: string; title: string }>;
	onOpenSession: (id: string) => void;
	onReact: (m: ChatMessage, emoji: string) => void;
	onQuote: (m: ChatMessage) => void;
	/** Present in the main list only — the thread panel has no nested threads. */
	onOpenThread?: (id: string) => void;
	/** This message's thread replies (main list only) — powers the summary. */
	replies?: ChatMessage[];
	onJumpTo: (id: string) => void;
	highlight: boolean;
	/** DOM id prefix — distinct per surface so parent rows rendered in both the
	 *  main list and the thread panel don't collide. */
	idPrefix: string;
}

function MessageRow({
	m,
	compact,
	me,
	sessionLabels,
	onOpenSession,
	onReact,
	onQuote,
	onOpenThread,
	replies,
	onJumpTo,
	highlight,
	idPrefix,
}: RowProps) {
	const [picker, setPicker] = useState(false);
	const reactionEntries = Object.entries(m.reactions || {});
	const lastReply = replies?.length ? replies[replies.length - 1] : null;
	const replierNames = useMemo(() => {
		const seen: string[] = [];
		for (const r of replies || []) {
			if (!seen.includes(r.user)) seen.push(r.user);
			if (seen.length === 3) break;
		}
		return seen;
	}, [replies]);

	return (
		<div
			id={`${idPrefix}-${m.id}`}
			className={cn(
				"group relative -mx-2 flex gap-2.5 rounded-md px-2 py-0.5 transition-colors",
				compact ? "mt-0.5" : "mt-3",
				highlight ? "bg-accent-soft" : "hover:bg-hover",
			)}
			onMouseLeave={() => setPicker(false)}
		>
			{/* Hover toolbar (Slack-style): quick reactions, thread, quote. */}
			<div
				className={cn(
					"absolute -top-3.5 right-2 z-10 items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5 shadow-sm",
					picker ? "flex" : "hidden group-hover:flex",
				)}
			>
				{QUICK_EMOJI.slice(0, 2).map((e) => (
					<button
						key={e}
						type="button"
						className="grid h-7 w-7 place-items-center rounded-md text-[15px] leading-none hover:bg-hover"
						onClick={() => onReact(m, e)}
						aria-label={`React ${e}`}
					>
						{e}
					</button>
				))}
				<button
					type="button"
					className={cn(
						"grid h-7 w-7 place-items-center rounded-md text-dim hover:bg-hover hover:text-fg",
						picker && "bg-active text-fg",
					)}
					onClick={() => setPicker((v) => !v)}
					aria-label="Add reaction"
					title="Add reaction"
				>
					<IconEmoji size={20} />
				</button>
				{onOpenThread && (
					<button
						type="button"
						className="grid h-7 w-7 place-items-center rounded-md text-dim hover:bg-hover hover:text-fg"
						onClick={() => onOpenThread(m.id)}
						aria-label="Reply in thread"
						title="Reply in thread"
					>
						<IconMessage size={20} />
					</button>
				)}
				<button
					type="button"
					className="grid h-7 w-7 place-items-center rounded-md text-dim hover:bg-hover hover:text-fg"
					onClick={() => onQuote(m)}
					aria-label="Quote reply"
					title="Quote reply"
				>
					<IconReply size={20} />
				</button>
			</div>
			{picker && (
				<div className="absolute right-2 top-4 z-20 flex gap-0.5 rounded-lg border border-line-strong bg-panel p-1 shadow-lg">
					{QUICK_EMOJI.map((e) => (
						<button
							key={e}
							type="button"
							className="grid h-8 w-8 place-items-center rounded-md text-[17px] leading-none hover:bg-hover"
							onClick={() => {
								onReact(m, e);
								setPicker(false);
							}}
							aria-label={`React ${e}`}
						>
							{e}
						</button>
					))}
				</div>
			)}

			<div className="w-7 shrink-0 pt-0.5">
				{!compact && <UserAvatar name={m.user} size={28} />}
			</div>
			<div className="min-w-0 flex-1">
				{!compact && (
					<div className="flex items-baseline gap-2">
						<span className="text-[13px] font-semibold text-fg">{m.user}</span>
						<span className="text-[11px] font-medium text-faint">
							{timeOf(m.ts)}
						</span>
					</div>
				)}
				{/* Quoted original (Slack-style reply) — click jumps to it. */}
				{m.replyTo && (
					<button
						type="button"
						className="mt-0.5 flex w-fit max-w-full items-baseline gap-1.5 rounded-r-md border-l-2 border-line-strong bg-hover px-2 py-1 text-left hover:border-accent"
						onClick={() => onJumpTo(m.replyTo!.id)}
						title="Jump to original message"
					>
						<span className="shrink-0 text-[11px] font-semibold text-dim">
							{m.replyTo.user}
						</span>
						<span className="truncate text-xs font-medium text-dim">
							{m.replyTo.text || "🖼️ image"}
						</span>
					</button>
				)}
				{m.text && (
					<div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
						<MessageText
							text={m.text}
							me={me}
							sessionLabels={sessionLabels}
							onOpenSession={onOpenSession}
						/>
					</div>
				)}
				{m.images && m.images.length > 0 && (
					<div className="mt-1 flex flex-wrap gap-1.5">
						{m.images.map((img) => (
							<a
								key={img.id}
								href={chatImageUrl(img.id)}
								target="_blank"
								rel="noreferrer"
								className="block overflow-hidden rounded-md border border-line"
							>
								<img
									src={chatImageUrl(img.id)}
									alt={img.name}
									className="max-h-60 max-w-[min(20rem,100%)] object-cover"
									loading="lazy"
								/>
							</a>
						))}
					</div>
				)}
				{/* Reaction pills. */}
				{reactionEntries.length > 0 && (
					<div className="mt-1 flex flex-wrap items-center gap-1">
						{reactionEntries.map(([emoji, users]) => {
							const mine = users.some(
								(u) => u.toLowerCase() === me.toLowerCase(),
							);
							return (
								<button
									key={emoji}
									type="button"
									className={cn(
										"flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-semibold",
										mine
											? "border-accent bg-accent-soft text-fg"
											: "border-line bg-panel text-dim hover:border-line-strong",
									)}
									onClick={() => onReact(m, emoji)}
									title={`${users.join(", ")} reacted with ${emoji}`}
								>
									<span className="text-[13px] leading-none">{emoji}</span>
									{users.length}
								</button>
							);
						})}
						<button
							type="button"
							className="grid h-6 w-6 place-items-center rounded-full border border-dashed border-line text-dim opacity-0 hover:border-line-strong hover:text-fg group-hover:opacity-100"
							onClick={() => setPicker((v) => !v)}
							aria-label="Add reaction"
						>
							<IconEmoji size={20} />
						</button>
					</div>
				)}
				{/* Thread summary — opens the thread panel. */}
				{onOpenThread && replies && replies.length > 0 && (
					<button
						type="button"
						className="-ml-1.5 mt-1 flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 text-xs font-semibold text-accent hover:border-line hover:bg-panel hover:shadow-sm"
						onClick={() => onOpenThread(m.id)}
					>
						<span className="flex -space-x-1">
							{replierNames.map((n) => (
								<span
									key={n}
									className="rounded-full ring-2 ring-surface"
								>
									<UserAvatar name={n} size={18} />
								</span>
							))}
						</span>
						{replies.length} {replies.length === 1 ? "reply" : "replies"}
						{lastReply && (
							<span className="font-medium text-faint">
								· {timeOf(lastReply.ts)}
							</span>
						)}
					</button>
				)}
			</div>
		</div>
	);
}

// ── Room ────────────────────────────────────────────────────────────────────

export function TeamChat({
	channel,
	user,
	sessions,
	projects,
	send,
	addHandler,
	onOpenSession,
	variant = "page",
}: Props) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(true);
	// user → expiry stamp of their "typing…" signal.
	const [typers, setTypers] = useState<Record<string, number>>({});
	// Open thread = a top-level message id whose replies show in the panel.
	const [openThread, setOpenThread] = useState<string | null>(null);
	const [replyToMain, setReplyToMain] = useState<ChatReplyTo | null>(null);
	const [replyToThread, setReplyToThread] = useState<ChatReplyTo | null>(null);
	// Briefly flashed after jump-to-quote so the eye lands on the original.
	const [highlightId, setHighlightId] = useState<string | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const threadBodyRef = useRef<HTMLDivElement | null>(null);

	const workspaceNames = useMemo(
		() => new Map((projects || []).map((p) => [p.id, p.name])),
		[projects],
	);

	// Chip labels mirror the left sidebar: the workspace name is what people
	// recognize, the chat's own (often auto-generated) title is secondary.
	const sessionLabels = useMemo(
		() =>
			new Map(
				sessions.map((s) => {
					const ws = (s.projectId && workspaceNames.get(s.projectId)) || "";
					return [s.id, { label: ws || s.title, title: s.title }];
				}),
			),
		[sessions, workspaceNames],
	);

	// Thread replies live in the same store/tail; the main list shows only
	// top-level messages, with replies grouped under their parent.
	const topLevel = useMemo(
		() => messages.filter((m) => !m.threadId),
		[messages],
	);
	const threadMap = useMemo(() => {
		const map = new Map<string, ChatMessage[]>();
		for (const m of messages) {
			if (!m.threadId) continue;
			const list = map.get(m.threadId);
			if (list) list.push(m);
			else map.set(m.threadId, [m]);
		}
		return map;
	}, [messages]);

	const threadParent = openThread
		? messages.find((m) => m.id === openThread) || null
		: null;
	const threadReplies = openThread ? threadMap.get(openThread) || [] : [];

	// History on channel switch.
	useEffect(() => {
		let alive = true;
		setMessages([]);
		setTypers({});
		setOpenThread(null);
		setReplyToMain(null);
		setReplyToThread(null);
		setHighlightId(null);
		setLoading(true);
		fetchChatMessagesApi(channel)
			.then((m) => alive && setMessages(m))
			.catch(() => {})
			.finally(() => alive && setLoading(false));
		return () => {
			alive = false;
		};
	}, [channel]);

	// Live messages + in-place updates (reactions) + typing over the app socket.
	useEffect(() => {
		return addHandler((msg) => {
			if (msg.type === "chat_message" && msg.channel === channel) {
				setMessages((prev) =>
					prev.some((m) => m.id === msg.message.id)
						? prev
						: [...prev, msg.message],
				);
				// Their message landed — the "typing…" is resolved.
				setTypers((prev) => {
					if (!(msg.message.user in prev)) return prev;
					const next = { ...prev };
					delete next[msg.message.user];
					return next;
				});
			} else if (
				msg.type === "chat_message_updated" &&
				msg.channel === channel
			) {
				setMessages((prev) =>
					prev.map((m) => (m.id === msg.message.id ? msg.message : m)),
				);
			} else if (
				msg.type === "chat_typing" &&
				msg.channel === channel &&
				msg.user !== user
			) {
				setTypers((prev) => ({ ...prev, [msg.user]: Date.now() + 4000 }));
			}
		});
	}, [addHandler, channel, user]);

	// Expire stale typing signals.
	useEffect(() => {
		if (!Object.keys(typers).length) return;
		const t = setInterval(() => {
			setTypers((prev) => {
				const now = Date.now();
				const fresh = Object.entries(prev).filter(([, exp]) => exp > now);
				return fresh.length === Object.keys(prev).length
					? prev
					: Object.fromEntries(fresh);
			});
		}, 1000);
		return () => clearInterval(t);
	}, [typers]);

	const typingNames = Object.keys(typers);

	// Stick to the newest message — but only when already near the bottom, so a
	// live message doesn't yank a reader up out of scrollback.
	const loadedOnce = useRef(false);
	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		if (!loadedOnce.current && messages.length) {
			loadedOnce.current = true;
			el.scrollTop = el.scrollHeight;
			return;
		}
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
		if (nearBottom) el.scrollTop = el.scrollHeight;
	}, [messages, typingNames.length]);
	useEffect(() => {
		loadedOnce.current = false;
	}, [channel]);

	// The thread panel sticks to its newest reply.
	useEffect(() => {
		const el = threadBodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [openThread, threadReplies.length]);

	// Escape closes the thread panel (the composer consumes Escape while its
	// mention popup is open).
	useEffect(() => {
		if (!openThread) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpenThread(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [openThread]);

	function upsert(msg: ChatMessage) {
		setMessages((prev) =>
			prev.some((m) => m.id === msg.id)
				? prev.map((m) => (m.id === msg.id ? msg : m))
				: [...prev, msg],
		);
	}

	async function sendMain(text: string, images: ChatImage[]) {
		const msg = await postChatMessageApi(
			channel,
			text,
			user,
			images,
			replyToMain ? { replyTo: replyToMain } : undefined,
		);
		setReplyToMain(null);
		upsert(msg);
	}

	async function sendThread(text: string, images: ChatImage[]) {
		if (!openThread) return;
		const msg = await postChatMessageApi(channel, text, user, images, {
			threadId: openThread,
			...(replyToThread ? { replyTo: replyToThread } : {}),
		});
		setReplyToThread(null);
		upsert(msg);
	}

	/** Toggle locally for instant feedback; the server response reconciles. */
	function toggleLocalReaction(
		m: ChatMessage,
		emoji: string,
		who: string,
	): ChatMessage {
		const reactions = { ...(m.reactions || {}) };
		const users = reactions[emoji] ? [...reactions[emoji]] : [];
		const idx = users.findIndex((u) => u.toLowerCase() === who.toLowerCase());
		if (idx >= 0) users.splice(idx, 1);
		else users.push(who);
		if (users.length) reactions[emoji] = users;
		else delete reactions[emoji];
		const next = { ...m };
		if (Object.keys(reactions).length) next.reactions = reactions;
		else delete next.reactions;
		return next;
	}

	async function react(m: ChatMessage, emoji: string) {
		setMessages((prev) =>
			prev.map((x) => (x.id === m.id ? toggleLocalReaction(x, emoji, user) : x)),
		);
		try {
			const updated = await toggleChatReactionApi(channel, m.id, emoji, user);
			setMessages((prev) =>
				prev.map((x) => (x.id === updated.id ? updated : x)),
			);
		} catch {
			// Server rejected — flip the optimistic toggle back.
			setMessages((prev) =>
				prev.map((x) =>
					x.id === m.id ? toggleLocalReaction(x, emoji, user) : x,
				),
			);
		}
	}

	function quote(m: ChatMessage) {
		const q: ChatReplyTo = { id: m.id, user: m.user, text: excerptOf(m) };
		// Quoting inside the open thread replies there; otherwise the main room.
		if (openThread && (m.threadId === openThread || m.id === openThread))
			setReplyToThread(q);
		else setReplyToMain(q);
	}

	/** Scroll to a quoted original and flash it; opens its thread if needed. */
	function jumpTo(id: string) {
		const target = messages.find((x) => x.id === id);
		if (!target) return; // scrolled out of the stored tail
		const inThread = !!target.threadId;
		if (inThread) setOpenThread(target.threadId!);
		setHighlightId(id);
		window.setTimeout(
			() => {
				document
					.getElementById(`${inThread ? "threadmsg" : "chatmsg"}-${id}`)
					?.scrollIntoView({ behavior: "smooth", block: "center" });
			},
			inThread ? 80 : 0,
		);
		window.setTimeout(
			() => setHighlightId((h) => (h === id ? null : h)),
			1800,
		);
	}

	const isPage = variant === "page";

	return (
		<div
			className={cn(
				"relative flex min-h-0 flex-1 flex-col overflow-hidden",
				isPage && "bg-surface",
			)}
		>
			{isPage && (
				<div className="border-b border-line px-5 py-3">
					<div className="mx-auto w-full max-w-2xl">
						<div className="text-[15px] font-semibold text-fg">
							Watercooler
						</div>
						<div className="text-xs font-medium text-dim">
							@ a teammate to ping them, or a session to link it
						</div>
					</div>
				</div>
			)}

			<div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div
					className={cn("flex flex-col", isPage && "mx-auto w-full max-w-2xl")}
				>
					{loading && messages.length === 0 ? (
						<div className="py-8 text-center text-sm font-medium text-faint">
							Loading…
						</div>
					) : topLevel.length === 0 ? (
						<div className="py-8 text-center text-sm font-medium text-faint">
							No messages yet. Say hi 👋
						</div>
					) : (
						topLevel.map((m, i) => {
							const prev = topLevel[i - 1];
							const newDay =
								!prev ||
								new Date(prev.ts).toDateString() !==
									new Date(m.ts).toDateString();
							// Compact continuation: same sender within 5 minutes.
							const compact =
								!newDay && prev?.user === m.user && m.ts - prev.ts < 300_000;
							return (
								<React.Fragment key={m.id}>
									{newDay && (
										<div className="my-3 flex items-center gap-3">
											<div className="h-px flex-1 bg-line" />
											<div className="text-[11px] font-semibold text-faint">
												{dayLabel(m.ts)}
											</div>
											<div className="h-px flex-1 bg-line" />
										</div>
									)}
									<MessageRow
										m={m}
										compact={compact}
										me={user}
										sessionLabels={sessionLabels}
										onOpenSession={onOpenSession}
										onReact={react}
										onQuote={quote}
										onOpenThread={setOpenThread}
										replies={threadMap.get(m.id)}
										onJumpTo={jumpTo}
										highlight={highlightId === m.id}
										idPrefix="chatmsg"
									/>
								</React.Fragment>
							);
						})
					)}
				</div>
			</div>

			<div
				className={cn(
					"chat-input-bar border-t border-line px-4 pb-2 pt-2",
					isPage && "px-5",
				)}
			>
				<div className={cn(isPage && "mx-auto w-full max-w-2xl")}>
					<div className="h-5 px-1 text-xs font-medium text-dim">
						{typingNames.length > 0 && (
							<>
								{typingNames.join(", ")}{" "}
								{typingNames.length === 1 ? "is" : "are"} typing
								<span className="animate-pulse">…</span>
							</>
						)}
					</div>
					<ChatComposer
						channel={channel}
						user={user}
						placeholder={
							isPage
								? `Message the team as ${user}. @ to tag`
								: "Chat about this session. @ to tag"
						}
						sessions={sessions}
						workspaceNames={workspaceNames}
						send={send}
						replyTo={replyToMain}
						onCancelReply={() => setReplyToMain(null)}
						onSend={sendMain}
					/>
				</div>
			</div>

			{/* Thread panel: Slack-style side panel on the page variant, full
			    overlay in the narrow session rail. */}
			{openThread && threadParent && (
				<div
					className={cn(
						"absolute z-30 flex flex-col overflow-hidden bg-surface",
						isPage
							? "inset-y-0 right-0 w-[420px] max-w-full border-l border-line shadow-xl"
							: "inset-0",
					)}
				>
					<div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
						<div className="min-w-0">
							<div className="text-[14px] font-semibold text-fg">Thread</div>
							<div className="truncate text-[11px] font-medium text-dim">
								{threadParent.user}: {excerptOf(threadParent)}
							</div>
						</div>
						<button
							type="button"
							className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-dim hover:bg-hover hover:text-fg"
							onClick={() => setOpenThread(null)}
							aria-label="Close thread"
						>
							<IconX size={20} />
						</button>
					</div>
					<div
						ref={threadBodyRef}
						className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
					>
						<MessageRow
							m={threadParent}
							compact={false}
							me={user}
							sessionLabels={sessionLabels}
							onOpenSession={onOpenSession}
							onReact={react}
							onQuote={quote}
							onJumpTo={jumpTo}
							highlight={highlightId === threadParent.id}
							idPrefix="threadmsg"
						/>
						{threadReplies.length > 0 && (
							<div className="my-3 flex items-center gap-3">
								<div className="text-[11px] font-semibold text-faint">
									{threadReplies.length}{" "}
									{threadReplies.length === 1 ? "reply" : "replies"}
								</div>
								<div className="h-px flex-1 bg-line" />
							</div>
						)}
						{threadReplies.map((m, i) => {
							const prev = threadReplies[i - 1];
							const compact =
								!!prev && prev.user === m.user && m.ts - prev.ts < 300_000;
							return (
								<MessageRow
									key={m.id}
									m={m}
									compact={compact}
									me={user}
									sessionLabels={sessionLabels}
									onOpenSession={onOpenSession}
									onReact={react}
									onQuote={quote}
									onJumpTo={jumpTo}
									highlight={highlightId === m.id}
									idPrefix="threadmsg"
								/>
							);
						})}
					</div>
					<div className="chat-input-bar border-t border-line px-3 pb-2 pt-2">
						<ChatComposer
							key={`thread:${openThread}`}
							channel={channel}
							user={user}
							placeholder="Reply in thread…"
							sessions={sessions}
							workspaceNames={workspaceNames}
							send={send}
							autoFocus
							replyTo={replyToThread}
							onCancelReply={() => setReplyToThread(null)}
							onSend={sendThread}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

export default TeamChat;
