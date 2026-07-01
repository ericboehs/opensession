import React, { useEffect, useRef, useState } from "react";
import type { PlainThread, PlainTimelineEntry } from "../lib/types";
import { fetchPlainThreadApi } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";

interface Props {
	sessionId: string;
	/** The linked Plain thread id — panel re-fetches when it changes. */
	threadId: string;
	/** Deep link into the thread in the Plain app (the "jump into Plain" action). */
	plainUrl: string;
}

const STATUS_LABEL: Record<string, string> = {
	TODO: "Todo",
	SNOOZED: "Snoozed",
	DONE: "Done",
};

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
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(null);
		const load = () =>
			fetchPlainThreadApi(sessionId)
				.then((t) => {
					if (!alive) return;
					setThread(t);
					setError(null);
				})
				.catch((e) => {
					if (alive) setError(e?.message || "Failed to load");
				})
				.finally(() => {
					if (alive) setLoading(false);
				});
		load();
		const poll = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			load();
		}, 20000);
		return () => {
			alive = false;
			clearInterval(poll);
		};
	}, [sessionId, threadId]);

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
		</div>
	);
}

function PlainEntryRow({ entry }: { entry: PlainTimelineEntry }) {
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
