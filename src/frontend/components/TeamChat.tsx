import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
	ChatMessage,
	UnifiedSession,
	WSClientMessage,
	WSServerMessage,
} from "../lib/types";
import { fetchChatMessagesApi, postChatMessageApi } from "../lib/api";
import { TEAM } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { IconArrowUp, IconMessage } from "./icons";
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
	send: (msg: WSClientMessage) => void;
	addHandler: (h: (msg: WSServerMessage) => void) => () => void;
	onOpenSession: (id: string) => void;
	/** "page" = full detail-pane view (Watercooler); "panel" = right-rail tab. */
	variant?: "page" | "panel";
}

type Suggestion =
	| { kind: "person"; name: string }
	| { kind: "session"; id: string; title: string };

/** The active `@`-mention token at the caret, or null. */
function mentionAt(
	value: string,
	caret: number,
): { start: number; query: string } | null {
	let i = caret - 1;
	while (i >= 0) {
		const ch = value[i];
		if (ch === "@") {
			const prev = i > 0 ? value[i - 1] : " ";
			if (prev === " " || prev === "\n") {
				return { start: i, query: value.slice(i + 1, caret) };
			}
			return null;
		}
		if (ch === " " || ch === "\n") return null;
		i--;
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
	sessionTitles,
	onOpenSession,
}: {
	text: string;
	me: string;
	sessionTitles: Map<string, string>;
	onOpenSession: (id: string) => void;
}) {
	const parts = text.split(TAG_RE);
	return (
		<>
			{parts.map((p, i) => {
				if (p.startsWith("@session:")) {
					const id = p.slice("@session:".length);
					const title = sessionTitles.get(id);
					return (
						<button
							key={i}
							className="mx-0.5 inline-flex max-w-60 items-baseline gap-1 rounded-sm border border-line bg-panel px-1.5 align-baseline text-[12px] font-medium text-fg hover:border-line-strong hover:bg-hover"
							onClick={() => onOpenSession(id)}
							title={title ? `Open “${title}”` : "Open session"}
						>
							<span className="translate-y-0.5 self-center text-dim">
								<IconMessage size={13} />
							</span>
							<span className="truncate">
								{title || `${id.slice(0, 8)}…`}
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
	send,
	addHandler,
	onOpenSession,
	variant = "page",
}: Props) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [text, setText] = useState("");
	const [posting, setPosting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// user → expiry stamp of their "typing…" signal.
	const [typers, setTypers] = useState<Record<string, number>>({});
	const [mention, setMention] = useState<{
		start: number;
		query: string;
	} | null>(null);
	const [mentionIdx, setMentionIdx] = useState(0);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const lastTypingSentRef = useRef(0);

	const sessionTitles = useMemo(
		() => new Map(sessions.map((s) => [s.id, s.title])),
		[sessions],
	);

	const suggestions = useMemo<Suggestion[]>(() => {
		if (!mention) return [];
		const q = mention.query.toLowerCase();
		const people: Suggestion[] = TEAM.filter((n) =>
			n.toLowerCase().startsWith(q),
		).map((name) => ({ kind: "person", name }));
		// Sessions by title match — on a bare "@", surface the recent few so the
		// affordance is discoverable.
		const live = sessions.filter((s) => !s.archived);
		const matched = q
			? live.filter((s) => s.title.toLowerCase().includes(q))
			: [...live]
					.sort((a, b) =>
						(b.lastActivity || "").localeCompare(a.lastActivity || ""),
					)
					.slice(0, 3);
		const chats: Suggestion[] = matched
			.slice(0, 5)
			.map((s) => ({ kind: "session", id: s.id, title: s.title }));
		return [...people, ...chats].slice(0, 8);
	}, [mention, sessions]);

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
		if (!t || posting) return;
		setPosting(true);
		setError(null);
		try {
			const msg = await postChatMessageApi(channel, t, user);
			setText("");
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
											<div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
												<MessageText
													text={m.text}
													me={user}
													sessionTitles={sessionTitles}
													onOpenSession={onOpenSession}
												/>
											</div>
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
					"border-t border-line px-4 pb-4 pt-2",
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
					<div className="relative">
						{mention && suggestions.length > 0 && (
							<div className="absolute bottom-full left-0 z-10 mb-1.5 w-72 overflow-hidden rounded-md border border-line-strong bg-panel py-1 shadow-lg">
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
												<span className="truncate">{s.title}</span>
												<span className="ml-auto shrink-0 text-[11px] text-faint">
													session
												</span>
											</>
										)}
									</div>
								))}
							</div>
						)}
						<div className="flex items-end gap-2 rounded-lg border border-line bg-panel p-2 focus-within:border-line-strong">
							<textarea
								ref={inputRef}
								className="max-h-40 min-h-[38px] flex-1 resize-none border-0 bg-transparent px-1 py-1 text-[13px] font-medium leading-snug text-fg shadow-none outline-none placeholder:text-faint"
								placeholder={
									isPage
										? `Message the team as ${user} — @ to tag`
										: "Chat about this session — @ to tag"
								}
								rows={1}
								value={text}
								disabled={posting}
								onChange={(e) => {
									setText(e.target.value);
									if (e.target.value.trim()) noteTyping();
									requestAnimationFrame(syncMention);
								}}
								onClick={syncMention}
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
								disabled={posting || !text.trim()}
								aria-label="Send"
							>
								<IconArrowUp size={20} />
							</button>
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
