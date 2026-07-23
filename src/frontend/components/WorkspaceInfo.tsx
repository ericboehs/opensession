import { AGENT_NAME } from "../lib/brand";
import { BASE_PATH } from "../lib/base";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useResolvedTheme } from "./CodeHighlight";
import {
	fetchDiff,
	fetchPr,
	fetchGitStatus,
	gitPushApi,
	gitPullApi,
	setSessionReviewerApi,
	acceptReviewApi,
	triggerPrActionApi,
	type PrAgentAction,
	type WorkspaceMediaItem,
	type WorkspaceOverview,
	type SessionAssetFile,
} from "../lib/api";
import { getCurrentUser, TEAM } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { Menu } from "../ui/menu";
import type {
	DiffFile,
	GitStatusInfo,
	PrCheck,
	PrDetails,
} from "../lib/types";
import { formatPrCommentPrompt } from "./PrPanel";
import { renderMarkdown } from "../lib/markdown";
import { MarkdownBody } from "./MarkdownBody";
import {
	loadOverview,
	overviewCache,
	type OverviewChatRef,
} from "../lib/workspace-overview";
import { summarizeChecks } from "./PrStatusBar";
import { openLightbox } from "./MediaLightbox";
import { SandboxBadge } from "./SandboxBadge";
import {
	IconArrowDown,
	IconArrowUp,
	IconBell,
	IconCheck,
	IconClock,
	IconFile,
	IconGlobe,
	IconPlay,
	IconPullRequest,
	IconX,
} from "./icons";

/**
 * Workspace info block at the top of the right side panel (the "Info" tab): a
 * dense, at-a-glance catch-all — title + meta, a status row (checks, review,
 * PR state), the opening prompt, the summary, and a compact filmstrip of every
 * screenshot / video from the workspace's chats. Opening it answers "what is
 * this and where does it stand" without switching tabs; Changes / Terminal /
 * Checks are the drill-downs.
 *
 * Loading/caching for the overview lives in lib/workspace-overview (shared with
 * the sidebar's workspace hover card), including the pre-restart transcript
 * fallbacks. The PR is fetched here and refreshed on a slow interval.
 */

type PanelTab = "changes" | "terminal" | "pr" | "staging" | "assets";

type ReviewRequestInfo = {
	to: string;
	by: string;
	at: string;
	accepted?: { by: string; at: string };
};

interface Props {
	/** The open chat's session id — anchors the PR + Slack fetches. */
	sessionId: string;
	/** The chat's workspace (projectId); null = workspace-less (fallback only). */
	workspaceId: string | null;
	workspaceName?: string;
	/** Sibling chats, oldest first (the tab strip's list). */
	chats: Array<OverviewChatRef & { startedBy?: string | null }>;
	/** Primary repo the workspace's chats work in. */
	repo?: string;
	/** PR lane state, when the session has a PR — gates the PR fetch. */
	prState?: string | null;
	/** The open chat's sandbox opt-in — renders a provider/mode badge in the
	    status row (from session fields only; no container polling). */
	sandbox?: { provider: string; sandboxId?: string; workspace?: "bind" | "volume" };
	/** Pending review request for this workspace — the open chat's, or a sibling
	    chat's (the request is per-chat but the band groups by workspace). */
	reviewRequest?: ReviewRequestInfo | null;
	/** The chat that owns `reviewRequest` (may be a sibling, not the open one). */
	reviewRequestSessionId?: string;
	/** Optimistically push a reviewer pick / sign-off into the app-level session
	    list, so the sidebar's review bands + the other chip instance flip at once
	    instead of waiting up to a poll (~5s) for the change to round-trip. */
	onReviewChange?: (sessionId: string, req: ReviewRequestInfo | null) => void;
	/** Jump to a sibling tab when a status chip / reply row is clicked. */
	onOpenTab?: (tab: PanelTab) => void;
	/** The session's scratch assets — listed in the Info panel; clicking one
	    opens the full-width Assets view-tab focused on that file. */
	assets?: SessionAssetFile[];
	/** Open the Assets view-tab focused on a specific asset (a list-row click). */
	onOpenAsset?: (path: string) => void;
	/** Prefill the composer (the per-comment "Add to chat" hover action). */
	onAddToInput?: (text: string) => void;
	/** Navigate to a session — used by Auto-fix, which spins up a new chat in this
	    workspace and jumps into it. */
	onOpenSession?: (id: string) => void;
	/** Prompt the session (the Status section's Commit action) — the WS `prompt`
	    message. Absent in read-only mounts, where Commit is simply hidden. */
	send?: (msg: any) => void;
	/** Media items currently in the open chat's live entries — bumps refresh
	    the panel as new screenshots land during a run. */
	liveMediaCount: number;
	/** Images visible in the chat UI before the transcript-backed overview catches up. */
	liveMedia?: WorkspaceMediaItem[];
}

type ChipTone = "green" | "red" | "yellow" | "purple" | "muted";

type StatusChip = {
	key: string;
	label: string;
	tone: ChipTone;
	/** Optional leading glyph, pulled from the icon library (never raw unicode). */
	icon?: React.ReactNode;
};

/** The check/review/PR-state chips shown in the status row (only the ones that
    say something are rendered). */
function statusChips(pr: PrDetails | null): StatusChip[] {
	if (!pr) return [];
	const chips: StatusChip[] = [];
	if (pr.state === "MERGED")
		chips.push({ key: "merged", label: "Merged", tone: "purple" });
	else if (pr.state === "CLOSED")
		chips.push({ key: "closed", label: "Closed", tone: "muted" });
	else if (pr.isDraft) chips.push({ key: "draft", label: "Draft", tone: "muted" });

	const c = summarizeChecks(pr);
	if (c.failed > 0)
		chips.push({
			key: "checks",
			label: `${c.failed} check${c.failed === 1 ? "" : "s"} failing`,
			tone: "red",
			icon: <IconX size={20} />,
		});
	else if (c.pending > 0)
		chips.push({
			key: "checks",
			label: `${c.pending} check${c.pending === 1 ? "" : "s"} pending`,
			tone: "yellow",
			icon: <IconClock size={20} />,
		});
	else if (c.passed > 0)
		chips.push({
			key: "checks",
			label: "Checks passing",
			tone: "green",
			icon: <IconCheck size={20} />,
		});

	if (pr.mergeable === "CONFLICTING")
		chips.push({ key: "conflicts", label: "Merge conflicts", tone: "red" });
	if (pr.reviewDecision === "CHANGES_REQUESTED")
		chips.push({ key: "review", label: "Changes requested", tone: "red" });
	else if (pr.reviewDecision === "APPROVED")
		chips.push({ key: "review", label: "Approved", tone: "green" });
	else if (pr.reviewDecision === "REVIEW_REQUIRED")
		chips.push({ key: "review", label: "Review needed", tone: "yellow" });
	return chips;
}

