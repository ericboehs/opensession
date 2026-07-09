import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PlainThread, PlainTimelineEntry } from "../lib/types";
import { fetchPlainThreadApi, sendPlainReplyApi } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { useCurrentUser } from "./UserPicker";
import { cn } from "../ui/cn";
import { PRODUCT_NAME } from "../lib/brand";

interface Props {
	sessionId: string;
	/** The linked Plain thread id — panel re-fetches when it changes. */
	threadId: string;
	/** Deep link into the thread in the Plain app (the "jump into Plain" action). */
	plainUrl: string;
}

export const STATUS_LABEL: Record<string, string> = {
	TODO: "Todo",
	SNOOZED: "Snoozed",
	DONE: "Done",
};

/** Workspace of the Plain app the tickets live in (for "open in Plain" links). */
const PLAIN_WORKSPACE_ID = "w_01J7WXJG68TFDV9RD1C4JE3W6F";
export function plainThreadUrl(threadId: string): string {
	return `https://app.plain.com/workspace/${PLAIN_WORKSPACE_ID}/thread/${threadId}/`;
}

function timeOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Read-only conversation timeline for a session's linked Plain thread: customer
 * emails/chats on the left, support/bot replies on the right, internal notes
 * inline. Polls lightly so new replies show up, and offers a one-click jump into
 * the thread in Plain. Shown as the session viewer's "Plain" workspace tab.
 */
export function PlainThreadPanel({ sessionId, threadId, plainUrl }: Props) {
	const [thread, setThread] = useState<PlainThread | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);

	// Load on mount / thread change, then poll — a customer can reply at any time
	// and there's no live push for Plain, so a gentle refresh keeps it current.
	// `load` is callable on its own so the reply box can refresh the timeline
	// right after a send instead of waiting out the poll.
	const aliveRef = useRef(true);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);
	const load = useCallback(
		() =>
			fetchPlainThreadApi(sessionId)
				.then((t) => {
					if (!aliveRef.current) return;
					setThread(t);
					setError(null);
				})
				.catch((e) => {
					if (aliveRef.current) setError(e?.message || "Failed to load");
				})
				.finally(() => {
					if (aliveRef.current) setLoading(false);
				}),
		[sessionId],
	);
	useEffect(() => {
		setLoading(true);
		setError(null);
		load();
		const poll = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			load();
		}, 20000);
		return () => clearInterval(poll);
	}, [threadId, load]);

	// Keep the newest message in view, but only when the reader is already near the
	// bottom — a poll refresh shouldn't yank them out of scrollback.
	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
		if (nearBottom) el.scrollTop = el.scrollHeight;
	}, [thread?.entries.length]);

	const status = thread?.status;

	return (
		<div className="plain-panel">
			<div className="plain-panel-head">
				<div className="plain-head-info">
					<span className="plain-customer" title={thread?.customer?.email || ""}>
						{thread?.customer?.name || thread?.customer?.email || "Plain thread"}
					</span>
					{status && (
						<span className={`plain-status plain-status-${status.toLowerCase()}`}>
							{STATUS_LABEL[status] || status}
						</span>
					)}
				</div>
				<a
					className="plain-open"
					href={plainUrl}
					target="_blank"
					rel="noreferrer"
					title="Open this thread in Plain"
				>
					Open in Plain ↗
				</a>
			</div>

			{thread?.title && <div className="plain-title">{thread.title}</div>}

			<div className="plain-timeline" ref={bodyRef}>
				{loading && !thread ? (
					<div className="plain-loading">Loading conversation…</div>
				) : error && !thread ? (
					<div className="plain-loading">Couldn't load Plain thread: {error}</div>
				) : thread && thread.entries.length === 0 ? (
					<div className="plain-loading">No messages in this thread yet.</div>
				) : (
					thread?.entries.map((e) => <PlainEntryRow key={e.id} entry={e} />)
				)}
			</div>

			{thread && (
				<PlainReplyBox
					key={threadId}
					threadId={threadId}
					customerName={thread.customer?.name || thread.customer?.email || null}
					onSent={load}
					className="border-t border-line"
				/>
			)}
		</div>
	);
}

/**
 * Human reply box for a Plain thread — a customer-facing reply (sent via
 * Plain as the Michael machine user) or an internal note for the team.
 * Shared by the session viewer's Plain tab and the Support ticket preview.
 * ⌘/Ctrl+Enter sends; the draft persists per thread.
 */
