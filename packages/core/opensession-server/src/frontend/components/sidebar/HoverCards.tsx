import type { WorkspaceOverview } from "../../lib/api";
import { providerFromUrl } from "../../lib/provider";
import { sessionPrMerged } from "../../lib/session-prs";
import { MAX_HOVERCARD_MEDIA, TONE_TEXT, compactNum, hoverState, prTone, prettyReview, useSessionOverview, useWsOverview, wsPrInfo, type WsCardRow } from "../../lib/sidebar-hover";
import { SIDEBAR_STATUS_DOT, SIDEBAR_WS_SNOOZE, SIDEBAR_WS_TICKER } from "../../lib/sidebar-classes";
import { frontingPrSession, mineStatus, pinnedLane, runNeedsAttention } from "../../lib/sidebar-lanes";
import { MINE_STATUS_META, type LaneChoice, type MineStatus } from "../../lib/sidebar-types";
import { formatRemaining, snoozePresets } from "../../lib/snoozes";
import { elapsedSince, fullTime } from "../../lib/time";
import type { UnifiedSession } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { BottomSheet, SheetBody, SheetItem, SheetSeparator } from "../../ui/sheet";
import { openLightbox } from "../MediaLightbox";
import { sessionPrTone } from "../../lib/pr-refs";
import { CardFooter, CardPrChip, checksLabel, osReviewLabel } from "../SidebarRowCards";
import { IconArchive, IconArrowUpRight, IconGitMerge, IconInbox, IconLink, IconMail, IconMoon, IconPencil, IconPin, IconPullRequest } from "../icons";
import React, { useEffect, useState } from "react";

// The session card, in the shape the workspace card already proved: what the
// session is, where it stands, what it last said, and the stills it produced.
// Model, mode, branch and created date used to sit here as rows; they are what
// the session's own Info tab is for, and on a hover card they pushed the one
// thing worth reading (the latest message) off the bottom. What survives as a
// row is what changes what you do next: who is behind it, a Linear issue, an
// autonomous goal or loop, and the PR's review and checks.
export function SessionCardBody({ session: s }: { session: UnifiedSession }) {
	const state = hoverState(s);
	const ov = useSessionOverview(s);
	const rows: Array<[string, React.ReactNode]> = [];

	const owner = s.automation || s.startedBy;
	if (owner) rows.push([s.automation ? "Automation" : "Started by", owner]);

	if (s.linearIssue)
		rows.push([
			"Linear",
			<span>
				<span className="text-[0.95em]">{s.linearIssue.identifier}</span>{" "}
				{s.linearIssue.title}
			</span>,
		]);
	if (s.goal) rows.push(["Goal", "Autonomous goal session"]);
	if (s.loop)
		rows.push(["Loop", `Every ${s.loop.intervalMinutes} min`]);

	// The PR facts are worded exactly as the PR row's card words them. The
	// state itself is already the card's status line, so it isn't repeated.
	if (s.prReviewDecision) rows.push(["Review", prettyReview(s.prReviewDecision)]);
	const checks = checksLabel(s.prChecks);
	if (checks) rows.push(["Checks", checks]);

	return (
		<>
			{/* Same head as the workspace card: what changed, not which branch it
			    changed on. The repo used to stand in when there was no diff to
			    show, which spent the card's first line naming the band the row
			    was already filed under. */}
			<div className="flex min-w-0 items-center gap-[7px]">
				<span className={`size-2 shrink-0 rounded-full ${state.dotClass}`} />
				<span className="min-w-0 flex-1 truncate text-meta">
					{s.prAdditions != null && s.prDeletions != null && (
						<>
							<span className="text-green">+{compactNum(s.prAdditions)}</span>{" "}
							<span className="text-red">-{compactNum(s.prDeletions)}</span>
						</>
					)}
				</span>
				{/* What the automated review made of this session's PR, in the same
				    place the workspace card puts it. */}
				{s.prOsReview && (
					<span className="min-w-0 shrink truncate text-right text-meta">
						<span className="text-faint">OS review </span>
						{osReviewLabel(s.prOsReview)}
					</span>
				)}
			</div>

			<div className="mt-[5px] text-label font-semibold leading-[1.3]">{s.title}</div>

			<div className={`mt-[3px] text-meta font-medium ${TONE_TEXT[state.tone]}`}>
				{state.label}
			</div>

			{s.waitingForInput && (
				<div className="mt-[7px] rounded-md bg-accent-soft px-2 py-[5px] text-meta text-dim">
					Blocked on a question. Open the session to answer.
				</div>
			)}
			{!s.waitingForInput && runNeedsAttention(s) && (
				<div className="mt-[7px] rounded-md bg-accent-soft px-2 py-[5px] text-meta text-dim">
					Run failed: {s.lastRunError!.message.slice(0, 200)}
				</div>
			)}
			{!s.waitingForInput && (s.queuedCount ?? 0) > 0 && (
				<div className="mt-[7px] rounded-md bg-accent-soft px-2 py-[5px] text-meta text-dim">
					{s.queuedCount} prompt{s.queuedCount === 1 ? "" : "s"} queued.
				</div>
			)}

			<CardOverview ov={ov} />

			{rows.length > 0 && (
				<div className="mt-[9px] flex flex-col gap-[3px]">
					{rows.map(([label, value], i) => (
						<div className="flex gap-2 text-meta leading-[1.35]" key={i}>
							<span className="w-[74px] shrink-0 text-faint">{label}</span>
							<span className="min-w-0 truncate text-dim">{value}</span>
						</div>
					))}
				</div>
			)}

			<CardFooter>
				{s.prUrl && (
					<CardPrChip
						url={s.prUrl}
						number={s.prNumber}
						tone={sessionPrTone(s)}
					/>
				)}
			</CardFooter>
		</>
	);
}

