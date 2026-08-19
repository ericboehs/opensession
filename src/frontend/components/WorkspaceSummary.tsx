import { useCallback, useEffect, useRef, useState } from "react";
import {
	fetchGitStatus,
	fetchPr,
	fetchSessionAssets,
	setSessionReviewerApi,
	sessionAssetPreviewUrl,
	type SessionAssetFile,
} from "../lib/api";
import { fetchDiff } from "../lib/api";
import { commitPrompt } from "../lib/commit-prompt";
import { getCurrentUser } from "./UserPicker";
import { pollWhileVisible, PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { PrStatusBar } from "./PrStatusBar";
import { reviewerStateMeta } from "./pr/PrRows";
import { UserAvatar } from "./UserAvatar";
import {
	personNameForGithubLogin,
	personNameForKey,
	usePeople,
	useReviewTeams,
} from "../lib/people";
import { isBotAuthor } from "../lib/pr-comments";
import { Popover } from "../ui/popover";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../ui/cn";
import type {
	GitStatusInfo,
	PrDetails,
	PrReviewer,
	UnifiedSession,
} from "../lib/types";
import {
	WS_SUMMARY_ACTION,
	WS_SUMMARY_CARD,
	WS_SUMMARY_COUNT,
	WS_SUMMARY_DIVIDER,
	WS_SUMMARY_ICON,
	WS_SUMMARY_LABEL,
	WS_SUMMARY_RAIL,
	WS_SUMMARY_ROW,
	WS_SUMMARY_SECTION,
	WS_SUMMARY_STATE,
	WS_SUMMARY_THUMB,
} from "../lib/workspace-summary-classes";
import {
	IconChevronDown,
	IconClock,
	IconFile,
	IconListCircles,
	IconPeople,
	IconStack,
} from "./icons";

/**
 * The session header's compact stand-in for the right Workspace panel: one
 * floating card carrying what that panel carries, in three bands.
 *
 * 1. The work itself, unlabelled: how big the diff is, whether anything is
 *    uncommitted, and where the pull request stands with its one action.
 * 2. Places, which is the panel's bottom bar: portals, agents, terminal.
 * 3. Assets, the session's own files.
 *
 * Why it exists: the Workspace panel is a third of the pane, so the only way
 * to check "did the checks pass / is there a conflict / is anything still
 * running" was to give up that much of the transcript. The header already
 * carries a one-line PR strip, but a single headline cannot say more than one
 * thing at a time. This is the rest of that headline, on demand, over the
 * pane's own gutter, so both side columns can stay shut and the reading column
 * stays wide.
 *
 * What it deliberately does NOT hold: the repo and the branch. They were the
 * two rows that never changed while you worked, and a summary is for what
 * moves. Both are on the session header a few pixels above, and the branch is
 * in the panel's Info section.
 *
 * The PR block is `PrStatusBar` in its `summary` variant rather than rows of
 * this file's own. Everything behind a merge button (headline derivation, the
 * stack merge plan, confirm-then-merge, the ask-the-session paths) belongs to
 * that component, and re-deriving it here would be a second thing that can be
 * wrong about whether a merge is in flight. It replaced hand-written checks,
 * conflict, ahead and behind rows that could report a state without being able
 * to do anything about it.
 *
 * Data is fetched only while the card is open, which is what keeps the polls
 * off every session that merely has the header. What is left to fetch here is
 * small: the PR's own line stats feed the diff row, because that number rides
 * along with the PR fetch where a worktree diff would be a second, much
 * heavier request for the same two integers. With no PR (or no branch yet) it
 * falls back to the worktree diff.
 */

interface Props {
	session: UnifiedSession;
	/**
	 * What the card aligns its right edge to: the header's actions row, not the
	 * trigger. Anchoring to the trigger left it hanging off the middle of the
	 * cluster with the panel toggle poking out beside it; against the row it
	 * lands flush with the chrome's own right edge, which is where a summary of
	 * the right-hand panel belongs.
	 */
	anchor?: React.RefObject<HTMLElement | null>;
	/** Open the right panel on a page. */
	onOpenPanelTab: (tab: "info" | "changes") => void;
	/** Open the Review tab (PR + its checks). */
	onOpenPr: () => void;
	onOpenChecks: () => void;
	/** Open the Assets tab (the Assets list's destination). */
	onOpenAssets?: () => void;
	/** Archive through the owning viewer, so it can select the neighbouring
	 *  sidebar row. Offered by the PR block once the work has landed. */
	onArchive?: () => void;
	/**
	 * The teammate this session's review was handed to, if anyone. Open
	 * Session's own request, which is a different thing from the reviewers on
	 * the pull request: this one is a person somebody here asked, and it is the
	 * only one of the two that can be pending with no PR in sight.
	 *
	 * The workspace's request may live on a sibling session, so the viewer
	 * resolves it (see `effectiveReview`) and hands the answer down.
	 */
	reviewRequest?: UnifiedSession["reviewRequest"] | null;
	/** Workspace-wide GitHub requests, including requests held by a sibling session. */
	prReviewRequested?: string[];
	/** Live run state, so the PR block refetches the moment a turn ends. */
	running?: boolean;
	/** Prompt the session (Commit) via WS `prompt`. Absent while disconnected. */
	send?: (msg: any) => void;
	/** Bumped when a webhook or an auto-push reports workspace activity. */
	refreshTick?: number;
	/** Lets the session column make room for the floating card while it is open. */
	onOpenChange?: (open: boolean) => void;
	/** The desktop tab strip sits between the header anchor and the transcript. */
	tabStripVisible?: boolean;
}

type SummaryData = {
	pr: PrDetails | null;
	git: GitStatusInfo | null;
	assets: SessionAssetFile[];
	/** Worktree line stats, only fetched when there is no PR to read them from. */
	diff: { additions: number; deletions: number; files: number } | null;
};

/** Last-known state per session, so re-opening the card paints instantly and
 *  revalidates behind the previous answer instead of flashing a skeleton.
 *  Module-level: survives the popup unmounting, dies with the page. */
const lastKnown = new Map<string, SummaryData>();

function emptyData(): SummaryData {
	return { pr: null, git: null, assets: [], diff: null };
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const OPEN_KEY = "opensession-workspace-summary-open";

/**
 * One identity per reviewer, merged across the two ways a review lands on
 * someone. Human identities are collected under one labelled band; bots and
 * teams keep their own status rows.
 *
 * The pull request has reviewers, and Open Session has its own "please review
 * this" pointed at a teammate. They are not alternatives: the picker mirrors
 * its picks into GitHub's reviewer list, so the same person arrives from both
 * sides, once as a login and once as a name. Rendered as two lists that reads
 * as "johnnylinsf · Awaiting review" directly above "Johnny · Review asked",
 * which is one person, one fact, and two rows saying it differently.
 *
 * So: one row per person. GitHub's state wins when they have actually
 * submitted something, because "Approved" says more than "we asked"; the
 * request supplies the state otherwise, and the name, which is what a
 * teammate is called here.
 *
 * GitHub also lists a person twice when they answer a request they were
 * already on, so the latest state wins per login before any of this.
 */
const REVIEWERS_SHOWN = 4;

type ReviewLine = {
	key: string;
	name: string;
	login?: string;
	state: string;
	tone: string;
	human: boolean;
};

function reviewLines(
	pr: PrDetails | null,
	request: UnifiedSession["reviewRequest"] | null | undefined,
	prReviewRequested: string[] | undefined,
): ReviewLine[] {
	const lines: ReviewLine[] = [];
	const seen = new Map<string, ReviewLine>();
	const add = (line: ReviewLine) => {
		const existing = seen.get(line.key);
		if (existing) return existing;
		seen.set(line.key, line);
		lines.push(line);
		return line;
	};

	// Whoever we asked, first: this is the row that exists even with no pull
	// request open at all.
	const requestedPeople = request?.recipients?.length
		? request.recipients
		: [request?.to];
	for (const key of requestedPeople) {
		if (!key) continue;
		const name = personNameForKey(key);
		add({
			key: name.toLowerCase(),
			name,
			state: request?.accepted ? "Signed off" : "Review asked",
			tone: request?.accepted ? "text-green" : "text-dim",
			human: true,
		});
	}
	for (const key of prReviewRequested || []) {
		if (!key) continue;
		const name = personNameForKey(key);
		add({
			key: name.toLowerCase(),
			name,
			state: "Awaiting review",
			tone: "text-dim",
			human: true,
		});
	}

	// Then the PR's own, folded onto the same person where they match. Only
	// while it is open: once it lands the review is history, and the card is for
	// what is still live.
	if (pr?.state === "OPEN") {
		const byLogin = new Map<string, PrReviewer>();
		for (const reviewer of pr.reviewers || []) {
			const previous = byLogin.get(reviewer.login);
			if (!previous || previous.state === "PENDING")
				byLogin.set(reviewer.login, reviewer);
		}
		for (const reviewer of byLogin.values()) {
			const meta = reviewerStateMeta(reviewer.state);
			const personName = reviewer.isTeam
				? null
				: personNameForGithubLogin(reviewer.login);
			const name = personName || reviewer.login;
			const line = add({
				key: name.toLowerCase(),
				name,
				login: reviewer.isTeam ? undefined : reviewer.login,
				state: meta.label,
				tone: meta.tone === "muted" ? "text-dim" : `text-${meta.tone}`,
				human: !reviewer.isTeam && !isBotAuthor(reviewer.login),
			});
			// Merged onto a request row: keep the request's name, take GitHub's
			// verdict once there is one to take.
			if (line.state !== meta.label && reviewer.state !== "PENDING") {
				line.state = meta.label;
				line.tone = meta.tone === "muted" ? "text-dim" : `text-${meta.tone}`;
				line.login = line.login || reviewer.login;
			}
			line.human ||= !reviewer.isTeam && !isBotAuthor(reviewer.login);
		}
	}
	return lines;
}

/** How many assets the card lists before it defers to the Assets tab. The card
 *  scrolls, so this is about the list staying a summary rather than about the
 *  height it would take. */
const ASSETS_SHOWN = 6;

export function WorkspaceSummary({
	session,
	anchor,
	onOpenChange,
	tabStripVisible,
	...body
}: Props) {
	const [open, setOpen] = useState(
		() => localStorage.getItem(OPEN_KEY) === "true",
	);
	const initialOpen = useRef(open);
	useEffect(() => {
		onOpenChange?.(initialOpen.current);
		return () => onOpenChange?.(false);
	}, [onOpenChange]);
	function changeOpen(nextOpen: boolean) {
		setOpen(nextOpen);
		localStorage.setItem(OPEN_KEY, String(nextOpen));
		onOpenChange?.(nextOpen);
	}
	return (
		<Popover.Root open={open} onOpenChange={changeOpen}>
			<Tooltip label="Workspace summary">
				<Popover.Trigger
					className={cn(
						"inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control",
						"border-none bg-transparent p-0 text-dim hover:bg-hover hover:text-fg",
						// Open state reads as pressed rather than hovered, so the card
						// and its trigger stay visibly one object.
						"data-[popup-open]:bg-pressed data-[popup-open]:text-fg",
					)}
					aria-label="Workspace summary"
				>
					<IconListCircles size={20} />
				</Popover.Trigger>
			</Tooltip>
			<Popover.Popup
				side="bottom"
				align="end"
				anchor={anchor}
				// Keep the usual 8px air below whichever chrome row is lowest. The
				// desktop tab strip is 40px tall and sits after the header's own 8px
				// inset, so clear both before adding 16px of breathing room.
				sideOffset={tabStripVisible ? 64 : 8}
				elevation="lg"
				className={WS_SUMMARY_CARD}
				initialFocus
			>
				{/* Mounted only while open — that is what keeps the fetches off every
				    session that merely has the header. */}
				<SummaryBody
					session={session}
					{...body}
					close={() => changeOpen(false)}
				/>
			</Popover.Popup>
		</Popover.Root>
	);
}

function SummaryBody({
	session,
	onOpenPanelTab,
	onOpenPr,
	onOpenChecks,
	onOpenAssets,
	onArchive,
	reviewRequest,
	prReviewRequested,
	running,
	send,
	refreshTick,
	close,
}: Omit<Props, "anchor" | "onOpenChange" | "tabStripVisible"> & {
	close: () => void;
}) {
	const activeSessionId = useRef(session.id);
	activeSessionId.current = session.id;
	const [data, setData] = useState<SummaryData>(
		() => lastKnown.get(session.id) ?? emptyData(),
	);
	const [prompted, setPrompted] = useState(false);
	const [selectedReview, setSelectedReview] = useState(reviewRequest ?? null);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [reviewBusy, setReviewBusy] = useState(false);
	const updateData = useCallback(
		(patch: Partial<SummaryData>) => {
			if (activeSessionId.current !== session.id) return;
			setData((current) => {
				const next = { ...current, ...patch };
				lastKnown.set(session.id, next);
				return next;
			});
		},
		[session.id],
	);

	const load = useCallback(async () => {
		// Each answer paints as it lands rather than waiting for the slowest of
		// the three, which is what makes a cold card fill in rather than appear.
		const prTask = fetchPr(session.id, session.repo || undefined)
			.catch(() => null)
			.then((nextPr) => {
				updateData({ pr: nextPr, ...(nextPr ? { diff: null } : {}) });
				return nextPr;
			});
		const gitTask = fetchGitStatus(session.id, session.repo || undefined)
			.catch(() => null)
			.then((nextGit) => updateData({ git: nextGit }));
		const assetsTask = fetchSessionAssets(session.id)
			.then((response) => response.files)
			.catch(() => [] as SessionAssetFile[])
			.then((nextAssets) => updateData({ assets: nextAssets }));
		const [nextPr] = await Promise.all([prTask, gitTask, assetsTask]);
		if (activeSessionId.current !== session.id) return;
		// Only pay for the worktree patch when the PR cannot answer the same
		// question.
		if (nextPr) return;
		const patch = await fetchDiff(session.id).catch(() => null);
		const diff = patch?.repos
			? patch.repos.reduce(
					(sum, repo) => ({
						additions: sum.additions + (repo.diff.totalAdditions || 0),
						deletions: sum.deletions + (repo.diff.totalDeletions || 0),
						files: sum.files + (repo.diff.files?.length || 0),
					}),
					{ additions: 0, deletions: 0, files: 0 },
				)
			: null;
		updateData({ diff });
	}, [session.id, session.repo, updateData]);

	useEffect(() => {
		setData(lastKnown.get(session.id) ?? emptyData());
		load();
		return pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
	}, [load, session.id]);
	useEffect(() => {
		if (refreshTick) load();
	}, [refreshTick, load]);
	useEffect(() => {
		setSelectedReview(reviewRequest ?? null);
		setReviewError(null);
	}, [reviewRequest?.to, reviewRequest?.at, reviewRequest?.accepted?.at]);

	const { pr, git, assets, diff } = data;
	const additions = pr ? pr.additions : (diff?.additions ?? 0);
	const deletions = pr ? pr.deletions : (diff?.deletions ?? 0);
	const changedFiles = pr ? pr.changedFiles : (diff?.files ?? 0);
	const dirty = git?.uncommittedFiles ?? 0;

	/** Route somewhere else and get out of the way. A card that stayed open
	 *  over the thing it just opened would have to be dismissed by hand. */
	function go(open?: () => void) {
		close();
		open?.();
	}

	function askCommit() {
		if (!send) return;
		send({
			type: "prompt",
			sessionId: session.id,
			user: getCurrentUser(),
			content: commitPrompt(dirty, git?.sharedCheckout, git?.uncommittedPaths),
		});
		setPrompted(true);
		setTimeout(() => setPrompted(false), 4000);
	}

	// The roster arrives async and the name lookup below reads it, so subscribe
	// here or a reviewer stays a bare person key until something else happens to
	// re-render the card.
	const people = usePeople();
	const reviewTeams = useReviewTeams();
	const reviewers = reviewLines(pr, selectedReview, prReviewRequested);
	const humanReviewers = reviewers
		.filter((reviewer) => reviewer.human)
		.slice(0, REVIEWERS_SHOWN);
	const otherReviewers = reviewers
		.filter((reviewer) => !reviewer.human)
		.slice(0, REVIEWERS_SHOWN);

	const shown = assets.slice(0, ASSETS_SHOWN);

	function pickReviewer(name: string | null, recipients?: string[]) {
		if (reviewBusy) return;
		const previous = selectedReview;
		const next = name
			? {
					to: name,
					...(recipients ? { recipients } : {}),
					by: getCurrentUser(),
					at: new Date().toISOString(),
				}
			: null;
		setSelectedReview(next);
		setReviewError(null);
		setReviewBusy(true);
		setSessionReviewerApi(session.id, name, getCurrentUser())
			.catch((error: any) => {
				setSelectedReview(previous);
				setReviewError(error?.message || "Failed to set reviewer");
			})
			.finally(() => setReviewBusy(false));
	}

	return (
		<>
			{changedFiles > 0 && (
				<button
					className={WS_SUMMARY_ROW}
					onClick={() => go(() => onOpenPanelTab("changes"))}
				>
					<span className={WS_SUMMARY_RAIL}>
						<IconFile size={20} className={WS_SUMMARY_ICON} />
					</span>
					<span className={WS_SUMMARY_LABEL}>
						{changedFiles} file{changedFiles === 1 ? "" : "s"} changed
					</span>
					<span className={WS_SUMMARY_COUNT}>
						<span className="text-green">+{additions}</span>{" "}
						<span className="text-red">−{deletions}</span>
					</span>
				</button>
			)}

			{dirty > 0 && (
				<button className={WS_SUMMARY_ROW} onClick={askCommit} disabled={!send}>
					<span className={WS_SUMMARY_RAIL}>
						<IconClock size={20} className={WS_SUMMARY_ICON} />
					</span>
					<span className={WS_SUMMARY_LABEL}>
						{prompted
							? "Asked to commit"
							: `${dirty} file${dirty === 1 ? "" : "s"} uncommitted`}
					</span>
					{!prompted && <span className={WS_SUMMARY_ACTION}>Commit</span>}
				</button>
			)}

			{/* Which PR, where it stands, and the one thing to do about it. The
			    strip owns all three; this card only says where they go. */}
			<PrStatusBar
				variant="summary"
				sessionId={session.id}
				repo={session.repo || undefined}
				archived={session.archived}
				prs={session.prs}
				send={send}
				running={running}
				refreshTick={refreshTick}
				onOpenPrTab={() => go(onOpenPr)}
				onOpenChecksTab={() => go(onOpenChecks)}
				onArchive={onArchive ? () => go(onArchive) : undefined}
			/>

			{/* One review section for both the automated reading and the people asked
			    to review. The final row owns the picker, so adding or changing a
			    reviewer never requires opening the workspace panel. */}
			<div className={WS_SUMMARY_SECTION}>Review</div>
			{otherReviewers.map((reviewer) => (
				<button
					key={reviewer.key}
					className={WS_SUMMARY_ROW}
					onClick={() => go(onOpenPr)}
					title={`${reviewer.name} · ${reviewer.state}`}
				>
					<span className={WS_SUMMARY_RAIL}>
						<UserAvatar
							name={reviewer.name}
							login={reviewer.login}
							size={16}
							edge={false}
						/>
					</span>
					<span className={WS_SUMMARY_LABEL}>{reviewer.name}</span>
					<span className={cn(WS_SUMMARY_STATE, reviewer.tone)}>
						{reviewer.state}
					</span>
				</button>
			))}

			{humanReviewers.length > 0 &&
				humanReviewers.map((reviewer) => (
					<button
						key={reviewer.key}
						className={WS_SUMMARY_ROW}
						onClick={() => go(() => onOpenPanelTab("info"))}
						title={`${reviewer.name} · ${reviewer.state}`}
					>
						<span className={WS_SUMMARY_RAIL}>
							<UserAvatar
								name={reviewer.name}
								login={reviewer.login}
								size={16}
								edge={false}
							/>
						</span>
						<span className={WS_SUMMARY_LABEL}>{reviewer.name}</span>
						<span className={cn(WS_SUMMARY_STATE, reviewer.tone)}>
							{reviewer.state}
						</span>
					</button>
				))}
			{humanReviewers.length === 0 && (
				<Menu.Root>
					<Menu.Trigger
						className={WS_SUMMARY_ROW}
						disabled={reviewBusy}
					>
						<span className={WS_SUMMARY_RAIL}>
							<IconPeople size={20} className={WS_SUMMARY_ICON} />
						</span>
						<span className={WS_SUMMARY_LABEL}>No reviewers</span>
						<span className={cn(WS_SUMMARY_ACTION, "inline-flex items-center gap-0.5")}>
							Add
							<IconChevronDown size={14} />
						</span>
					</Menu.Trigger>
					<Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
					{people.map((person) => (
						<Menu.Item key={person.name} onClick={() => pickReviewer(person.name)}>
							<UserAvatar name={person.name} size={22} />
							<span className="min-w-0 flex-1 truncate">{person.name}</span>
							<Menu.Check on={selectedReview?.to === person.name} size={20} className="text-dim" />
						</Menu.Item>
					))}
					{reviewTeams.length > 0 && <Menu.Separator />}
					{reviewTeams.map((team) => (
						<Menu.Item
							key={team.github}
							onClick={() => pickReviewer(team.github, team.members)}
						>
							<span className="grid size-[22px] place-items-center text-dim">
								<IconStack size={20} />
							</span>
							<span className="min-w-0 flex-1 truncate">{team.name}</span>
							<Menu.Check on={selectedReview?.to === team.github} size={20} className="text-dim" />
						</Menu.Item>
					))}
					</Menu.Popup>
				</Menu.Root>
			)}
			{reviewError && (
				<div className="px-4 py-1 text-meta font-medium text-red">{reviewError}</div>
			)}

			{shown.length > 0 && (
				<>
					<div className={WS_SUMMARY_DIVIDER} />
					<div className={WS_SUMMARY_SECTION}>Assets</div>
					{shown.map((file) => (
						<button
							key={file.path}
							className={WS_SUMMARY_ROW}
							onClick={() => go(onOpenAssets)}
							title={file.path}
						>
							<span className={WS_SUMMARY_RAIL}>
								{IMAGE_RE.test(file.path) ? (
									<img
										src={sessionAssetPreviewUrl(session.id, file)}
										alt=""
										className={WS_SUMMARY_THUMB}
										loading="lazy"
									/>
								) : (
									<IconFile size={20} className={WS_SUMMARY_ICON} />
								)}
							</span>
							<span className={WS_SUMMARY_LABEL}>{file.path}</span>
						</button>
					))}
					{assets.length > shown.length && (
						<button className={WS_SUMMARY_ROW} onClick={() => go(onOpenAssets)}>
							<span className={WS_SUMMARY_RAIL} />
							<span className={cn(WS_SUMMARY_LABEL, "text-dim")}>
								View all {assets.length}
							</span>
						</button>
					)}
				</>
			)}
		</>
	);
}
