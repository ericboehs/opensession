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
	UnifiedSession,
	WSClientMessage,
	WSServerMessage,
} from "../lib/types";
import type { ChatImage } from "../lib/types";
import {
	fetchChatMessagesApi,
	postChatMessageApi,
	uploadChatImageApi,
	chatImageUrl,
} from "../lib/api";
import { imageFilesFromPaste } from "../lib/images";
import { TEAM } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { IconArrowUp, IconMessage, IconImage, IconX } from "./icons";
import { cn } from "../ui/cn";

/**
 * Native Backstage team chat (nothing to do with Slack). One component, two
 * rooms: the team-wide Watercooler (`channel="watercooler"`, page variant,
 * left-sidebar entry) and a per-session room (`channel="session:<id>"`, panel
 * variant, the session panel's Chat tab). Messages arrive live over the app
 * WebSocket; typing indicators are ephemeral relays. `@Name` tags a teammate
 * (they get a web push), `@session:<id>` tags a session and renders as a chip
 * that navigates there — both inserted via the composer's `@` autocomplete.
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

// One token per @-tag: session chips first (longer match), then people.
const TAG_RE = /(@session:[A-Za-z0-9._-]+|@[A-Za-z][\w.-]*)/g;

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
				return <React.Fragment key={i}>{p}</React.Fragment>;
			})}
		</>
	);
}

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
	const [text, setText] = useState("");
	const [images, setImages] = useState<ChatImage[]>([]);
	const [uploading, setUploading] = useState(0);
	const [posting, setPosting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// user → expiry stamp of their "typing…" signal.
	const [typers, setTypers] = useState<Record<string, number>>({});
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
	const bodyRef = useRef<HTMLDivElement | null>(null);
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

	// History on channel switch.
	useEffect(() => {
		let alive = true;
		setMessages([]);
		setTypers({});
		setLoading(true);
		fetchChatMessagesApi(channel)
			.then((m) => alive && setMessages(m))
			.catch(() => {})
			.finally(() => alive && setLoading(false));
		return () => {
			alive = false;
		};
	}, [channel]);

	// Live messages + typing over the shared app socket.
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
			const msg = await postChatMessageApi(channel, t, user, images);
			setText("");
			setImages([]);
			setMention(null);
			setMessages((prev) =>
				prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
			);
		} catch (e: any) {
			setError(e?.message || "Send failed");
		} finally {
			setPosting(false);
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}

	const isPage = variant === "page";

	return (
		<div
			className={cn(
				"flex min-h-0 flex-1 flex-col",
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
							Team chat — @ tags a teammate (they get a ping) or a session
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
					) : messages.length === 0 ? (
						<div className="py-8 text-center text-sm font-medium text-faint">
							No messages yet — say hi 👋
						</div>
					) : (
						messages.map((m, i) => {
							const prev = messages[i - 1];
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
									<div
										className={cn(
											"group flex gap-2.5 px-1",
											compact ? "mt-0.5" : "mt-3",
										)}
									>
										<div className="w-7 shrink-0">
											{!compact && <UserAvatar name={m.user} size={28} />}
										</div>
										<div className="min-w-0 flex-1">
											{!compact && (
												<div className="flex items-baseline gap-2">
													<span className="text-[13px] font-semibold text-fg">
														{m.user}
													</span>
													<span className="text-[11px] font-medium text-faint">
														{timeOf(m.ts)}
													</span>
												</div>
											)}
											{m.text && (
												<div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
													<MessageText
														text={m.text}
														me={user}
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
										</div>
									</div>
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
									placeholder={
										isPage
											? `Message the team as ${user} — @ to tag`
											: "Chat about this session — @ to tag"
									}
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
						<div className="px-1 pt-1 text-xs font-medium text-red">
							{error}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

export default TeamChat;
