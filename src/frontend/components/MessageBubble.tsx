import React, { useMemo, useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { MarkdownBody } from "./MarkdownBody";
import {
	parseHumanReply,
	parseAttribution,
	isGitHubAttribution,
	parseReviewHandoff,
} from "../lib/humanReply";
import { useCurrentUser } from "./UserPicker";
import { Tooltip } from "../ui/tooltip";
import { BASE_PATH } from "../lib/base";
import { resolveEntryImageSrc } from "../lib/osBlob";

// Only this much of a message is markdown-parsed eagerly. marked is
// superlinear on input size (~25ms at 10KB, ~400ms at 80KB, seconds past
// 200KB), and a transcript can hold dozens of giant machine-written entries
// (automation prompts embedding a full PR diff) — parsing them all on open is
// what made "Loading transcript…" hang for minutes on such sessions. Longer
// contents render their head plus a "Show full message" expander.
const EAGER_MD_CHARS = 6000;
// Expanded content still renders as markdown up to this size; past it the
// content is machine payload, not prose — a plain <pre> shows it instantly.
const FULL_MD_CHARS = 32 * 1024;

function sizeLabel(chars: number): string {
	return chars >= 1024 ? `${Math.round(chars / 1024)} KB` : `${chars} chars`;
}

/**
 * Message body that clamps how much markdown is parsed eagerly. Contents the
 * server clamped for the wire (entry.contentClamped) fetch the full entry on
 * expand; locally-long contents just reveal in place.
 */
export function ClampedBody({
	content,
	className,
	entry,
	sessionId,
}: {
	content: string;
	className: string;
	entry?: TranscriptEntry;
	sessionId?: string;
}) {
	const wireClamped = !!entry?.contentClamped;
	const fullLength = entry?.contentLength ?? content.length;
	const isLong = wireClamped || content.length > EAGER_MD_CHARS;
	const [showAll, setShowAll] = useState(false);
	const [fetched, setFetched] = useState<string | null>(null);
	const [fetching, setFetching] = useState(false);

	// Cut the eager head at a line boundary so we don't render half a line of
	// a diff/log as its own paragraph.
	const head = useMemo(() => {
		if (!isLong || showAll) return content;
		const slice = content.slice(0, EAGER_MD_CHARS);
		const nl = slice.lastIndexOf("\n");
		return nl > EAGER_MD_CHARS / 2 ? slice.slice(0, nl) : slice;
	}, [content, isLong, showAll]);

	const shown = showAll ? (fetched ?? content) : head;
	// Giant expanded payloads skip markdown entirely — see FULL_MD_CHARS.
	const asMarkdown = shown.length <= FULL_MD_CHARS;
	const html = useMemo(
		() => (asMarkdown ? renderMarkdown(shown) : ""),
		[asMarkdown, shown],
	);

	const expand = async () => {
		if (wireClamped && !fetched && entry && sessionId) {
			setFetching(true);
			try {
				const res = await fetch(
					`${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(entry.id)}`,
				);
				if (res.ok) {
					const data = await res.json();
					if (typeof data?.content === "string") setFetched(data.content);
				}
			} catch {
				// keep the wire-clamped text — the tail just stays truncated
			} finally {
				setFetching(false);
			}
		}
		setShowAll(true);
	};

	return (
		<>
			{asMarkdown ? (
				<MarkdownBody className={className} html={html || ""} />
			) : (
				<pre
					className={
						"my-1 max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-3 font-mono text-[12px] leading-relaxed text-fg"
					}
				>
					{shown}
				</pre>
			)}
			{isLong && (
				<button
					type="button"
					onClick={showAll ? () => setShowAll(false) : expand}
					className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-left font-sans text-[12px] font-medium text-dim hover:text-fg"
				>
					{fetching
						? "Loading…"
						: showAll
							? "Collapse"
							: `Show full message · ${sizeLabel(fullLength)}`}
				</button>
			)}
		</>
	);
}

/** Engine context-compaction summary (entry.compaction): the conversation
 * history was summarized to fit the model's context window and the handoff
 * summary is this entry's content. Rendered as a collapsed system pill —
 * without this it looks like the model randomly dumping a status report
 * mid-conversation — with the summary expandable for anyone who wants to see
 * what the model carried forward. */
function CompactionNotice({
	entry,
	sessionId,
}: {
	entry: TranscriptEntry;
	sessionId?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="msg msg-system" data-eid={entry.id}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="msg-system-text cursor-pointer [font-family:inherit]"
			>
				Context compacted — earlier conversation summarized to keep going ·{" "}
				<span className="font-medium text-dim">
					{open ? "hide summary" : "show summary"}
				</span>
			</button>
			{open && (
				<div className="mx-auto mt-2 w-full max-w-[560px] rounded-lg border border-line bg-panel px-4 py-3 text-left">
					<ClampedBody
						className="msg-body markdown"
						content={entry.content}
						entry={entry}
						sessionId={sessionId}
					/>
				</div>
			)}
		</div>
	);
}

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
	/** Lets a wire-clamped entry's "Show full message" fetch the full content. */
	sessionId?: string;
}