// Leading status mark for a workspace, Conductor-style: live states
// (blocked question, running) keep their animated form, then the PR lifecycle
// gets an icon — open PR (green, faint while still a draft) or merged
// (purple). Backlog rows get a quiet gray idle dot. Shared by
// the sidebar row and the hover card head so they always read the same.
// Live "in progress" ticker: counts up from when the run started, in the
// in-progress color (yellow). Ticks once a second, isolated to this tiny node
// so the whole sidebar doesn't re-render every second. `startMs` is the earliest
// running session's start (see runStartMs) — the workspace's been busy for that long.
export function RunTicker({ startMs }: { startMs: number }) {
	const [now, setNow] = useState(() => Date.now());
	// Seconds only show in the first minute, so that is the only minute worth
	// ticking at 1Hz — after it, the label can only change once a minute.
	const fine = now - startMs < 60_000;
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), fine ? 1000 : 15_000);
		return () => clearInterval(t);
	}, [fine]);
	return (
		<span className={SIDEBAR_WS_TICKER} title="How long this run has been working">
			{elapsedSince(startMs, now)}
		</span>
	);
}

// Countdown badge for a snoozed row: time until it wakes ("57m", "14h").
// Isolated 30s ticker (RunTicker-style) so the sidebar doesn't re-render
// for the countdown.
export function SnoozeBadge({
	until,
	className,
}: {
	until: string;
	/** The row hands this the left margin: the badge pins itself to the right
	    edge, unless a ticker ahead of it already did that pushing. */
	className?: string;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(t);
	}, []);
	return (
		<span
			className={cn(SIDEBAR_WS_SNOOZE, className)}
			title={`Snoozed until ${new Date(until).toLocaleString()}`}
		>
			<IconMoon size={20} />
			{formatRemaining(until, now)}
		</span>
	);
}

