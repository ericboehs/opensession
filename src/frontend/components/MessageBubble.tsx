import React, { useMemo } from "react";
import type { TranscriptEntry } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { MarkdownBody } from "./MarkdownBody";
import { parseHumanReply, parseAttribution, isGitHubAttribution } from "../lib/humanReply";
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

/** Inline video players for attached/staged videos (streamed via <base>/media). */
function EntryVideos({ videos }: { videos?: string[] }) {
	if (!videos || videos.length === 0) return null;
	return (
		<div className="msg-videos">
			{videos.map((src, i) => (
				<div key={i} className="md-video-wrap">
					<video
						className="md-video"
						src={src}
						controls
						playsInline
						preload="metadata"
					/>
				</div>
			))}
		</div>
	);
}

/** Short uppercase extension badge for a filename (e.g. "PDF"), or "FILE". */
function extBadge(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "FILE";
	return name.slice(dot + 1, dot + 5).toUpperCase();
}

/** Non-media attachments on a user turn — download chips (served via <base>/media). */
function EntryFiles({ files }: { files?: TranscriptEntry["files"] }) {
	if (!files || files.length === 0) return null;
	return (
		<div className="msg-files">
			{files.map((f, i) => (
				<a
					key={i}
					className="composer-file-card msg-file-card"
					href={`/backstage/media?path=${encodeURIComponent(f.path)}`}
					download={f.name}
					title={f.name}
				>
					<span className="composer-file-thumb">{extBadge(f.name)}</span>
					<span className="composer-file-meta">
						<span className="composer-file-name">{f.name}</span>
						<span className="composer-file-sub">Attachment</span>
					</span>
				</a>
			))}
		</div>
	);
}

// Memoized: entries keep stable references across stream events (mergeEntries
// reuses objects) and owner is stable upstream, so a tool event appended to
// the transcript re-renders only the affected blocks — not every bubble's
// markdown/highlighting.
export const MessageBubble = React.memo(function MessageBubble({
	entry,
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

	if (entry.type === "user" && attribution && isGitHubAttribution(attribution.name)) {
		return (
			<div className="msg msg-system">
				<span className="msg-system-text">{displayContent}</span>
			</div>
		);
	}

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
				<MarkdownBody
					className="msg-body msg-body-human markdown"
					html={humanReply.html || ""}
				/>
				<EntryImages images={entry.images} />
				<EntryVideos videos={entry.videos} />
				<EntryFiles files={entry.files} />
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
		// Your own settled messages skip the label entirely — the right-aligned
		// bubble already says "you". Turns sent by someone else keep the
		// attribution label.
		return (
			<div className="msg msg-user">
				{fromOther && (
					<div className="msg-label msg-label-user">
						{fromOther}
						<MsgTime ts={entry.timestamp} />
					</div>
				)}
				{displayContent && (
					<MarkdownBody
						className="msg-body msg-body-user markdown"
						html={html || ""}
					/>
				)}
				<EntryImages images={entry.images} />
				<EntryVideos videos={entry.videos} />
				<EntryFiles files={entry.files} />
			</div>
		);
	}

	// assistant — no speaker label: every left-aligned bubble is Michael, so
	// the name row was pure noise above each answer.
	return (
		<div className="msg msg-assistant">
			<MarkdownBody
				className="msg-body msg-body-assistant markdown"
				html={html || ""}
			/>
			<EntryImages images={entry.images} />
			<EntryVideos videos={entry.videos} />
		</div>
	);
});