function initial(name: string): string {
	return (name.trim()[0] || "?").toUpperCase();
}
function hueFor(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
	return Math.abs(h) % 360;
}
/** Flatten a GitHub markdown/HTML comment body into a clean one-glance
    preview: drop HTML comments/tags, collapse markdown emphasis + headings,
    turn links into their label, squash whitespace. */
function plainComment(body: string): string {
	return body
		.replace(/<!--[\s\S]*?-->/g, "") // HTML comments (bot markers)
		.replace(/<[^>]+>/g, "") // HTML tags
		.replace(/```[\s\S]*?```/g, " ") // fenced code blocks
		.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "") // link-ref defs (Vercel [vc]: #…)
		.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "") // markdown table separator rows
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
		.replace(/^#{1,6}\s+/gm, "") // heading markers
		.replace(/\s*\|\s*/g, " · ") // table cells → separators
		.replace(/[*_`>]/g, "") // emphasis / code / quote marks
		.replace(/(?:\s·\s)+/g, " · ") // collapse repeated separators
		.replace(/^[\s·]+|[\s·]+$/g, "") // trim leading/trailing separators
		.replace(/\s+/g, " ")
		.trim();
}

/** Clean a GitHub comment body for markdown rendering: drop bot markers and
    link-ref noise, and downgrade raw HTML to equivalent markdown (our renderer
    escapes raw tags for safety, so <h3>/<br>/etc. would otherwise show as
    literal text) — while KEEPING real markdown structure (headings, lists,
    tables, code fences, line breaks). */
function cleanCommentMarkdown(body: string): string {
	return body
		.replace(/<!--[\s\S]*?-->/g, "") // HTML comments (bot markers)
		.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "") // link-ref defs (Vercel [vc]: #…)
		.replace(/<h([1-6])[^>]*>\s*([\s\S]*?)<\/h\1>/gi, (_m, _n, t) => `\n### ${t.trim()}\n`)
		.replace(/<br\s*\/?>/gi, "\n") // explicit line breaks
		.replace(/<\/(p|div|li|tr|table|ul|ol|details)>/gi, "\n") // block ends → break
		.replace(/<[^>]+>/g, "") // remaining tags → keep inner text
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS_CHAR: Record<DiffFile["status"], string> = {
	added: "A",
	untracked: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
};
/** untracked shares the "added" tint. */
function statusClass(status: DiffFile["status"]): string {
	return status === "untracked" ? "added" : status;
}

function relTime(iso?: string): string {
	if (!iso) return "";
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return "";
	const s = Math.round((Date.now() - t) / 1000);
	if (s < 60) return "now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

// How many file rows / comments the compact preview shows before deferring to
// the drill-down tab.
const FILE_PREVIEW = 6;
const COMMENT_PREVIEW = 3;

/** Where to float the hover popover, computed from the card's viewport rect.
    Prefers the space to the LEFT of the card (the comments live in the right
    panel) so the popover never covers the list; falls back to overlaying the
    card only when there isn't room on the left. */
function popoverPosition(
	rect: DOMRect,
	opts: { maxWidth?: number; maxHeightPx?: number; heightFrac?: number } = {},
): {
	left: number;
	top: number;
	width: number;
	maxHeight: number;
} {
	const { maxWidth = 440, maxHeightPx = 560, heightFrac = 0.7 } = opts;
	const margin = 12;
	const gap = 10;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const maxHeight = Math.min(Math.round(vh * heightFrac), maxHeightPx);
	const spaceLeft = rect.left - margin - gap;

	let width: number;
	let left: number;
	if (spaceLeft >= 300) {
		// Prefer floating left, but when there's no room for the wider card fall
		// back to overlaying the panel (so a code diff isn't squeezed to a sliver).
		width = spaceLeft >= maxWidth ? maxWidth : Math.min(maxWidth, vw - margin * 2);
		left =
			spaceLeft >= maxWidth
				? rect.left - gap - width
				: Math.max(margin, Math.min(rect.left, vw - width - margin));
	} else {
		width = Math.min(Math.max(rect.width, 380), vw - margin * 2);
		left = Math.max(margin, Math.min(rect.left, vw - width - margin));
	}
	// Align to the card's top, but lift up if it would spill past the bottom.
	const top = Math.max(
		margin,
		Math.min(rect.top, vh - margin - Math.min(maxHeight, vh - margin * 2)),
	);
	return { left, top, width, maxHeight };
}

/** The author's real GitHub avatar (Greptile, Tella Butler, Vercel, a human…),
    served at github.com/<login>.png. Falls back to a lettered brand tile if the
    image 404s or the author isn't a plausible login (e.g. a display name). */
function CommentAvatar({ author }: { author: string }) {
	const login = (author || "").trim();
	// GitHub usernames/app slugs: alphanumerics with single interior hyphens,
	// ≤39 chars — skips display names with spaces so we don't 404 on those.
	const canAvatar = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login);
	const [failed, setFailed] = useState(false);
	if (canAvatar && !failed) {
		return (
			<img
				className="workspace-info-comment-avatar"
				src={`https://github.com/${login}.png?size=48`}
				alt=""
				aria-hidden
				loading="lazy"
				onError={() => setFailed(true)}
			/>
		);
	}
	return (
		<span
			className="workspace-info-comment-avatar"
			style={{ background: `hsl(${hueFor(login || "?")} 52% 42%)` }}
			aria-hidden
		>
			{initial(login || "?")}
		</span>
	);
}

/** One PR comment as a single dense row: avatar · one-line title · time. The
    title is the flattened first slice of the body, ellipsised. Hovering floats
    the full markdown comment in a popover on top (never shifting the list); a
    hover "Add to chat" drops it into the composer; clicking opens the PR tab. */
function CommentCard({
	comment,
	pr,
	onOpenTab,
	onAddToInput,
}: {
	comment: { author: string; body: string; url?: string; createdAt?: string };
	pr: PrDetails;
	onOpenTab?: (tab: PanelTab) => void;
	onAddToInput?: (text: string) => void;
}) {
	const cardRef = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [pop, setPop] = useState<DOMRect | null>(null);
	const html = useMemo(
		() => renderMarkdown(cleanCommentMarkdown(comment.body)),
		[comment.body],
	);
	// The one-line label: lead with the comment's title/first words, flattened.
	const title = useMemo(() => plainComment(comment.body), [comment.body]);
	useEffect(
		() => () => {
			if (closeTimer.current) clearTimeout(closeTimer.current);
		},
		[],
	);

	function openPop() {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		if (cardRef.current) setPop(cardRef.current.getBoundingClientRect());
	}
	function closePop() {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(() => setPop(null), 90);
	}

	const addBtn = onAddToInput && (
		<button
			type="button"
			className="workspace-info-comment-add"
			onClick={(e) => {
				e.stopPropagation();
				onAddToInput(formatPrCommentPrompt(comment, pr));
			}}
			title="Add this comment to the chat composer"
		>
			Add to chat
		</button>
	);
	const avatar = <CommentAvatar author={comment.author} />;

	const pos = pop ? popoverPosition(pop) : null;

	return (
		<>
			<div
				ref={cardRef}
				className="workspace-info-comment"
				role="button"
				tabIndex={0}
				onClick={() => onOpenTab?.("pr")}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") onOpenTab?.("pr");
				}}
				onMouseEnter={openPop}
				onMouseLeave={closePop}
				title={comment.author}
			>
				{avatar}
				<span className="workspace-info-comment-title">{title}</span>
				<span className="workspace-info-comment-time">
					{relTime(comment.createdAt)}
				</span>
				{addBtn}
			</div>
			{pop &&
				pos &&
				createPortal(
					<div
						className="workspace-info-comment-pop"
						style={{
							left: pos.left,
							top: pos.top,
							width: pos.width,
							maxHeight: pos.maxHeight,
						}}
						onMouseEnter={openPop}
						onMouseLeave={closePop}
						onClick={() => onOpenTab?.("pr")}
					>
						{avatar}
						<div className="workspace-info-comment-main">
							<div className="workspace-info-comment-pop-head">
								<span className="workspace-info-comment-author">
									{comment.author}
								</span>
								{comment.createdAt && (
									<span className="workspace-info-comment-time">
										{relTime(comment.createdAt)}
									</span>
								)}
							</div>
							<div className="workspace-info-comment-pop-body">
								<MarkdownBody html={html} className="markdown" />
							</div>
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}

/** Read-only render options for the hover diff — no line selection, our own
    header owns the file name, unified view themed to the app appearance. */
const PREVIEW_DIFF_OPTIONS = {
	diffStyle: "unified" as const,
	disableFileHeader: true,
	overflow: "scroll" as const,
	enableLineSelection: false,
};

/**
 * One "file changed" row. Hovering reveals a floated card with the file's actual
 * diff (parsed from the primary repo's patch), mirroring the PR-comment hover in
 * the same panel; clicking still jumps to the full Changes tab. Rows whose file
 * isn't in the parsed patch (binary, or a not-yet-loaded/truncated patch) simply
 * don't open a popover.
 */
function FileRow({
	file,
	meta,
	theme,
	onOpenTab,
}: {
	file: DiffFile;
	meta: FileDiffMetadata | undefined;
	theme: "light" | "dark";
	onOpenTab?: (tab: PanelTab) => void;
}) {
	const rowRef = useRef<HTMLButtonElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [pop, setPop] = useState<DOMRect | null>(null);
	useEffect(
		() => () => {
			if (closeTimer.current) clearTimeout(closeTimer.current);
		},
		[],
	);

	function openPop() {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		if (meta && rowRef.current) setPop(rowRef.current.getBoundingClientRect());
	}
	function closePop() {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(() => setPop(null), 90);
	}

	const slash = file.path.lastIndexOf("/");
	const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
	const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
	const options = useMemo(
		() => ({
			...PREVIEW_DIFF_OPTIONS,
			theme: theme === "light" ? "pierre-light" : "pierre-dark",
			themeType: theme,
		}),
		[theme],
	);
	// Wider + taller than the comment popover — this is code, so give it room.
	const pos = pop
		? popoverPosition(pop, { maxWidth: 720, maxHeightPx: 720, heightFrac: 0.82 })
		: null;

	const stats = (
		<span className="diff-file-stats">
			{file.additions > 0 && <span className="diff-add">+{file.additions}</span>}
			{file.deletions > 0 && <span className="diff-del">−{file.deletions}</span>}
		</span>
	);
	const path = (
		<span className="workspace-info-file-path">
			{dir && <span className="workspace-info-file-dir">{dir}</span>}
			<span className="workspace-info-file-base">{base}</span>
		</span>
	);

	return (
		<>
			<button
				ref={rowRef}
				type="button"
				className="workspace-info-file"
				onClick={() => onOpenTab?.("changes")}
				onMouseEnter={openPop}
				onMouseLeave={closePop}
				title={`${file.path} — open in Changes`}
			>
				<span className={`diff-status diff-status-${statusClass(file.status)}`}>
					{STATUS_CHAR[file.status]}
				</span>
				{path}
				{stats}
			</button>
			{pop &&
				pos &&
				meta &&
				createPortal(
					<div
						className="workspace-info-file-pop"
						style={{
							left: pos.left,
							top: pos.top,
							width: pos.width,
							maxHeight: pos.maxHeight,
						}}
						onMouseEnter={openPop}
						onMouseLeave={closePop}
						onClick={() => onOpenTab?.("changes")}
					>
						<div className="workspace-info-file-pop-head">
							{path}
							{stats}
						</div>
						<div className="workspace-info-file-pop-body">
							<FileDiff fileDiff={meta} options={options} disableWorkerPool />
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}

type CheckVisual = "success" | "failure" | "pending" | "skipped" | "neutral";

/** Map a PR check's raw status/conclusion to a visual kind + the word shown at
    the right of its row (GitHub-style: "Succeeded", "Skipped", "Failed"…).
    CheckRuns report `status` until COMPLETED; StatusContexts (Vercel deploys)
    leave `status` empty and carry the outcome in `conclusion`. */
function checkStatusMeta(check: PrCheck): { kind: CheckVisual; label: string } {
	const running = check.status !== "COMPLETED" && check.status !== "";
	if (running || check.conclusion === "PENDING" || check.conclusion === "EXPECTED")
		return { kind: "pending", label: running ? "Running" : "Queued" };
	switch (check.conclusion) {
		case "SUCCESS":
			return { kind: "success", label: "Succeeded" };
		case "FAILURE":
			return { kind: "failure", label: "Failed" };
		case "TIMED_OUT":
			return { kind: "failure", label: "Timed out" };
		case "ERROR":
			return { kind: "failure", label: "Error" };
		case "ACTION_REQUIRED":
			return { kind: "failure", label: "Action required" };
		case "CANCELLED":
			return { kind: "neutral", label: "Cancelled" };
		case "SKIPPED":
			return { kind: "skipped", label: "Skipped" };
		case "NEUTRAL":
			return { kind: "neutral", label: "Neutral" };
		default:
			return { kind: "neutral", label: check.conclusion || "Pending" };
	}
}

/** The small leading status glyph — a filled green check / red ✕, a spinner
    while running, or a dashed ring for skipped/neutral. Color comes from the
    row's `wi-check-<kind>` class. */
function CheckStatusIcon({ kind }: { kind: CheckVisual }) {
	if (kind === "pending") return <span className="wi-check-spin" aria-hidden />;
	if (kind === "success")
		return (
			<svg className="wi-check-ico" viewBox="0 0 16 16" aria-hidden>
				<circle cx="8" cy="8" r="8" fill="currentColor" />
				<path
					d="M4.4 8.3l2.3 2.3 4.9-4.9"
					fill="none"
					stroke="#fff"
					strokeWidth="1.7"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		);
	if (kind === "failure")
		return (
			<svg className="wi-check-ico" viewBox="0 0 16 16" aria-hidden>
				<circle cx="8" cy="8" r="8" fill="currentColor" />
				<path
					d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"
					stroke="#fff"
					strokeWidth="1.7"
					strokeLinecap="round"
				/>
			</svg>
		);
	// skipped / neutral — a dashed outline ring
	return (
		<svg className="wi-check-ico" viewBox="0 0 16 16" aria-hidden>
			<circle
				cx="8"
				cy="8"
				r="7"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeDasharray="2.4 2.2"
			/>
		</svg>
	);
}

/** The checks status chip in the info panel's status row. Clicking opens the PR
    tab; hovering floats a GitHub-style overview of every individual check —
    icon · name · outcome — off to the side of the panel (never covering it). */
function ChecksChip({
	pr,
	chip,
	onOpenTab,
}: {
	pr: PrDetails;
	chip: StatusChip;
	onOpenTab?: (tab: PanelTab) => void;
}) {
	const btnRef = useRef<HTMLButtonElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [pop, setPop] = useState<DOMRect | null>(null);
	useEffect(
		() => () => {
			if (closeTimer.current) clearTimeout(closeTimer.current);
		},
		[],
	);

	function openPop() {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		if (btnRef.current) setPop(btnRef.current.getBoundingClientRect());
	}
	function closePop() {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = setTimeout(() => setPop(null), 120);
	}

	// Failing first, then running, successes, and skipped/neutral last — the
	// same triage order the PR panel's expanded list uses.
	const order: Record<CheckVisual, number> = {
		failure: 0,
		pending: 1,
		success: 2,
		skipped: 3,
		neutral: 3,
	};
	const checks = [...(pr.checks || [])].sort(
		(a, b) => order[checkStatusMeta(a).kind] - order[checkStatusMeta(b).kind],
	);
	const sum = summarizeChecks(pr);
	const pos = pop ? popoverPosition(pop) : null;

	return (
		<>
			<button
				ref={btnRef}
				type="button"
				className={`wi-chip wi-chip-${chip.tone}`}
				onClick={() => onOpenTab?.("pr")}
				onMouseEnter={openPop}
				onMouseLeave={closePop}
			>
				{chip.icon && <span className="wi-chip-icon">{chip.icon}</span>}
				{chip.label}
			</button>
			{pop &&
				pos &&
				checks.length > 0 &&
				createPortal(
					<div
						className="workspace-info-checks-pop"
						style={{
							left: pos.left,
							top: pos.top,
							width: pos.width,
							maxHeight: pos.maxHeight,
						}}
						onMouseEnter={openPop}
						onMouseLeave={closePop}
					>
						<div className="workspace-info-checks-head">
							<span className="workspace-info-checks-title">
								{checks.length} check{checks.length === 1 ? "" : "s"}
							</span>
							<span className="workspace-info-checks-summary">
								{sum.passed > 0 && (
									<span className="check-success-text">{sum.passed} passed</span>
								)}
								{sum.failed > 0 && (
									<span className="check-failure-text">{sum.failed} failed</span>
								)}
								{sum.pending > 0 && (
									<span className="check-pending-text">{sum.pending} running</span>
								)}
							</span>
						</div>
						<div className="workspace-info-checks-list">
							{checks.map((check, i) => {
								const m = checkStatusMeta(check);
								const inner = (
									<>
										<span className={`wi-check-icon wi-check-${m.kind}`}>
											<CheckStatusIcon kind={m.kind} />
										</span>
										<span className="workspace-info-check-name">{check.name}</span>
										<span className="workspace-info-check-status">{m.label}</span>
									</>
								);
								return check.url ? (
									<a
										key={`${check.name}:${i}`}
										className="workspace-info-check-row"
										href={check.url}
										target="_blank"
										rel="noopener"
									>
										{inner}
									</a>
								) : (
									<div key={`${check.name}:${i}`} className="workspace-info-check-row">
										{inner}
									</div>
								);
							})}
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}

/** The GitHub PR agent behaviors, surfaced as one-tap buttons on the info panel.
    Each maps to a michael-* PR label; hitting the button is equivalent to adding
    that label on GitHub (or @mentioning the agent on the PR), but without leaving
    Backstage. tella-fusion PRs only — the agent is repo-scoped. */
const PR_AGENT_ACTIONS: Array<{
	kind: PrAgentAction;
	label: string;
	hint: string;
}> = [
	{
		kind: "review",
		label: "Review",
		hint: "Full review pass (os-review). Findings are posted on the PR.",
	},
	{
		kind: "autofix",
		label: "Auto-fix",
		hint: "Opens a new chat in this workspace that fixes every finding + failing CI and pushes. Watch and steer it live.",
	},
	{
		kind: "simplify",
		label: "Simplify",
		hint: "Quality cleanup pass: reuse, simpler shapes, dead code (os-simplify)",
	},
	{
		kind: "adversarial",
		label: "Adversarial",
		hint: "Deeper two-pass adversarial review (os-adversarial)",
	},
];

function PrAgentActions({
	sessionId,
	repo,
	prUrl,
	onOpenSession,
}: {
	sessionId: string;
	repo?: string;
	prUrl?: string;
	onOpenSession?: (id: string) => void;
}) {
	const [busy, setBusy] = useState<PrAgentAction | null>(null);
	const [done, setDone] = useState<{ label: string; bksId?: string } | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);

	async function run(action: (typeof PR_AGENT_ACTIONS)[number]) {
		if (busy) return;
		setBusy(action.kind);
		setError(null);
		setDone(null);
		try {
			const res = await triggerPrActionApi(
				sessionId,
				action.kind,
				getCurrentUser(),
				repo,
			);
			if (res.ok) {
				// Auto-fix opens a live chat in this workspace — jump straight into it
				// instead of leaving a "posted on the PR" note behind.
				if (res.openChat && res.bksId && onOpenSession) {
					onOpenSession(res.bksId);
					return;
				}
				setDone({ label: action.label, bksId: res.bksId });
			} else setError(res.error || res.message || "Couldn't start");
		} catch (e: any) {
			setError(e?.message || "Couldn't start");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="workspace-info-agent mt-3">
			<div className="workspace-info-label">Ask {AGENT_NAME}</div>
			<div className="mt-2 flex flex-wrap gap-1.5">
				{PR_AGENT_ACTIONS.map((a) => (
					<button
						key={a.kind}
						type="button"
						title={a.hint}
						disabled={busy !== null}
						onClick={() => run(a)}
						className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:border-line-strong hover:bg-panel disabled:opacity-50"
					>
						{busy === a.kind ? "Starting…" : a.label}
					</button>
				))}
			</div>
			{done && (
				<div className="mt-1.5 text-[11.5px] font-medium text-dim">
					Started {done.label.toLowerCase()} — {AGENT_NAME} will post results on{" "}
					{prUrl ? (
						<a
							href={prUrl}
							target="_blank"
							rel="noopener"
							className="text-fg underline decoration-line-strong underline-offset-2"
						>
							the PR
						</a>
					) : (
						"the PR"
					)}
					{done.bksId && (
						<>
							{" · "}
							<a
								href={`${BASE_PATH}/session/${encodeURIComponent(done.bksId)}`}
								className="text-fg underline decoration-line-strong underline-offset-2"
							>
								open run
							</a>
						</>
					)}
				</div>
			)}
			{error && (
				<div className="mt-1.5 text-[11.5px] font-medium text-red">{error}</div>
			)}
		</div>
	);
}

/** The Reviewer picker chip in the status row: pick a teammate to flag this
    session as "needs review" — it jumps into a Needs-review band at the top of
    their sidebar and buzzes their registered devices. Re-pick to hand off,
    "Clear review request" to withdraw. Optimistic; the polled session list
    confirms (or reverts) on the next refresh. */
function ReviewerChip({
	sessionId,
	reviewRequest,
	requestSessionId,
	onReviewChange,
}: {
	sessionId: string;
	reviewRequest?: ReviewRequestInfo | null;
	/** The chat that actually holds the request — a workspace's request may live
	    on a sibling chat, not the open one. Clear/re-assign target this so the
	    chip stays consistent with the sidebar's workspace-level band; a brand-new
	    request (none exists) targets the open `sessionId`. */
	requestSessionId?: string;
	/** Optimistically mirror a pick / sign-off into the app-level session list so
	    every other surface (sidebar bands, the sibling chip) updates immediately. */
	onReviewChange?: (sessionId: string, req: ReviewRequestInfo | null) => void;
}) {
	const [req, setReq] = useState(reviewRequest ?? null);
	// Follow the polled session as it refreshes (another viewer may re-assign or
	// sign off). Track accepted's timestamp too so the sign-off lands live.
	useEffect(() => {
		setReq(reviewRequest ?? null);
	}, [reviewRequest?.to, reviewRequest?.at, reviewRequest?.accepted?.at]);

	// The chat that owns an existing request; a brand-new one anchors to the open chat.
	const owner = (req && requestSessionId) || sessionId;
	const accepted = req?.accepted ?? null;

	function pick(name: string | null) {
		const prev = req;
		const me = getCurrentUser();
		// Re-assigning drops any prior sign-off (a fresh reviewer, fresh review).
		const next = name ? { to: name, by: me, at: new Date().toISOString() } : null;
		setReq(next);
		onReviewChange?.(owner, next);
		setSessionReviewerApi(owner, name, me).catch(() => {
			setReq(prev);
			onReviewChange?.(owner, prev);
		});
	}

	function accept(value: boolean) {
		if (!req) return;
		const prev = req;
		const me = getCurrentUser();
		const next: ReviewRequestInfo = {
			...req,
			accepted: value ? { by: me, at: new Date().toISOString() } : undefined,
		};
		setReq(next);
		onReviewChange?.(owner, next);
		acceptReviewApi(owner, value, me).catch(() => {
			setReq(prev);
			onReviewChange?.(owner, prev);
		});
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				className={`wi-chip ${
					accepted ? "wi-chip-green" : req ? "wi-chip-yellow" : "wi-chip-muted"
				}`}
				title={
					accepted
						? `Reviewed by ${accepted.by}`
						: req
							? `Review requested by ${req.by}`
							: "Ask a teammate to review this session"
				}
			>
				{accepted ? (
					<UserAvatar name={accepted.by} size={20}>
						<span className="wi-chip-avatar-check">
							<IconCheck size={12} />
						</span>
					</UserAvatar>
				) : req ? (
					<UserAvatar name={req.to} size={20} />
				) : (
					<span className="wi-chip-icon">
						<IconBell size={20} />
					</span>
				)}
				{accepted
					? `Reviewed by ${accepted.by}`
					: req
						? `Review: ${req.to}`
						: "Request review"}
			</Menu.Trigger>
			<Menu.Popup align="start" sideOffset={6} className="min-w-[200px]">
				{req &&
					(accepted ? (
						<Menu.Item onClick={() => accept(false)}>
							<IconBell size={20} className="text-dim" />
							<span className="min-w-0 flex-1 truncate">Reopen review</span>
						</Menu.Item>
					) : (
						<Menu.Item onClick={() => accept(true)}>
							<IconCheck size={20} className="text-dim" />
							<span className="min-w-0 flex-1 truncate">Mark as reviewed</span>
						</Menu.Item>
					))}
				{req && <Menu.Separator />}
				{TEAM.map((name) => (
					<Menu.Item key={name} onClick={() => pick(name)}>
						<UserAvatar name={name} size={22} />
						<span className="min-w-0 flex-1 truncate">{name}</span>
						{req?.to === name && <IconCheck size={20} className="text-dim" />}
					</Menu.Item>
				))}
				{req && (
					<>
						<Menu.Separator />
						<Menu.Item className="text-dim" onClick={() => pick(null)}>
							Clear review request
						</Menu.Item>
					</>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}

/**
 * The "Status" section of the info panel: the PR/branch state, plus a row per
 * outstanding git fact — ahead of remote → Push, behind → Update, dirty tree →
 * Commit. This is the Conductor-style status header (see server/git-status.ts),
 * surfaced in the info panel's own idiom (a labelled section, not a bordered
 * card). Push/Update call the git APIs directly; Commit prompts the session
 * (we don't do bare `git commit` — a session-authored commit gets a real
 * message), matching how Create PR / Resolve work in the status strip.
 */
function GitStatusRows({
	sessionId,
	repo,
	git,
	send,
	onReload,
}: {
	sessionId: string;
	repo?: string;
	git: GitStatusInfo | null;
	send?: (msg: any) => void;
	onReload: () => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [prompted, setPrompted] = useState(false);

	const ahead = git?.ahead ?? 0;
	const behind = git?.behind ?? 0;
	const behindBase = git?.behindBase ?? 0;
	const dirty = git?.uncommittedFiles ?? 0;

	// Behind counts fold together — a stale upstream reads "behind remote", a
	// fresh branch behind its base reads "behind <base>". PR state is omitted
	// here: it already lives in the status strip at the top of the panel.
	const behindCount = behind > 0 ? behind : behindBase;
	const behindWhat = behind > 0 ? "remote" : git?.baseBranch || "main";

	const hasRows = ahead > 0 || behindCount > 0 || dirty > 0;
	if (!hasRows) return null;

	async function run(name: string, fn: () => Promise<unknown>) {
		if (busy) return;
		setBusy(name);
		setError(null);
		try {
			await fn();
			onReload();
		} catch (e: any) {
			setError(e?.message || `${name} failed`);
		} finally {
			setBusy(null);
		}
	}

	function commit() {
		if (!send) return;
		send({
			type: "prompt",
			sessionId,
			user: getCurrentUser(),
			content: `Commit the ${dirty} uncommitted file${
				dirty === 1 ? "" : "s"
			} in this worktree with a clear, descriptive message, then push.`,
		});
		setPrompted(true);
		setTimeout(() => setPrompted(false), 6000);
	}

	return (
		<div className="workspace-info-section">
			<div className="workspace-info-label">Status</div>
			<div className="wi-git-rows">
				{ahead > 0 && (
						<div className="wi-git-row">
							<span className="wi-git-dot" />
							<span className="wi-git-label">
								{ahead} commit{ahead === 1 ? "" : "s"} ahead of remote
							</span>
							<button
								type="button"
								className="pr-bar-btn pr-bar-btn-solid wi-git-btn"
								disabled={!!busy}
								onClick={() => run("push", () => gitPushApi(sessionId, repo))}
							>
								<span className="pr-bar-btn-icon">
									<IconArrowUp size={18} />
								</span>
								<span className="pr-bar-btn-label">
									{busy === "push" ? "Pushing…" : "Push"}
								</span>
							</button>
						</div>
					)}
					{behindCount > 0 && (
						<div className="wi-git-row">
							<span className="wi-git-dot" />
							<span className="wi-git-label">
								{behindCount} commit{behindCount === 1 ? "" : "s"} behind{" "}
								{behindWhat}
							</span>
							<button
								type="button"
								className="pr-bar-btn pr-bar-btn-solid wi-git-btn"
								disabled={!!busy}
								title={`Fast-forward to origin/${behindWhat === "remote" ? git?.branch || "the upstream" : behindWhat}`}
								onClick={() =>
									run("pull", () => gitPullApi(sessionId, repo, behind === 0))
								}
							>
								<span className="pr-bar-btn-icon">
									<IconArrowDown size={18} />
								</span>
								<span className="pr-bar-btn-label">
									{busy === "pull" ? "Updating…" : "Update"}
								</span>
							</button>
						</div>
					)}
					{dirty > 0 && (
						<div className="wi-git-row">
							<span className="wi-git-dot" />
							<span className="wi-git-label">
								{dirty} uncommitted file{dirty === 1 ? "" : "s"}
							</span>
							{send &&
								(prompted ? (
									<span className="pr-bar-prompted wi-git-prompted">
										Asked {AGENT_NAME} ✓
									</span>
								) : (
									<button
										type="button"
										className="pr-bar-btn pr-bar-btn-secondary wi-git-btn"
										onClick={commit}
										title={`Ask ${AGENT_NAME} to commit the uncommitted changes and push`}
									>
										<span className="pr-bar-btn-label">Commit</span>
									</button>
								))}
						</div>
					)}
				</div>
			{error && <div className="wi-git-error">{error}</div>}
		</div>
	);
}

export function WorkspaceInfo({
	sessionId,
	workspaceId,
	workspaceName,
	chats,
	repo,
	prState,
	sandbox,
	reviewRequest,
	reviewRequestSessionId,
	onReviewChange,
	onOpenTab,
	onAddToInput,
	onOpenSession,
	send,
	liveMediaCount,
	liveMedia = [],
	assets = [],
	onOpenAsset,
}: Props) {
	const chatsKey = chats.map((c) => c.id).join(",");
	const cacheKey = workspaceId || `chats:${chatsKey}`;
	const [data, setData] = useState<WorkspaceOverview | null>(
		() => overviewCache.get(cacheKey)?.data ?? null,
	);
	const [promptExpanded, setPromptExpanded] = useState(false);
	const [commentsExpanded, setCommentsExpanded] = useState(false);
	const [pr, setPr] = useState<PrDetails | null>(null);
	const [files, setFiles] = useState<DiffFile[] | null>(null);
	// The primary repo's raw patch, kept so the file rows can hover-reveal the
	// actual diff for that file (parsed lazily below).
	const [rawPatch, setRawPatch] = useState<string>("");
	// Local git state (ahead/behind, dirty tree) for the Status section.
	const [git, setGit] = useState<GitStatusInfo | null>(null);

	// The chats array is re-created every App render — read it through a ref so
	// the fetch effect keys on the stable chatsKey instead.
	const chatsRef = useRef(chats);
	chatsRef.current = chats;

	useEffect(() => {
		let alive = true;
		const cached = overviewCache.get(cacheKey);
		setData(cached?.data ?? null);
		setPromptExpanded(false);
		setCommentsExpanded(false);
		// Fresh cache → refresh quietly in the background after a beat (also
		// debounces the liveMediaCount bumps during a streaming run).
		const t = setTimeout(
			() => {
				loadOverview(cacheKey, workspaceId, chatsRef.current)
					.then((ov) => {
						if (alive) setData(ov);
					})
					.catch(() => {
						// Keep whatever we had — the block just doesn't refresh.
					});
			},
			cached ? 1200 : 0,
		);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [cacheKey, chatsKey, workspaceId, liveMediaCount]);

	// PR (for the status chips) — gated so we don't fetch when there's nothing
	// to show, and refreshed on a slow interval while open.
	useEffect(() => {
		if (!prState) {
			setPr(null);
			return;
		}
		let alive = true;
		const load = () =>
			fetchPr(sessionId, repo)
				.then((p) => alive && setPr(p))
				.catch(() => {});
		load();
		const iv = setInterval(load, 45000);
		return () => {
			alive = false;
			clearInterval(iv);
		};
	}, [sessionId, repo, prState]);

	// Files changed — the primary repo's diff (Changes tab has the full view
	// + repo switcher; here we show a capped preview).
	useEffect(() => {
		if (!repo) {
			setFiles(null);
			setRawPatch("");
			return;
		}
		let alive = true;
		const load = () =>
			fetchDiff(sessionId)
				.then((res) => {
					if (!alive) return;
					const primary =
						res.repos.find((r) => r.primary) || res.repos[0] || null;
					setFiles(primary?.diff.files ?? []);
					setRawPatch(primary?.diff.rawPatch ?? "");
				})
				.catch(() => {});
		load();
		const iv = setInterval(load, 45000);
		return () => {
			alive = false;
			clearInterval(iv);
		};
	}, [sessionId, repo, liveMediaCount]);

	// Local git status (ahead/behind, uncommitted) for the Status section — same
	// slow poll, refetched as live media bumps (a proxy for run activity) so the
	// counts settle after a turn's auto-commit/push. Only when the chat has a repo.
	useEffect(() => {
		if (!repo) {
			setGit(null);
			return;
		}
		let alive = true;
		const load = () =>
			fetchGitStatus(sessionId, repo)
				.then((g) => alive && setGit(g))
				.catch(() => {});
		load();
		const iv = setInterval(load, 45000);
		return () => {
			alive = false;
			clearInterval(iv);
		};
	}, [sessionId, repo, liveMediaCount]);

	// Refetch git status right after a Push/Update lands, so the row clears
	// without waiting on the 45s poll.
	const reloadGit = () => {
		if (repo)
			fetchGitStatus(sessionId, repo)
				.then(setGit)
				.catch(() => {});
	};

	const oldest = chats[0];
	const started = oldest?.createdAt
		? new Date(oldest.createdAt).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			})
		: null;
	const meta = [
		repo,
		`${chats.length} chat${chats.length === 1 ? "" : "s"}`,
		oldest?.startedBy ? `by ${oldest.startedBy}` : null,
		started,
	]
		.filter(Boolean)
		.join(" · ");

	const chips = statusChips(pr);
	// Clean each body up front and drop the noise: Vercel deploy bots and
	// anything that reduces to nothing (link-ref markers, pure HTML-comment
	// bot pings) so no blank/useless cards show.
	const comments = (pr?.comments ?? [])
		.filter((c) => !/vercel/i.test(c.author || ""))
		.map((c) => ({ ...c, preview: plainComment(c.body) }))
		.filter((c) => c.preview.length > 0);
	const changed = files ?? [];
	const totalAdd = changed.reduce((n, f) => n + (f.additions || 0), 0);
	const totalDel = changed.reduce((n, f) => n + (f.deletions || 0), 0);
	// Parse the raw patch once into a path→file-diff map so each file row can
	// hover-reveal its own hunks (same @pierre/diffs parse the Changes tab uses).
	const diffTheme = useResolvedTheme();
	const diffByPath = useMemo(() => {
		const m = new Map<string, FileDiffMetadata>();
		if (!rawPatch.trim()) return m;
		try {
			for (const p of parsePatchFiles(rawPatch))
				for (const f of p.files) m.set(f.name, f);
		} catch {
			/* malformed patch — rows just fall back to a plain click. */
		}
		return m;
	}, [rawPatch]);
	const title = workspaceName || oldest?.title || "Untitled chat";
	const media = [...liveMedia, ...(data?.media || [])].filter(
		(m, i, all) =>
			all.findIndex(
				(x) =>
					x.kind === m.kind &&
					x.src === m.src &&
					x.sessionId === m.sessionId,
			) === i,
	);

	// Show the Status section when there's any local git delta to act on
	// (ahead / behind / uncommitted) — a clean tree stays quiet. PR state is not
	// mirrored here; it already lives in the status strip at the top of the panel.
	const showGit = Boolean(
		git &&
			(git.ahead > 0 ||
				git.behind > 0 ||
				git.behindBase > 0 ||
				git.uncommittedFiles > 0),
	);
	const hasBody = Boolean(
		showGit ||
			chips.length > 0 ||
			comments.length > 0 ||
			changed.length > 0 ||
			(data && data.prompt) ||
			media.length > 0 ||
			assets.length > 0,
	);

	return (
		<div className="workspace-info-panel">
			<div className="workspace-info-head">
				<div className="workspace-info-title selectable">{title}</div>
				{meta && <div className="workspace-info-meta">{meta}</div>}
				<div className="workspace-info-status">
					{chips.map((chip) =>
						chip.key === "checks" && pr ? (
							<ChecksChip
								key={chip.key}
								pr={pr}
								chip={chip}
								onOpenTab={onOpenTab}
							/>
						) : (
							<button
								key={chip.key}
								type="button"
								className={`wi-chip wi-chip-${chip.tone}`}
								onClick={() => onOpenTab?.("pr")}
							>
								{chip.icon && (
									<span className="wi-chip-icon">{chip.icon}</span>
								)}
								{chip.label}
							</button>
						),
					)}
					<ReviewerChip
					sessionId={sessionId}
					reviewRequest={reviewRequest}
					requestSessionId={reviewRequestSessionId}
					onReviewChange={onReviewChange}
				/>
					<SandboxBadge sandbox={sandbox} />
				</div>
				{repo && (
					<button
						type="button"
						className="workspace-info-review-btn"
						onClick={() => onOpenTab?.("pr")}
						title="Open the full-width review"
					>
						<IconPullRequest />
						Review changes
					</button>
				)}
				{prState === "OPEN" && pr?.staging?.url && (
					<button
						type="button"
						className="workspace-info-review-btn"
						onClick={() => onOpenTab?.("staging")}
						title="Open the staging deploy full-width"
					>
						<IconGlobe />
						Staging
					</button>
				)}
				{pr?.number && repo === "tella-fusion" && (
					<PrAgentActions
							sessionId={sessionId}
							repo={repo}
							prUrl={pr.url}
							onOpenSession={onOpenSession}
						/>
				)}
			</div>
			{hasBody ? (
				<div className="workspace-info-body">
					{showGit && (
						<GitStatusRows
							sessionId={sessionId}
							repo={repo}
							git={git}
							send={send}
							onReload={reloadGit}
						/>
					)}
					{comments.length > 0 && (
						<div className="workspace-info-section">
							<div className="workspace-info-label workspace-info-comments-label">
								<span>
									{comments.length} PR comment{comments.length === 1 ? "" : "s"}
								</span>
								{onAddToInput && (
									<button
										type="button"
										className="workspace-info-fix"
										onClick={() =>
											onAddToInput(formatFixCommentsPrompt(comments, pr!))
										}
										title="Add every comment to the composer as a fix task"
									>
										Fix
									</button>
								)}
							</div>
							<div className="workspace-info-comments">
								{(commentsExpanded
									? comments.slice().reverse()
									: comments.slice(-COMMENT_PREVIEW).reverse()
								).map((c, i) => (
									<CommentCard
										key={c.url || `${c.author}:${i}`}
										comment={c}
										pr={pr!}
										onOpenTab={onOpenTab}
										onAddToInput={onAddToInput}
									/>
								))}
								{comments.length > COMMENT_PREVIEW && (
									<button
										type="button"
										className="workspace-info-more"
										onClick={() => setCommentsExpanded((v) => !v)}
									>
										{commentsExpanded
											? "Show fewer comments"
											: `View all ${comments.length} comments`}
									</button>
								)}
							</div>
						</div>
					)}
					{data?.prompt && (
						<div
							className="workspace-info-section cursor-pointer"
							onClick={() => {
								// Selecting text inside also fires click — don't collapse
								// the prompt out from under a selection.
								if (window.getSelection()?.isCollapsed !== false)
									setPromptExpanded((v) => !v);
							}}
							title={promptExpanded ? "Click to collapse" : "Click to expand"}
						>
							<div className="workspace-info-label">Opening prompt</div>
							<div
								className={`workspace-info-text selectable whitespace-pre-wrap ${
									promptExpanded ? "" : "line-clamp-2"
								}`}
							>
								{data.prompt.content}
							</div>
						</div>
					)}
					{changed.length > 0 && (
						<div className="workspace-info-section">
							<div className="workspace-info-label workspace-info-files-label">
								<span>
									{changed.length} file{changed.length === 1 ? "" : "s"} changed
								</span>
								<span className="diff-file-stats">
									{totalAdd > 0 && <span className="diff-add">+{totalAdd}</span>}
									{totalDel > 0 && <span className="diff-del">−{totalDel}</span>}
								</span>
							</div>
							<div className="workspace-info-files">
								{changed.slice(0, FILE_PREVIEW).map((f) => (
									<FileRow
										key={f.path}
										file={f}
										meta={diffByPath.get(f.path)}
										theme={diffTheme}
										onOpenTab={onOpenTab}
									/>
								))}
								{changed.length > FILE_PREVIEW && (
									<button
										type="button"
										className="workspace-info-more"
										onClick={() => onOpenTab?.("changes")}
									>
										View all {changed.length} files in Changes →
									</button>
								)}
							</div>
						</div>
					)}
					{media.length > 0 && (
						<div className="workspace-info-section">
							<div className="workspace-info-label">
								{media.length} screenshot{media.length === 1 ? "" : "s"}
							</div>
							<div className="workspace-info-media">
								{media.map((m, i) => (
									<button
										key={`${m.sessionId}:${m.at}:${i}`}
										type="button"
										onClick={() => openLightbox(media, i)}
										className="workspace-info-thumb"
										title={[m.chatTitle, new Date(m.at).toLocaleString()]
											.filter(Boolean)
											.join(" · ")}
									>
										{m.kind === "image" ? (
											<img
												src={m.src}
												alt=""
												loading="lazy"
												className="h-full w-full object-cover"
											/>
										) : (
											<>
												<video
													// #t=0.1 makes the browser seek to the first
													// frame and paint it as a poster — without it
													// preload="metadata" leaves the tile blank.
													src={`${m.src}#t=0.1`}
													muted
													playsInline
													preload="metadata"
													className="h-full w-full object-cover"
												/>
												{/* Dark translucent disc so the wedge reads on any
												    frame (a bare white glyph vanishes on light
												    footage). */}
												<span className="pointer-events-none absolute inset-0 grid place-items-center">
													<span className="grid size-8 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
														<IconPlay size={18} />
													</span>
												</span>
											</>
										)}
									</button>
								))}
							</div>
						</div>
					)}
					{assets.length > 0 && (
						<div className="workspace-info-section">
							<div className="workspace-info-label">
								{assets.length} asset{assets.length === 1 ? "" : "s"}
							</div>
							<div className="flex flex-col gap-0.5">
								{assets.map((a) => (
									<button
										key={a.path}
										type="button"
										onClick={() => onOpenAsset?.(a.path)}
										title={`Open ${a.path}`}
										className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] text-fg hover:bg-hover"
									>
										<IconFile size={14} className="shrink-0 text-faint" />
										<span className="min-w-0 flex-1 truncate">
											{a.path}
										</span>
										<span className="shrink-0 text-[11px] text-faint">
											{fmtBytes(a.size)}
										</span>
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="workspace-info-empty">No overview yet.</div>
			)}
		</div>
	);
}

/** Bundle every surfaced PR comment into one "please fix these" composer prompt
    — the Fix button next to the comments heading. Bodies are cleaned to plain
    text and trimmed so the prompt stays readable. */
function formatFixCommentsPrompt(
	comments: Array<{ author: string; body: string; url?: string }>,
	pr: PrDetails,
): string {
	const items = comments
		.map((c, i) => {
			const by = c.author ? ` (${c.author})` : "";
			const link = c.url ? `\n   ${c.url}` : "";
			const body = plainComment(c.body).slice(0, 600);
			return `${i + 1}.${by} ${body}${link}`;
		})
		.join("\n\n");
	return `Please fix the issues raised in these ${comments.length} review comment${
		comments.length === 1 ? "" : "s"
	} on PR #${pr.number} (${pr.title}).\n\n${items}`;
}