export function WsPrStatusMark({
	sessions,
	size,
	workspace,
}: {
	sessions: UnifiedSession[];
	size: number;
	workspace?: {
		branch?: string | null;
		prNumber?: number;
		draft?: { text: string } | null;
	} | null;
}) {
	const session = frontingPrSession(sessions);
	if (!session) {
		// Rows that can never have a PR — feed/scratch workspaces (repo-less
		// sessions, no workspace branch/PR) — get an empty alignment slot, not a
		// misleading git glyph. A draft workspace (no session at all yet) gets
		// the same pencil the row's own unsent-draft mark uses elsewhere.
		const canPr =
			sessions.some((c) => c.branch || c.prUrl || c.repo) ||
			!!workspace?.branch ||
			workspace?.prNumber !== undefined;
		if (!canPr) {
			if (workspace?.draft)
				return (
					<span className="flex items-center" title="Draft">
						<IconPencil size={size} className="text-faint" />
					</span>
				);
			return (
				<span
					className="flex shrink-0 items-center justify-center"
					style={{ width: size, height: size }}
				/>
			);
		}
		return (
			<span className="flex items-center" title="No pull request">
				<IconPullRequest size={size} className="text-faint" />
			</span>
		);
	}
	if (session.prState === "MERGED") {
		return (
			<span className="flex items-center" title="PR merged">
				<IconPullRequest size={size} className="text-purple" />
			</span>
		);
	}
	const failed = (session.prChecks?.failed || 0) > 0;
	const pending = (session.prChecks?.pending || 0) > 0;
	const changesRequested = session.prReviewDecision === "CHANGES_REQUESTED";
	const className =
		session.prState === "CLOSED" || failed || changesRequested
			? "text-red"
			: pending
				? "text-yellow"
				: session.prIsDraft
					? "text-faint"
					: "text-green";
	const label =
		session.prState === "CLOSED"
			? "PR closed"
			: changesRequested
				? "PR changes requested"
				: failed
					? "PR checks failing"
					: pending
						? "PR checks running"
						: session.prIsDraft
							? "Draft PR"
							: session.prReviewDecision === "APPROVED"
								? "PR approved"
								: "PR open";
	return (
		<span className="flex items-center" title={label}>
			<IconPullRequest size={size} className={className} />
		</span>
	);
}

export function WsStatusMark({
	row,
	size = 20,
}: {
	row: {
		status: MineStatus;
		running: boolean;
		sessions: UnifiedSession[];
		workspace?: { draft?: { text: string } | null } | null;
	};
	size?: number;
}) {
	// Every mark rides in the same `size`-wide (20px) flex slot so #number/title
	// line up at one x whichever mark the row carries. It also gives the icons a
	// real CSS box: an SVG sized only by its width/height *attributes* collapses
	// to a 0 flex-basis in iOS Safari and paints on top of the title — the slot's
	// inline-styled span dodges that (the dots were always immune for this reason).
	const slot = (child: React.ReactNode) => (
		<span
			className="flex shrink-0 items-center justify-center"
			style={{ width: size, height: size }}
		>
			{child}
		</span>
	);
	const dot = (cls: string) =>
		slot(<span className={`size-2 shrink-0 rounded-full ${cls}`} />);
	if (row.status === "needsinput") return dot(SIDEBAR_STATUS_DOT.waiting);
	if (row.running) return dot(SIDEBAR_STATUS_DOT.running);
	// A draft workspace has no session and so no PR to show. The flat-repo
	// grouping's mark stands in for WsPrStatusMark's own draft branch above.
	if (row.workspace?.draft && row.sessions.length === 0)
		return (
			<span className="flex items-center" title="Draft">
				<IconPencil size={size} className="text-faint" />
			</span>
		);
	if (row.status === "review") {
		const open = row.sessions.filter((c) => c.prState === "OPEN");
		const allDraft = open.length > 0 && open.every((c) => c.prIsDraft);
		return slot(
			<IconPullRequest
				size={size}
				className={allDraft ? "text-faint" : "text-green"}
			/>,
		);
	}
	if (row.status === "merged")
		return slot(<IconGitMerge size={size} className="text-purple" />);
	// A landed PR files its idle row under Done (prLaneForSessions), but a
	// human-pinned lane wins, so a row parked in Backlog stays there after its
	// PR merges. Its mark should carry the PR lifecycle anyway, like the
	// lane-grouped view's WsPrStatusMark does — a grey idle dot on a merged row
	// reads as "no PR".
	const prSession = frontingPrSession(row.sessions);
	if (row.status === "pending" && prSession && sessionPrMerged(prSession))
		return slot(<IconGitMerge size={size} className="text-purple" />);
	return dot(SIDEBAR_STATUS_DOT.idle);
}

/**
 * Where the work stands, in the two things that carry it: the latest message,
 * and the stills the session produced. Shared by the workspace card and the
 * session card, because "what happened here" is the same question of both, and
 * it is the half of the card people actually read.
 */
