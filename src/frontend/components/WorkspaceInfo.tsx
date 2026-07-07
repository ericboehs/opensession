import React, {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	fetchChannelHistoryApi,
	fetchDiff,
	fetchPr,
	setSessionReviewerApi,
	triggerPrActionApi,
	type PrAgentAction,
	type WorkspaceMediaItem,
	type WorkspaceOverview,
} from "../lib/api";
import { getCurrentUser, TEAM } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { Menu } from "../ui/menu";
import type {
	DiffFile,
	PrDetails,
	SlackChannelLink,
	SlackMessage,
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
import { IconBell, IconCheck, IconClock, IconX } from "./icons";

/**
 * Workspace info block at the top of the right side panel (the "Info" tab): a
 * dense, at-a-glance catch-all — title + meta, a status row (checks, review,
 * PR state), the latest human message from the linked Slack channel, the
 * opening prompt, the summary, and a compact filmstrip of every screenshot /
 * video from the workspace's chats. Opening it answers "what is this and where
 * does it stand" without switching tabs; Changes / Terminal / Checks / Slack
 * are the drill-downs.
 *
 * Loading/caching for the overview lives in lib/workspace-overview (shared with
 * the sidebar's workspace hover card), including the pre-restart transcript
 * fallbacks. PR + Slack are fetched here and refreshed on a slow interval.
 */

type PanelTab = "changes" | "terminal" | "pr" | "slack";

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
	/** Linked Slack channel, when one exists — gates the Slack fetch. */
	slackChannel?: SlackChannelLink | null;
	/** Pending review request on the open chat — the Reviewer chip's state. */
	reviewRequest?: { to: string; by: string; at: string } | null;
	/** Jump to a sibling tab when a status chip / reply row is clicked. */
	onOpenTab?: (tab: PanelTab) => void;
	/** Prefill the composer (the per-comment "Add to chat" hover action). */
	onAddToInput?: (text: string) => void;
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
			label: "Checks running",
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
/** Strip Slack markup (<url|label>, <@U…>, entities) down to plain text. */
function plainSlack(text: string): string {
	return text
		.replace(/<([^|>]+)\|([^>]+)>/g, "$2")
		.replace(/<([^>]+)>/g, "$1")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.trim();
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
function popoverPosition(rect: DOMRect): {
	left: number;
	top: number;
	width: number;
	maxHeight: number;
} {
	const margin = 12;
	const gap = 10;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const maxHeight = Math.min(Math.round(vh * 0.7), 560);
	const spaceLeft = rect.left - margin - gap;

	let width: number;
	let left: number;
	if (spaceLeft >= 300) {
		width = Math.min(440, spaceLeft);
		left = rect.left - gap - width;
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

/** One PR comment rendered as a code-card: an author/time header bar over a
    markdown body, clamped to a few lines. Hovering a clamped card floats the
    full comment in a popover on top (never shifting the list). A hover "Add to
    chat" drops it into the composer; clicking opens the PR tab. */
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
	const bodyRef = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [clamped, setClamped] = useState(false);
	const [pop, setPop] = useState<DOMRect | null>(null);
	const html = useMemo(
		() => renderMarkdown(cleanCommentMarkdown(comment.body)),
		[comment.body],
	);
	useLayoutEffect(() => {
		const el = bodyRef.current;
		if (el) setClamped(el.scrollHeight > el.clientHeight + 2);
	}, [html]);
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
	const head = (
		<div className="workspace-info-comment-head">
			<span className="workspace-info-comment-author">{comment.author}</span>
			{comment.createdAt && (
				<span className="workspace-info-comment-time">
					{relTime(comment.createdAt)}
				</span>
			)}
			{addBtn}
		</div>
	);

	const showPop = pop && clamped;
	const pos = showPop ? popoverPosition(pop) : null;

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
				title="Open the Checks / PR tab"
			>
				{head}
				<div
					ref={bodyRef}
					className={`workspace-info-comment-md ${clamped ? "is-clamped" : ""}`}
				>
					<MarkdownBody html={html} className="markdown" />
				</div>
			</div>
			{showPop &&
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
						{head}
						<div className="workspace-info-comment-pop-body">
							<MarkdownBody html={html} className="markdown" />
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}

/** The GitHub PR agent behaviors, surfaced as one-tap buttons on the info panel.
    Each maps to a michael-* PR label; hitting the button is equivalent to adding
    that label on GitHub (or @mentioning Michael on the PR), but without leaving
    Backstage. tella-fusion PRs only — the agent is repo-scoped. */
const PR_AGENT_ACTIONS: Array<{
	kind: PrAgentAction;
	label: string;
	hint: string;
}> = [
	{
		kind: "review",
		label: "Review",
		hint: "Full review pass (michael-review) — Michael posts findings on the PR",
	},
	{
		kind: "autofix",
		label: "Auto-fix",
		hint: "Fix outstanding findings and push until CI is green (michael-auto-fix)",
	},
	{
		kind: "simplify",
		label: "Simplify",
		hint: "Quality cleanup pass — reuse, simpler shapes, dead code (michael-simplify)",
	},
	{
		kind: "adversarial",
		label: "Adversarial",
		hint: "Deeper two-pass adversarial review (michael-adversarial)",
	},
];

function PrAgentActions({
	sessionId,
	repo,
	prUrl,
}: {
	sessionId: string;
	repo?: string;
	prUrl?: string;
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
			if (res.ok) setDone({ label: action.label, bksId: res.bksId });
			else setError(res.error || res.message || "Couldn't start");
		} catch (e: any) {
			setError(e?.message || "Couldn't start");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="workspace-info-agent mt-3">
			<div className="workspace-info-label">Ask Michael</div>
			<div className="flex flex-wrap gap-1.5">
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
					Started {done.label.toLowerCase()} — Michael will post results on{" "}
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
								href={`/backstage/session/${encodeURIComponent(done.bksId)}`}
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
}: {
	sessionId: string;
	reviewRequest?: { to: string; by: string; at: string } | null;
}) {
	const [req, setReq] = useState(reviewRequest ?? null);
	// Follow the polled session as it refreshes (another viewer may re-assign).
	useEffect(() => {
		setReq(reviewRequest ?? null);
	}, [reviewRequest?.to, reviewRequest?.at]);

	function pick(name: string | null) {
		const prev = req;
		const me = getCurrentUser();
		setReq(name ? { to: name, by: me, at: new Date().toISOString() } : null);
		setSessionReviewerApi(sessionId, name, me).catch(() => setReq(prev));
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				className={`wi-chip ${req ? "wi-chip-yellow" : "wi-chip-muted"}`}
				title={
					req
						? `Review requested by ${req.by}`
						: "Ask a teammate to review this session"
				}
			>
				{req ? (
					<UserAvatar name={req.to} size={20} />
				) : (
					<span className="wi-chip-icon">
						<IconBell size={20} />
					</span>
				)}
				{req ? `Review: ${req.to}` : "Request review"}
			</Menu.Trigger>
			<Menu.Popup align="start" sideOffset={6} className="min-w-[200px]">
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

export function WorkspaceInfo({
	sessionId,
	workspaceId,
	workspaceName,
	chats,
	repo,
	prState,
	slackChannel,
	reviewRequest,
	onOpenTab,
	onAddToInput,
	liveMediaCount,
	liveMedia = [],
}: Props) {
	const chatsKey = chats.map((c) => c.id).join(",");
	const cacheKey = workspaceId || `chats:${chatsKey}`;
	const [data, setData] = useState<WorkspaceOverview | null>(
		() => overviewCache.get(cacheKey)?.data ?? null,
	);
	const [promptExpanded, setPromptExpanded] = useState(false);
	const [pr, setPr] = useState<PrDetails | null>(null);
	const [latestHuman, setLatestHuman] = useState<SlackMessage | null>(null);
	const [files, setFiles] = useState<DiffFile[] | null>(null);

	// The chats array is re-created every App render — read it through a ref so
	// the fetch effect keys on the stable chatsKey instead.
	const chatsRef = useRef(chats);
	chatsRef.current = chats;

	useEffect(() => {
		let alive = true;
		const cached = overviewCache.get(cacheKey);
		setData(cached?.data ?? null);
		setPromptExpanded(false);
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

	// PR (for the status chips) + latest human Slack message — the two live
	// signals the catch-all surfaces. Both are gated so we don't fetch when
	// there's nothing to show, and refreshed on a slow interval while open.
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
				})
				.catch(() => {});
		load();
		const iv = setInterval(load, 45000);
		return () => {
			alive = false;
			clearInterval(iv);
		};
	}, [sessionId, repo, liveMediaCount]);

	useEffect(() => {
		if (!slackChannel) {
			setLatestHuman(null);
			return;
		}
		let alive = true;
		const load = () =>
			fetchChannelHistoryApi(sessionId)
				.then((msgs) => {
					if (!alive) return;
					const human = [...msgs].reverse().find((m) => !m.isBot && m.text.trim());
					setLatestHuman(human ?? null);
				})
				.catch(() => {});
		load();
		const iv = setInterval(load, 45000);
		return () => {
			alive = false;
			clearInterval(iv);
		};
	}, [sessionId, slackChannel?.channelId]);

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

	const hasBody = Boolean(
		chips.length > 0 ||
			latestHuman ||
			comments.length > 0 ||
			changed.length > 0 ||
			(data && (data.prompt || data.lastMessage)) ||
			media.length > 0,
	);

	return (
		<div className="workspace-info-panel">
			<div className="workspace-info-head">
				<div className="workspace-info-title">{title}</div>
				{meta && <div className="workspace-info-meta">{meta}</div>}
				<div className="workspace-info-status">
					{chips.map((chip) => (
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
					))}
					<ReviewerChip sessionId={sessionId} reviewRequest={reviewRequest} />
				</div>
				{pr?.number && repo === "tella-fusion" && (
					<PrAgentActions sessionId={sessionId} repo={repo} prUrl={pr.url} />
				)}
			</div>
			{hasBody ? (
				<div className="workspace-info-body">
					{latestHuman && (
						<button
							type="button"
							className="workspace-info-reply"
							onClick={() => onOpenTab?.("slack")}
							title="Open the Slack tab"
						>
							<span
								className="workspace-info-reply-avatar"
								style={{ background: `hsl(${hueFor(latestHuman.userName)} 55% 45%)` }}
							>
								{initial(latestHuman.userName)}
							</span>
							<span className="workspace-info-reply-body">
								<span className="workspace-info-reply-name">
									{latestHuman.userName}
								</span>
								<span className="workspace-info-reply-text">
									{plainSlack(latestHuman.text)}
								</span>
							</span>
						</button>
					)}
					{comments.length > 0 && (
						<div className="workspace-info-section">
							<div className="workspace-info-label">
								{comments.length} PR comment{comments.length === 1 ? "" : "s"}
							</div>
							<div className="workspace-info-comments">
								{comments
									.slice(-COMMENT_PREVIEW)
									.reverse()
									.map((c, i) => (
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
										onClick={() => onOpenTab?.("pr")}
									>
										View all {comments.length} comments →
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
					{data?.lastMessage && (
						<div className="workspace-info-section">
							<div className="workspace-info-label">Summary</div>
							<div className="workspace-info-text selectable line-clamp-4 whitespace-pre-wrap">
								{data.lastMessage.content}
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
									<button
										key={f.path}
										type="button"
										className="workspace-info-file"
										onClick={() => onOpenTab?.("changes")}
										title={`${f.path} — open in Changes`}
									>
										<span
											className={`diff-status diff-status-${statusClass(f.status)}`}
										>
											{STATUS_CHAR[f.status]}
										</span>
										<span className="workspace-info-file-path">
											{(() => {
												const slash = f.path.lastIndexOf("/");
												const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
												const base = slash >= 0 ? f.path.slice(slash + 1) : f.path;
												return (
													<>
														{dir && (
															<span className="workspace-info-file-dir">{dir}</span>
														)}
														<span className="workspace-info-file-base">{base}</span>
													</>
												);
											})()}
										</span>
										<span className="diff-file-stats">
											{f.additions > 0 && (
												<span className="diff-add">+{f.additions}</span>
											)}
											{f.deletions > 0 && (
												<span className="diff-del">−{f.deletions}</span>
											)}
										</span>
									</button>
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
													src={m.src}
													muted
													playsInline
													preload="metadata"
													className="h-full w-full object-cover"
												/>
												<span className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white drop-shadow">
													▶
												</span>
											</>
										)}
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
