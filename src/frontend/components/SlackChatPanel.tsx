import React, { useEffect, useRef, useState } from "react";
import type {
	SlackChannelLink,
	SlackMessage,
	WSServerMessage,
} from "../lib/types";
import {
	linkChannelApi,
	unlinkChannelApi,
	fetchChannelHistoryApi,
	postChannelMessageApi,
} from "../lib/api";

interface Props {
	sessionId: string;
	slackChannel?: SlackChannelLink | null;
	user: string;
	addHandler: (h: (msg: WSServerMessage) => void) => () => void;
	/** Ask the parent to refresh sessions after a link/unlink. */
	onLinkChange?: () => void;
}

function initial(name: string): string {
	return (name.trim()[0] || "?").toUpperCase();
}
function colorFor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
	return `hsl(${Math.abs(h) % 360} 55% 45%)`;
}
function timeOf(ts: string): string {
	const d = new Date(Number(ts) * 1000);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
/** Union two message lists by ts (fetched wins), sorted chronologically. */
function mergeByTs(a: SlackMessage[], b: SlackMessage[]): SlackMessage[] {
	const map = new Map<string, SlackMessage>();
	for (const m of a) map.set(m.ts, m);
	for (const m of b) map.set(m.ts, m);
	return [...map.values()].sort((x, y) => Number(x.ts) - Number(y.ts));
}

// Tag-able teammates (the server resolves these first names → real Slack
// mentions when posting, so a message can ping people).
const TEAM = [
	"Michiel",
	"Grant",
	"Johnny",
	"John",
	"Kent",
	"Jaap",
	"Louise",
	"Thibault",
];

/** Undo Slack's HTML-entity escaping of literal &, <, > in user text. */
function unescapeSlack(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

/** Render a plain (non-link) segment: @tags plus bold/italic/code mrkdwn. */
function renderPlain(seg: string, keyBase: string): React.ReactNode[] {
	const parts = seg.split(/(@[\w][\w.-]*|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`)/g);
	return parts.map((p, i) => {
		const key = `${keyBase}-${i}`;
		if (/^@[\w][\w.-]*$/.test(p))
			return (
				<span key={key} className="slack-tag">
					{p}
				</span>
			);
		if (/^\*[^*\n]+\*$/.test(p)) return <strong key={key}>{p.slice(1, -1)}</strong>;
		if (/^_[^_\n]+_$/.test(p)) return <em key={key}>{p.slice(1, -1)}</em>;
		if (/^`[^`\n]+`$/.test(p))
			return (
				<code key={key} className="slack-code">
					{p.slice(1, -1)}
				</code>
			);
		return <React.Fragment key={key}>{unescapeSlack(p)}</React.Fragment>;
	});
}

/**
 * Render Slack message text as React nodes: `<url|label>`/`<url>` become
 * clickable links, `<#C|name>`/`<!here>` and `@name` become styled tags, and
 * basic `*bold*`/`_italic_`/`code` mrkdwn is applied. (Server already resolved
 * `<@id>` → `@First`.)
 */
function renderSlackText(text: string): React.ReactNode[] {
	const out: React.ReactNode[] = [];
	const re = /<([^>\n]+)>/g;
	let last = 0;
	let m: RegExpExecArray | null;
	let k = 0;
	while ((m = re.exec(text))) {
		if (m.index > last) out.push(...renderPlain(text.slice(last, m.index), `p${k}`));
		const inner = m[1];
		if (inner.startsWith("#")) {
			const name = inner.split("|")[1] || inner.slice(1);
			out.push(
				<span key={`t${k}`} className="slack-tag">
					#{name}
				</span>,
			);
		} else if (inner.startsWith("@") || inner.startsWith("!")) {
			const name = inner.split("|")[1] || inner.slice(1);
			out.push(
				<span key={`t${k}`} className="slack-tag">
					@{name}
				</span>,
			);
		} else {
			const pipe = inner.indexOf("|");
			const url = pipe >= 0 ? inner.slice(0, pipe) : inner;
			const label = pipe >= 0 ? inner.slice(pipe + 1) : inner;
			out.push(
				<a
					key={`l${k}`}
					className="slack-link"
					href={url}
					target="_blank"
					rel="noreferrer"
				>
					{label}
				</a>,
			);
		}
		last = re.lastIndex;
		k++;
	}
	if (last < text.length) out.push(...renderPlain(text.slice(last), `p${k}`));
	return out;
}

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

/**
 * A linked Slack channel rendered inline: history + live messages (over the app
 * WebSocket) + a composer that posts as you. When no channel is linked, shows a
 * create/link affordance. Shared by the session viewer's Workspace "Slack" tab
 * and the Reviews chat rail.
 */
export function SlackChatPanel({
	sessionId,
	slackChannel,
	user,
	addHandler,
	onLinkChange,
}: Props) {
	const [channel, setChannel] = useState<SlackChannelLink | null>(
		slackChannel ?? null,
	);
	const [messages, setMessages] = useState<SlackMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [text, setText] = useState("");
	const [posting, setPosting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Link form
	const [linkMode, setLinkMode] = useState<"create" | "existing">("create");
	const [linkName, setLinkName] = useState("");
	const [linking, setLinking] = useState(false);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	// People @-mention autocomplete over the composer.
	const [mention, setMention] = useState<{ start: number; query: string } | null>(
		null,
	);
	const [mentionIdx, setMentionIdx] = useState(0);
	const suggestions = mention
		? TEAM.filter((n) =>
				n.toLowerCase().startsWith(mention.query.toLowerCase()),
			).slice(0, 6)
		: [];

	function syncMention() {
		const el = inputRef.current;
		if (!el) return;
		const ctx = mentionAt(el.value, el.selectionStart ?? el.value.length);
		setMention(ctx);
		setMentionIdx(0);
	}

	function applyMention(name: string) {
		if (!mention) return;
		const before = text.slice(0, mention.start);
		const after = text.slice(
			(inputRef.current?.selectionStart ?? text.length) as number,
		);
		const next = `${before}@${name} ${after}`;
		setText(next);
		setMention(null);
		const caret = before.length + name.length + 2;
		requestAnimationFrame(() => {
			const el = inputRef.current;
			if (el) {
				el.focus();
				el.setSelectionRange(caret, caret);
			}
		});
	}

	// Keep local channel in sync when the session prop changes.
	useEffect(() => {
		setChannel(slackChannel ?? null);
	}, [slackChannel]);

	// Live: append inbound messages for our channel; react to link changes.
	useEffect(() => {
		return addHandler((msg) => {
			if (msg.type === "slack_message") {
				if (!channel || msg.channelId !== channel.channelId) return;
				setMessages((prev) =>
					prev.some((m) => m.ts === msg.message.ts)
						? prev
						: [...prev, msg.message],
				);
			} else if (msg.type === "channel_linked" && msg.sessionId === sessionId) {
				setChannel(msg.slackChannel);
			}
		});
	}, [addHandler, channel, sessionId]);

	// Load history when the linked channel changes, then poll for new messages —
	// a fallback so inbound Slack messages show even without the `message.channels`
	// event subscription (when that's on, the WS push above delivers them instantly
	// and the poll just reconciles).
	useEffect(() => {
		if (!channel) {
			setMessages([]);
			return;
		}
		let alive = true;
		setLoading(true);
		fetchChannelHistoryApi(sessionId)
			.then((m) => alive && setMessages(m))
			.catch(() => {})
			.finally(() => alive && setLoading(false));
		const poll = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			fetchChannelHistoryApi(sessionId)
				.then((m) => alive && setMessages((prev) => mergeByTs(prev, m)))
				.catch(() => {});
		}, 6000);
		return () => {
			alive = false;
			clearInterval(poll);
		};
	}, [channel?.channelId, sessionId]);

	// Auto-scroll to the newest message — but only when the reader is already near
	// the bottom, so a poll refresh doesn't yank them up out of scrollback.
	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
		if (nearBottom) el.scrollTop = el.scrollHeight;
	}, [messages]);

	async function doLink() {
		const name = linkName.trim();
		if (linkMode === "existing" && !name) return;
		setLinking(true);
		setError(null);
		try {
			const link = await linkChannelApi(sessionId, {
				mode: linkMode,
				name: name || undefined,
			});
			setChannel(link);
			setLinkName("");
			onLinkChange?.();
		} catch (e: any) {
			setError(e?.message || "Link failed");
		} finally {
			setLinking(false);
		}
	}

	async function doUnlink() {
		if (!confirm("Unlink this channel from the session?")) return;
		try {
			await unlinkChannelApi(sessionId);
			setChannel(null);
			setMessages([]);
			onLinkChange?.();
		} catch (e: any) {
			setError(e?.message || "Unlink failed");
		}
	}

	async function send() {
		const t = text.trim();
		if (!t || posting) return;
		setPosting(true);
		setError(null);
		try {
			const msg = await postChannelMessageApi(sessionId, t, user);
			setText("");
			setMessages((prev) =>
				prev.some((m) => m.ts === msg.ts) ? prev : [...prev, msg],
			);
		} catch (e: any) {
			setError(e?.message || "Send failed");
		} finally {
			setPosting(false);
		}
	}

	// ── Unlinked: create / link affordance ──
	if (!channel) {
		return (
			<div className="slack-panel slack-panel-empty">
				<div className="slack-empty-inner">
					<div className="slack-empty-title">Link a Slack channel</div>
					<div className="slack-empty-sub">
						Discuss this session in Slack and let Michael work in that channel.
					</div>
					<div className="slack-link-tabs">
						<button
							className={linkMode === "create" ? "active" : ""}
							onClick={() => setLinkMode("create")}
						>
							Create new
						</button>
						<button
							className={linkMode === "existing" ? "active" : ""}
							onClick={() => setLinkMode("existing")}
						>
							Link existing
						</button>
					</div>
					<div className="slack-link-row">
						{linkMode === "create" && (
							<span className="slack-prefix">michael-</span>
						)}
						<input
							className="slack-link-input"
							placeholder={
								linkMode === "create"
									? "channel-name (optional)"
									: "channel name or ID"
							}
							value={linkName}
							onChange={(e) => setLinkName(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && doLink()}
						/>
						<button
							className="slack-link-go"
							onClick={doLink}
							disabled={linking}
						>
							{linking ? "…" : linkMode === "create" ? "Create" : "Link"}
						</button>
					</div>
					{error && <div className="slack-error">{error}</div>}
				</div>
			</div>
		);
	}

	// ── Linked: chat ──
	return (
		<div className="slack-panel">
			<div className="slack-panel-head">
				<a
					className="slack-channel-name"
					href={`https://slack.com/app_redirect?channel=${channel.channelId}`}
					target="_blank"
					rel="noreferrer"
					title="Open in Slack"
				>
					#{channel.name}
				</a>
				<button
					className="slack-unlink"
					onClick={doUnlink}
					title="Unlink channel"
				>
					Unlink
				</button>
			</div>

			<div className="slack-messages" ref={bodyRef}>
				{loading && messages.length === 0 ? (
					<div className="slack-loading">Loading…</div>
				) : messages.length === 0 ? (
					<div className="slack-loading">No messages yet — say hi 👋</div>
				) : (
					messages.map((m) => (
						<div key={m.ts} className="slack-msg">
							{m.avatarUrl ? (
								<img className="slack-avatar" src={m.avatarUrl} alt="" />
							) : (
								<span
									className="slack-avatar slack-avatar-fallback"
									style={{ background: colorFor(m.userName) }}
								>
									{initial(m.userName)}
								</span>
							)}
							<div className="slack-msg-body">
								<div className="slack-msg-head">
									<span className="slack-msg-name">{m.userName}</span>
									<span className="slack-msg-time">{timeOf(m.ts)}</span>
								</div>
								<div className="slack-msg-text">
									{renderSlackText(m.text)}
								</div>
							</div>
						</div>
					))
				)}
			</div>

			<div className="slack-compose">
				<div className="slack-compose-wrap">
					{mention && suggestions.length > 0 && (
						<div className="slack-mention-pop">
							{suggestions.map((n, i) => (
								<div
									key={n}
									className={`slack-mention-item ${i === mentionIdx ? "active" : ""}`}
									onMouseDown={(e) => {
										e.preventDefault();
										applyMention(n);
									}}
									onMouseEnter={() => setMentionIdx(i)}
								>
									@{n}
								</div>
							))}
						</div>
					)}
					<textarea
						ref={inputRef}
						className="slack-compose-input"
						placeholder={`Message #${channel.name} as ${user}…  (@ to tag)`}
						value={text}
						disabled={posting}
						onChange={(e) => {
							setText(e.target.value);
							requestAnimationFrame(syncMention);
						}}
						onClick={syncMention}
						onKeyUp={(e) => {
							if (!["Enter", "ArrowUp", "ArrowDown", "Tab"].includes(e.key))
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
										(i) => (i - 1 + suggestions.length) % suggestions.length,
									);
									return;
								}
								if (e.key === "Enter" || e.key === "Tab") {
									e.preventDefault();
									applyMention(suggestions[mentionIdx]);
									return;
								}
								if (e.key === "Escape") {
									setMention(null);
									return;
								}
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
					/>
				</div>
				<button
					className="slack-send"
					onClick={send}
					disabled={posting || !text.trim()}
				>
					{posting ? "…" : "Send"}
				</button>
			</div>
			{error && <div className="slack-error">{error}</div>}
		</div>
	);
}

export default SlackChatPanel;