export function CardOverview({ ov }: { ov: WorkspaceOverview | null }) {
	const desc = (ov?.lastMessage?.content || ov?.prompt?.content || "")
		.replace(/\s+/g, " ")
		.trim();
	const media = ov?.media || [];
	return (
		<>
			{desc && (
				<div className="selectable mt-1 text-xs leading-snug text-dim line-clamp-2">
					{desc}
				</div>
			)}

			{media.length > 0 && (
				// A filmstrip, like the info panel's screenshots: a 62px square
				// crop of a 1440px screenshot is a grey band of text, not a
				// picture of anything. Whole frames, scrolled sideways, and
				// everything is reachable instead of hidden behind a "+3". Bleed
				// through the card's right inset so the carousel peek is clipped
				// at the card edge rather than stopping inside its padding.
				<div className="mt-2 -mr-[13px] flex snap-x snap-mandatory gap-1.5 overflow-x-auto pr-[13px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					{media.slice(0, MAX_HOVERCARD_MEDIA).map((m, i) => (
						<button
							key={`${m.sessionId}:${m.at}:${i}`}
							type="button"
							onClick={() => openLightbox(media, i)}
							className="relative block aspect-video w-[124px] shrink-0 snap-start overflow-hidden rounded-sm border border-line bg-surface p-0"
							title={[m.sessionTitle, fullTime(m.at)]
								.filter(Boolean)
								.join(" · ")}
						>
							{m.kind === "image" ? (
								<img
									src={m.src}
									alt=""
									loading="lazy"
									className="h-full w-full object-contain"
								/>
							) : (
								<>
									<video
										src={m.src}
										muted
										playsInline
										preload="metadata"
										className="h-full w-full object-contain"
									/>
									<span className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white drop-shadow">
										▶
									</span>
								</>
							)}
							{i === MAX_HOVERCARD_MEDIA - 1 &&
								media.length > MAX_HOVERCARD_MEDIA && (
									<span className="absolute inset-0 grid place-items-center bg-black/55 text-xs font-semibold text-white">
										+{media.length - MAX_HOVERCARD_MEDIA + 1}
									</span>
								)}
						</button>
					))}
				</div>
			)}
		</>
	);
}

// The info half of the workspace card: diff + status mark, title,
// blocked-question callout, latest-message description, media thumbnails.
// Rendered inside the hover card (desktop) and the long-press sheet (mobile).
function WsOverviewInfo({
	row,
	ov,
}: {
	row: WsCardRow;
	ov: WorkspaceOverview | null;
}) {
	const { prSession } = wsPrInfo(row);
	const meta = MINE_STATUS_META.find((m) => m.key === row.status);
	return (
		<>
			{/* The PR facts, on one strip above the title: what changed, what the
			    automated review made of it, and where it stands. A generated branch
			    name ("auto-plain-ticket-triage-202608121249") used to hold this
			    line, truncating to answer nothing the title doesn't; so did the
			    repo, which only ever named the band the row is filed under. The
			    verdict reads better here than under the title, where it sat between
			    the name and the description and pushed them apart. */}
			<div className="flex min-w-0 items-center gap-[7px]">
				{/* The diff is two short numbers and never truncates; the verdict is
				    the variable-length half, so it takes the slack and gives it back. */}
				<span className="shrink-0 text-meta">
					{prSession?.prAdditions != null && prSession?.prDeletions != null && (
						<>
							<span className="text-green">
								+{compactNum(prSession.prAdditions)}
							</span>{" "}
							<span className="text-red">
								-{compactNum(prSession.prDeletions)}
							</span>
						</>
					)}
				</span>
				{/* What os-review made of this PR — the question a Ready-to-merge row
				    raises, answered without opening GitHub. */}
				{prSession?.prOsReview && (
					<span className="min-w-0 flex-1 truncate text-right text-meta">
						<span className="text-faint">OS review </span>
						{osReviewLabel(prSession.prOsReview)}
					</span>
				)}
				{/* `ml-auto` only bites when there is no verdict to take the slack. */}
				<span className="ml-auto flex shrink-0 items-center" title={meta?.label}>
					<WsStatusMark row={row} size={22} />
				</span>
			</div>

			<div className="mt-[5px] text-label font-semibold leading-[1.3]">{row.name}</div>

			{row.status === "needsinput" &&
				(row.sessions.some((c) => c.waitingForInput) ? (
					<div className="mt-[7px] rounded-md bg-accent-soft px-2 py-[5px] text-meta text-dim">
						Blocked on a question. Open to answer.
					</div>
				) : (
					<div className="mt-[7px] rounded-md bg-accent-soft px-2 py-[5px] text-meta text-dim">
						Run failed:{" "}
						{row.sessions
							.find((c) => runNeedsAttention(c))
							?.lastRunError?.message.slice(0, 200) || "needs attention"}
					</div>
				))}

			<CardOverview ov={ov} />
		</>
	);
}