/** Inline images carried on an entry (Read-of-image results, pasted images).
 *  os-blob: markers (transcript-v2 bounded entries) resolve to the
 *  transcript-image route; real srcs pass through untouched. */
function EntryImages({
	images,
	sessionId,
}: {
	images?: string[];
	sessionId?: string;
}) {
	if (!images || images.length === 0) return null;
	return (
		<div className="msg-images">
			{images.map((raw, i) => {
				const src = resolveEntryImageSrc(raw, sessionId);
				return (
					<a
						key={i}
						href={src}
						target="_blank"
						rel="noopener noreferrer"
						className="md-image-link"
					>
						<img className="md-image" src={src} alt="" loading="lazy" />
					</a>
				);
			})}
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
	sessionId,
}: Props) {
	const me = useCurrentUser();
	// A routed-back teammate reply (human-in-the-loop): credit the teammate and
	// render just their words (the header is stripped — the label carries "who").
	const humanReply = useMemo(() => {
		if (entry.type !== "user") return null;
		const parsed = parseHumanReply(entry.content);
		return parsed ? { name: parsed.name, body: parsed.body } : null;
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

	// A review handoff (unsatisfied PR review's findings delivered into this
	// session) is a long instruction block, not an FYI — render it as a distinct
	// card with real markdown instead of the tiny centered msg-system pill
	// (which is right for short "🔀 merged" notices and stays for those).
	const reviewHandoff = useMemo(
		() =>
			entry.type === "user" && attribution && isGitHubAttribution(attribution.name)
				? parseReviewHandoff(attribution.body)
				: null,
		[entry.type, attribution],
	);
	if (entry.type === "user" && reviewHandoff) {
		return (
			<div className="msg" data-eid={entry.id}>
				<div className="border border-line rounded-lg bg-panel overflow-hidden">
					<div className="flex items-center gap-2 px-3.5 py-2 border-b border-line text-xs font-medium text-dim">
						<span>
							🔍 Review findings
							{reviewHandoff.prNumber ? ` · PR #${reviewHandoff.prNumber}` : ""}
						</span>
						<MsgTime ts={entry.timestamp} />
					</div>
					<ClampedBody
						className="msg-body markdown px-3.5 py-2.5"
						content={reviewHandoff.body}
						entry={entry}
						sessionId={sessionId}
					/>
				</div>
			</div>
		);
	}

	if (entry.type === "user" && attribution && isGitHubAttribution(attribution.name)) {
		return (
			<div className="msg msg-system" data-eid={entry.id}>
				<span className="msg-system-text">{displayContent}</span>
			</div>
		);
	}

	if (entry.type === "system" && entry.compaction) {
		return <CompactionNotice entry={entry} sessionId={sessionId} />;
	}

	if (entry.type === "system") {
		return (
			<div className="msg msg-system" data-eid={entry.id}>
				<span className="msg-system-text">{entry.content}</span>
			</div>
		);
	}

	if (entry.type === "user" && humanReply) {
		return (
			<div
				className="msg msg-human"
				data-eid={entry.id}
			>
				<div className="msg-label msg-label-human">
					💬 {humanReply.name} · via Slack
					<MsgTime ts={entry.timestamp} />
				</div>
				<ClampedBody
					className="msg-body msg-body-human markdown"
					content={humanReply.body}
					entry={entry}
					sessionId={sessionId}
				/>
				<EntryImages images={entry.images} sessionId={sessionId} />
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
			<div
				className="msg msg-user"
				data-eid={entry.id}
			>
				{fromOther && (
					<div className="msg-label msg-label-user">
						{fromOther}
						<MsgTime ts={entry.timestamp} />
					</div>
				)}
				{displayContent && (
					<ClampedBody
						className="msg-body msg-body-user markdown"
						content={displayContent}
						entry={entry}
						sessionId={sessionId}
					/>
				)}
				<EntryImages images={entry.images} sessionId={sessionId} />
				<EntryVideos videos={entry.videos} />
				<EntryFiles files={entry.files} />
			</div>
		);
	}

	// assistant — no speaker label: every left-aligned bubble is the agent, so
	// the name row was pure noise above each answer.
	return (
		<div
			className="msg msg-assistant"
			data-eid={entry.id}
		>
			<ClampedBody
				className="msg-body msg-body-assistant markdown"
				content={displayContent}
				entry={entry}
				sessionId={sessionId}
			/>
			<EntryImages images={entry.images} sessionId={sessionId} />
			<EntryVideos videos={entry.videos} />
		</div>
	);
});
