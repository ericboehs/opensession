import React, { useMemo } from "react";
import type { TranscriptEntry } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { parseHumanReply, parseAttribution } from "../lib/humanReply";
import { useCurrentUser } from "./UserPicker";
import { Tooltip } from "../ui/tooltip";

/** Very short relative time for the message label ("now", "5m", "3h", "2d",
 * then a date). Hover shows the full local time. */
function shortTime(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(+d)) return "";
	const s = (Date.now() - +d) / 1000;
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function MsgTime({ ts }: { ts?: string }) {
	if (!ts) return null;
	const label = shortTime(ts);
	if (!label) return null;
	return (
		<Tooltip label={new Date(ts).toLocaleString()}>
			<span className="msg-time">{label}</span>
		</Tooltip>
	);
}

interface Props {
	entry: TranscriptEntry;
	/** When provided, assistant messages show a "Fork from here" action. */
	onFork?: (entryId: string) => void;
	/**
	 * Who owns/drives this session (session.startedBy). An un-attributed user
	 * turn is this person's own words, so it's credited to them — "You" only
	 * when the current viewer IS the owner. Omitted (e.g. sub-agent panel) means
	 * fall back to "You".
	 */
	owner?: string;
}

/** Inline images carried on an entry (Read-of-image results, pasted images). */
function EntryImages({ images }: { images?: string[] }) {
	if (!images || images.length === 0) return null;
	return (
		<div className="msg-images">
			{images.map((src, i) => (
				<a
					key={i}
					href={src}
					target="_blank"
					rel="noopener noreferrer"
					className="md-image-link"
				>
					<img className="md-image" src={src} alt="" loading="lazy" />
				</a>
			))}
		</div>
	);
}

// Memoized: entries keep stable references across stream events (mergeEntries
// reuses objects) and onFork/owner are stable upstream, so a tool event
// appended to the transcript re-renders only the affected blocks — not every
// bubble's markdown/highlighting.
export const MessageBubble = React.memo(function MessageBubble({
	entry,
	onFork,
	owner,
}: Props) {
	const me = useCurrentUser();
	// A routed-back teammate reply (human-in-the-loop): credit the teammate and
	// render just their words (the header is stripped — the label carries "who").
	const humanReply = useMemo(() => {
		if (entry.type !== "user") return null;
		const parsed = parseHumanReply(entry.content);
		return parsed
			? { name: parsed.name, html: renderMarkdown(parsed.body) }
			: null;
	}, [entry.type, entry.content]);
	// A "[Name] …" attributed turn: a named teammate steered/sent into this
	// session. It's the driver, so it keeps a normal user bubble — but credited
	// to the sender (and the prefix stripped). When the sender is the viewer it
	// stays "You"; only the body changes (prefix removed).
	const attribution = useMemo(() => {
		if (entry.type !== "user" || humanReply) return null;
		return parseAttribution(entry.content);
	}, [entry.type, entry.content, humanReply]);
	const displayContent = attribution ? attribution.body : entry.content;
	const html = useMemo(() => renderMarkdown(displayContent), [displayContent]);

	if (entry.type === "system") {
		return (
			<div className="msg msg-system">
				<span className="msg-system-text">{entry.content}</span>
			</div>
		);
	}

	if (entry.type === "user" && humanReply) {
		return (
			<div className="msg msg-human">
				<div className="msg-label msg-label-human">
					💬 {humanReply.name} · via Slack
					<MsgTime ts={entry.timestamp} />
				</div>
				<div
					className="msg-body msg-body-human markdown"
					dangerouslySetInnerHTML={{ __html: humanReply.html || "" }}
				/>
				<EntryImages images={entry.images} />
			</div>
		);
	}

	if (entry.type === "user") {
		// Who sent this turn: an explicit "[Name] " attribution (a teammate who
		// steered/sent into the session) wins; otherwise it's the session owner's
		// own words. Either way, credit the sender — "You" only when the sender is
		// the current viewer. Falls back to "You" when the owner is unknown.
		const sender = attribution ? attribution.name : owner;
		const fromOther = sender && sender !== me ? sender : null;
		return (
			<div className="msg msg-user">
				<div className="msg-label msg-label-user">{fromOther || "You"}<MsgTime ts={entry.timestamp} /></div>
				{displayContent && (
					<div
						className="msg-body msg-body-user markdown"
						dangerouslySetInnerHTML={{ __html: html || "" }}
					/>
				)}
				<EntryImages images={entry.images} />
			</div>
		);
	}

	// assistant
	return (
		<div className="msg msg-assistant">
			<div className="msg-label msg-label-assistant">
				Michael
				<MsgTime ts={entry.timestamp} />
				{onFork && (
					<button
						className="msg-fork-btn"
						onClick={() => onFork(entry.id)}
						title="Fork a new session that branches from this point, keeping the conversation so far"
					>
						⑂ Fork from here
					</button>
				)}
			</div>
			<div
				className="msg-body msg-body-assistant markdown"
				dangerouslySetInnerHTML={{ __html: html || "" }}
			/>
			<EntryImages images={entry.images} />
		</div>
	);
});