// The workspace counterpart of SessionCardBody: diff stats + status
// at a glance, the latest assistant message as a "where things stand" line,
// screenshot thumbnails from the workspace's sessions, and quick actions
// (Archive, PR link) — the only card body that carries controls, which is why
// its shell is the one the pointer can travel into.
export function WsCardBody({
	row,
	onArchive,
	onOpen,
}: {
	row: WsCardRow;
	onArchive: () => void;
	/** Open a session (the "Answer" action jumps to the blocked one). */
	onOpen: (session: UnifiedSession) => void;
}) {
	const ov = useWsOverview(row);
	const { prSession, prReady, prStatusBits } = wsPrInfo(row);

	return (
		<>
			<WsOverviewInfo row={row} ov={ov} />

			<CardFooter>
				{/* The single main action, colored by what the workspace needs next:
				    answer the blocked question (accent), merge the ready PR (green),
				    review the not-ready PR (neutral), or archive merged work (purple). */}
				{row.status === "needsinput" && row.sessions.length > 0 ? (
					<Button
						size="sm"
						variant="primary"
						onClick={() =>
							onOpen(
								row.sessions.find((c) => c.waitingForInput) ||
									row.sessions.find((c) => runNeedsAttention(c)) ||
									row.sessions[0],
							)
						}
					>
						{row.sessions.some((c) => c.waitingForInput) ? "Answer" : "Open"}
					</Button>
				) : row.status === "merged" ? (
					// Purple is the merged tone across every PR surface, and this is
					// the action that closes merged work, so it takes the solid
					// plate's shape with that fill. It is a className rather than a
					// variant because the variants are semantic (danger, success)
					// and "merged" is a fact about a PR, not about a button.
					<Button
						size="sm"
						variant="primary"
						className="bg-purple text-white hover:bg-purple/90"
						icon={<IconArchive size={20} />}
						onClick={onArchive}
					>
						Archive
					</Button>
				) : row.status === "review" && prSession?.prUrl ? (
					<Button
						size="sm"
						variant={prReady ? "success-strong" : "soft"}
						trailing={<IconArrowUpRight size={15} className="opacity-80" />}
						render={
							<a
								href={prSession.prUrl}
								target="_blank"
								rel="noopener noreferrer"
							/>
						}
					>
						{prReady ? "Merge" : "Review"}
					</Button>
				) : null}
				{prSession?.prUrl && (
					<CardPrChip
						url={prSession.prUrl}
						number={prSession.prNumber}
						tone={sessionPrTone(prSession)}
					/>
				)}
				{prStatusBits.length > 0 && (
					<span className="min-w-0 truncate text-meta text-faint">
						{prStatusBits.join(" · ")}
					</span>
				)}
			</CardFooter>
		</>
	);
}