export function PlainReplyBox({
	threadId,
	customerName,
	onSent,
	className,
}: {
	threadId: string;
	customerName: string | null;
	/** Called after a successful send, so the owner can refresh the timeline. */
	onSent?: () => void;
	className?: string;
}) {
	const draftKey = `plain-reply:${threadId}`;
	const [text, setText] = useState(() => loadDraft(draftKey).text);
	useEffect(() => {
		saveDraft(draftKey, { text });
	}, [draftKey, text]);
	const [kind, setKind] = useState<"reply" | "note">("reply");
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(sentTimer.current), []);
	const currentUser = useCurrentUser();

	async function handleSend() {
		const t = text.trim();
		if (!t || sending) return;
		setSending(true);
		setError(null);
		try {
			await sendPlainReplyApi(threadId, t, kind, currentUser);
			setText("");
			clearDraft(draftKey);
			setSent(true);
			clearTimeout(sentTimer.current);
			sentTimer.current = setTimeout(() => setSent(false), 3000);
			onSent?.();
		} catch (e: any) {
			setError(e?.message || "Failed to send");
		} finally {
			setSending(false);
		}
	}

	return (
		<div className={cn("shrink-0 p-2.5 flex flex-col gap-1.5", className)}>
			<div className="flex items-center gap-1.5">
				{(["reply", "note"] as const).map((k) => (
					<button
						key={k}
						type="button"
						className={cn(
							"text-[11.5px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer",
							kind === k
								? "bg-active text-fg border-line-strong"
								: "bg-transparent text-faint border-line hover:text-dim",
						)}
						onClick={() => setKind(k)}
					>
						{k === "reply" ? "Reply" : "Internal note"}
					</button>
				))}
				{sent && (
					<span className="text-green text-[11.5px] font-semibold">Sent ✓</span>
				)}
			</div>
			<textarea
				className="w-full resize-none rounded-md border border-line bg-surface text-fg text-[13px] leading-normal p-2 min-h-[64px] focus:outline-none focus:border-line-strong placeholder:text-faint"
				placeholder={
					kind === "note"
						? "Internal note for the team (English)…"
						: `Reply to ${customerName || "the customer"} — sent via Plain…`
				}
				value={text}
				disabled={sending}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						handleSend();
					}
				}}
			/>
			<div className="flex items-center gap-2 min-w-0">
				{error ? (
					<span className="text-red text-[12px] truncate" title={error}>
						{error}
					</span>
				) : (
					<span className="text-faint text-[11.5px] truncate">
						{kind === "note"
							? `Posted as ${currentUser} (via ${PRODUCT_NAME})`
							: `Sends via Plain, signed “${currentUser.split(/\s+/)[0]}”`}
					</span>
				)}
				<button
					type="button"
					className="ml-auto shrink-0 rounded-md bg-accent text-white text-[12.5px] font-semibold px-2.5 py-1 cursor-pointer border-0 hover:opacity-90 disabled:opacity-50 disabled:cursor-default"
					onClick={handleSend}
					disabled={sending || !text.trim()}
					title="Send (⌘↵)"
				>
					{sending
						? "Sending…"
						: kind === "note"
							? "Add note"
							: "Send reply"}
				</button>
			</div>
		</div>
	);
}

export function PlainEntryRow({ entry }: { entry: PlainTimelineEntry }) {
	if (entry.kind === "note") {
		return (
			<div className="plain-entry plain-entry-note">
				<div className="plain-entry-head">
					<span className="plain-kind-badge plain-kind-note">note</span>
					<span className="plain-actor">{entry.actorName}</span>
					<span className="plain-time">{timeOf(entry.timestamp)}</span>
				</div>
				<div
					className="plain-note-body markdown"
					dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }}
				/>
			</div>
		);
	}

	const side = entry.actorType === "customer" ? "in" : "out";
	return (
		<div className={`plain-entry plain-entry-${side}`}>
			<div className="plain-entry-head">
				<span className="plain-actor">{entry.actorName}</span>
				<span className="plain-kind-badge">{entry.kind}</span>
				<span className="plain-time">{timeOf(entry.timestamp)}</span>
			</div>
			{entry.subject && <div className="plain-subject">{entry.subject}</div>}
			<div className="plain-entry-text">{entry.text}</div>
		</div>
	);
}

export default PlainThreadPanel;