// The touch counterpart of the workspace card: long-pressing a row raises
// a bottom sheet with the same overview block (diff + status, title,
// latest message, thumbnails) followed by thumb-sized action rows — the
// status-colored main action first (answer / merge / review / archive), then
// the workspace chores that live behind right-click on desktop (pin, rename,
// color, archive, delete). Replaces the old long-press → context-menu path.
export function WsMobileSheet({
	row,
	pinned,
	onTogglePin,
	onClose,
	onArchive,
	onSetStatus,
	snoozeUntil,
	onSnooze,
	onOpen,
	onRename,
	unread,
	claimed,
	onToggleRead,
	onCopyLink,
	onDelete,
}: {
	row: WsCardRow;
	pinned: boolean;
	onTogglePin: () => void;
	onClose: () => void;
	onArchive: () => void;
	/** Pin the workspace into a lane, or clear back to derived with `null`. */
	onSetStatus: (status: LaneChoice | null) => void;
	/** Active snooze expiry (ISO), or null when not snoozed. */
	snoozeUntil: string | null;
	/** Snooze until the given ISO time, or unsnooze with `null`. */
	onSnooze: (until: string | null) => void;
	onOpen: (session: UnifiedSession) => void;
	onRename: () => void;
	/** Whether the row has unread activity — picks the read/unread direction. */
	unread: boolean;
	/** In your lanes already (true), claimable (false), or your own row with
	    nothing to claim (null — the action is hidden). */
	claimed: boolean | null;
	/** Flip every session in the row read or unread; null for sessionless rows. */
	onToggleRead: (() => void) | null;
	/** Copy a link to the row's first session; null for sessionless rows. */
	onCopyLink: (() => void) | null;
	onDelete: (() => void) | null;
}) {
	const ov = useWsOverview(row);
	const { prSession, prReady, prStatusBits } = wsPrInfo(row);
	// Lock the page behind the sheet so a scroll drags the list, not the page.
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);
	const archiveGlyph = (
		<svg
			width="20"
			height="20"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.4"
		>
			<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
			<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
			<path d="M6.5 8.5h3" strokeLinecap="round" />
		</svg>
	);
	return (
		<BottomSheet label={`Actions for ${row.name}`} onClose={onClose}>
			{(dismiss) => {
				const closing = (fn: () => void) => () => {
					fn();
					dismiss();
				};
				return (
				<SheetBody>
				<div className="px-2 pb-2.5 pt-1">
					<WsOverviewInfo row={row} ov={ov} />
					{prStatusBits.length > 0 && (
						<div className="mt-2 flex min-w-0 items-center gap-2 text-meta text-faint">
							{prSession?.prNumber != null && (
								<span
									className={`shrink-0 text-[0.95em] font-semibold ${prTone(prSession)}`}
								>
									#{prSession.prNumber}
								</span>
							)}
							<span className="min-w-0 truncate">
								{prStatusBits.join(" · ")}
							</span>
						</div>
					)}
				</div>
				<SheetSeparator />
				{/* Main action, colored by what the workspace needs next. */}
				{row.status === "needsinput" && row.sessions.length > 0 && (
					<SheetItem
						tone="accent"
						onClick={closing(() =>
							onOpen(
								row.sessions.find((c) => c.waitingForInput) ||
									row.sessions.find((c) => runNeedsAttention(c)) ||
									row.sessions[0],
							),
						)}
					>
						<WsStatusMark row={row} size={22} />
						{row.sessions.some((c) => c.waitingForInput)
							? "Answer question"
							: "Check failed run"}
					</SheetItem>
				)}
				{row.status === "review" && prSession?.prUrl && (
					<SheetItem
						tone={prReady ? "green" : "default"}
						onClick={closing(() =>
							window.open(prSession.prUrl, "_blank", "noopener"),
						)}
					>
						<IconPullRequest size={22} />
						{prReady ? `Merge on ${providerFromUrl(prSession.prUrl).name}` : "Review PR"}
						{prSession.prNumber != null && ` #${prSession.prNumber}`}
					</SheetItem>
				)}
				{row.status === "merged" && row.sessions.length > 0 && (
					<SheetItem tone="purple" onClick={closing(onArchive)}>
						{archiveGlyph}
						Archive workspace
					</SheetItem>
				)}
				{prSession?.prUrl && row.status !== "review" && (
					<SheetItem
						onClick={closing(() =>
							window.open(prSession.prUrl, "_blank", "noopener"),
						)}
					>
						<IconPullRequest size={22} />
						Open PR{prSession.prNumber != null ? ` #${prSession.prNumber}` : ""}
					</SheetItem>
				)}
				{claimed !== null && (
					<SheetItem
						onClick={closing(() => onSetStatus(claimed ? null : "mine"))}
					>
						<IconInbox size={22} />
						{claimed
							? "Remove from my workspaces"
							: "Add to my workspaces"}
					</SheetItem>
				)}
				{onToggleRead && (
					<SheetItem onClick={closing(onToggleRead)}>
						<IconMail size={22} />
						{unread ? "Mark as read" : "Mark as unread"}
					</SheetItem>
				)}
				<SheetItem onClick={closing(onTogglePin)}>
					<IconPin size={22} fill={pinned ? "currentColor" : "none"} />
					{pinned ? "Unpin" : "Pin"}
				</SheetItem>
				<SheetItem onClick={closing(onRename)}>
					<svg
						width="20"
						height="20"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" />
					</svg>
					Rename
				</SheetItem>
				{onCopyLink && (
					<SheetItem onClick={closing(onCopyLink)}>
						<IconLink size={22} />
						Copy link
					</SheetItem>
				)}
				{/* Pin the workspace into a lane manually — tap a chip to move it there
				    (tap the active one, or Auto, to release it back to the derived lane). */}
				{row.sessions.length > 0 &&
					(() => {
						const anyManual = row.sessions.some((c) => pinnedLane(c));
						const sharedManual =
							anyManual &&
							row.sessions.every(
								(c) => pinnedLane(c) === pinnedLane(row.sessions[0]),
							)
								? (pinnedLane(row.sessions[0]) ?? null)
								: null;
						return (
							<div className="px-4 py-2">
								<div className="mb-1.5 text-meta font-semibold text-faint">
									Move to lane
								</div>
								<div className="flex flex-wrap gap-1.5">
									{MINE_STATUS_META.map((m) => {
										const on = sharedManual === m.key;
										return (
											<Button
										variant="ghost"
										size="sm"
												key={m.key}
												type="button"
												className="gap-1.5 whitespace-normal px-2 text-control-label leading-normal"
												style={{
													borderColor: on ? m.dotColor : "var(--border)",
													color: on ? "var(--text)" : "var(--text-dim)",
													background: on
														? "color-mix(in srgb, var(--bg-panel), transparent)"
														: "transparent",
												}}
												onClick={closing(() =>
													onSetStatus(on ? null : m.key),
												)}
											>
												<span
													style={{
														width: 8,
														height: 8,
														borderRadius: "50%",
														background: m.dotColor,
														flexShrink: 0,
													}}
												/>
												{m.label}
											</Button>
										);
									})}
									<Button
										variant="ghost"
										size="sm"
										type="button"
										className="whitespace-normal px-2 text-control-label leading-normal"
										style={{
											borderColor: !anyManual
												? "var(--text-dim)"
												: "var(--border)",
											color: !anyManual ? "var(--text)" : "var(--text-dim)",
										}}
										onClick={closing(() => onSetStatus(null))}
									>
										Auto
									</Button>
								</div>
							</div>
						);
					})()}
				{/* Snooze chips — the mobile stand-in for the right-click Snooze
				    flyout. Tapping a preset parks the row in the Snoozed section
				    until the resolved time. */}
				{row.sessions.length > 0 && (
					<div className="px-4 py-2">
						<div className="mb-1.5 text-meta font-semibold text-faint">
							{snoozeUntil
								? `Snoozed · wakes in ${formatRemaining(snoozeUntil)}`
								: "Snooze"}
						</div>
						<div className="flex flex-wrap gap-1.5">
							{snoozePresets().map((p) => (
								<Button
										variant="ghost"
										size="sm"
									key={p.label}
									type="button"
									className="whitespace-normal px-2 text-control-label leading-normal"
									style={{
										borderColor: "var(--border)",
										color: "var(--text-dim)",
									}}
									onClick={closing(() => onSnooze(p.until.toISOString()))}
								>
									{p.label}
								</Button>
							))}
							{snoozeUntil && (
								<Button
										variant="ghost"
										size="sm"
									type="button"
									className="whitespace-normal px-2 text-control-label leading-normal"
									style={{
										borderColor: "var(--text-dim)",
										color: "var(--text)",
									}}
									onClick={closing(() => onSnooze(null))}
								>
									Unsnooze
								</Button>
							)}
						</div>
					</div>
				)}
				{((row.status !== "merged" && row.sessions.length > 0) || onDelete) && (
					<SheetSeparator />
				)}
				{/* Archiving stays reachable pre-merge from the explicit menu — the
				    status coloring only governs which action gets top billing. */}
				{row.status !== "merged" && row.sessions.length > 0 && (
					<SheetItem tone="danger" onClick={closing(onArchive)}>
						{archiveGlyph}
						Archive
					</SheetItem>
				)}
				{onDelete && (
					<SheetItem tone="danger" onClick={closing(onDelete)}>
						<svg
							width="20"
							height="20"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
						>
							<path d="M3 4.5h10M6.5 4.5V3.25a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1V4.5M4.25 4.5l.6 8.25a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.25" />
						</svg>
						{row.workspace?.draft && row.sessions.length === 0
							? "Delete draft"
							: "Delete workspace"}
					</SheetItem>
				)}
				</SheetBody>
				);
			}}
		</BottomSheet>
	);
}
