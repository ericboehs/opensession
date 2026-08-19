import { repoLabel } from "../lib/repo-label";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GitStatusInfo, PrDetails } from "../lib/types";
import {
	refChipText,
	refLabel,
	refTone,
	summarizePrSeries,
	type SessionPrRef,
} from "../lib/pr-refs";
import {
	archiveSessionApi,
	fetchGitStatus,
	fetchPr,
	gitPullApi,
	gitPushApi,
	mergePrApi,
	mergePrStackApi,
} from "../lib/api";
import { stackLayersTopFirst, stackMergePlan } from "../lib/pr-stack";
import {
	pollWhileVisible,
	PR_WEBHOOK_FALLBACK_POLL_MS,
} from "../lib/poll";
import { getCurrentUser } from "./UserPicker";
import { providerFromUrl } from "../lib/provider";
import { sessionPrPresentation } from "../lib/session-prs";
import {
	prChipClass,
	prChipExternalClass,
	PR_BAR,
	PR_BAR_BG,
	PR_BAR_CHECKING,
	PR_BAR_ERROR,
	PR_BAR_IN_CARD,
	PR_BAR_STACK,
	PR_BAR_STATE,
	PR_CHIP_SEAM,
	PR_HEAD,
	PR_HEAD_BTN,
	PR_HEAD_ERROR,
	PR_SIB_DOT,
	PR_SIB_DOT_BG,
	PR_BAR_STATE_TEXT,
	PR_STATE_TEXT,
} from "../lib/pr-tone-classes";
// The summary variant renders into the workspace summary card, so it borrows
// that card's row grammar rather than inventing a third one. The strip owns
// the PR state machine; the card owns how a row in it looks.
import {
	WS_SUMMARY_COUNT,
	WS_SUMMARY_LABEL,
	WS_SUMMARY_RAIL,
	WS_SUMMARY_ROW,
	WS_SUMMARY_STATUS_ROW,
} from "../lib/workspace-summary-classes";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu, Menu } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { cn } from "../ui/cn";
import { useShortcutLabel } from "../hooks/useShortcutBindings";
import { PrChecksPopover } from "./PrChecksPopover";
import { PrSeriesRows } from "./PrSeriesRows";
import { PrStackChip } from "./pr/StackPopover";
import {
	IconArrowDown,
	IconArrowUp,
	IconArrowUpRight,
	IconPullRequest,
	IconGitMerge,
	IconCopy,
	IconHash,
	IconCheck,
	IconClock,
	IconPlus,
	IconArchive,
	IconX,
} from "./icons";

/**
 * Conductor-style status strip at the top of the right Workspace panel: the PR
 * number as a linked pill, one derived headline ("Ready to merge", "Merged",
 * "Checks running", "Ahead by 2 commits"…), and a single primary action on the
 * right (Merge / Push / Create PR / Archive).
 *
 * One departure from Conductor: sessions push automatically, so Push is a
 * fallback for stray local commits rather than the main flow, and "Create PR"
 * asks the session to do it (commit → push → PR with a real description)
 * instead of minting a bare PR from the header.
 */

interface PrHeadline {
	key:
		| "merged"
		| "closed"
		| "conflicts"
		| "failing"
		| "running"
		| "draft"
		| "changes-requested"
		| "stack-blocked" // a lower layer of this PR's stack is still open
		| "ready"
		| "ahead"
		| "behind" // behind the branch's own upstream → Pull
		| "behind-base" // clean tree, no PR, behind origin/<base> → Pull
		| "no-pr"
		| "clean";
	label: string;
	tone: "green" | "purple" | "red" | "yellow" | "muted";
}

/** Roll PR + local git state up into the one line the header shows. */
function deriveHeadline(
	pr: PrDetails | null,
	git: GitStatusInfo | null,
): PrHeadline {
	const ahead = git?.ahead ?? 0;
	const behind = git?.behind ?? 0;
	if (pr) {
		if (pr.state === "MERGED") return { key: "merged", label: "Merged", tone: "purple" };
		if (pr.state === "CLOSED") return { key: "closed", label: "Closed", tone: "muted" };
		if (ahead > 0)
			return {
				key: "ahead",
				label: `Ahead by ${ahead} commit${ahead === 1 ? "" : "s"}`,
				tone: "yellow",
			};
		// Local checkout is stale vs the PR branch (someone else pushed) — the
		// PR data below would describe commits this worktree doesn't have yet.
		if (behind > 0)
			return {
				key: "behind",
				label: `Behind by ${behind} commit${behind === 1 ? "" : "s"}`,
				tone: "yellow",
			};
		if (pr.mergeable === "CONFLICTING")
			return { key: "conflicts", label: "Merge conflicts", tone: "red" };
		const checks = summarizeChecks(pr);
		if (checks.failed > 0) return { key: "failing", label: "Checks failed", tone: "red" };
		if (checks.pending > 0)
			return {
				key: "running",
				label: `${checks.pending} check${checks.pending === 1 ? "" : "s"} pending…`,
				tone: "yellow",
			};
		if (pr.isDraft) return { key: "draft", label: "Draft", tone: "muted" };
		if (pr.reviewDecision === "CHANGES_REQUESTED")
			return { key: "changes-requested", label: "Changes requested", tone: "red" };
		// A stack layer never lands alone while the layers under it are open — it
		// lands as a stack merge, which takes them along, so it is genuinely
		// ready. The one refusal we can see from here is a draft in that set:
		// GitHub's stack merge won't take one, and the whole merge is atomic.
		const draftBelow = stackMergePlan(pr)?.blockedBy;
		if (draftBelow)
			return {
				key: "stack-blocked",
				label: `Draft #${draftBelow.number} below it`,
				tone: "yellow",
			};
		return { key: "ready", label: "Ready to merge", tone: "green" };
	}
	if (behind > 0)
		return {
			key: "behind",
			label: `Behind by ${behind} commit${behind === 1 ? "" : "s"}`,
			tone: "yellow",
		};
	// A shared-checkout repo (Open Session's own) lands work as a commit on its
	// default branch and never opens a PR, so unpushed commits are the whole
	// story there — "No PR open · Create PR" would be the wrong move.
	if (git?.sharedCheckout && ahead > 0)
		return {
			key: "ahead",
			label: `Ahead by ${ahead} commit${ahead === 1 ? "" : "s"}`,
			tone: "yellow",
		};
	if (ahead > 0 || (git?.uncommittedFiles ?? 0) > 0)
		return { key: "no-pr", label: "No PR open", tone: "muted" };
	if ((git?.behindBase ?? 0) > 0)
		return {
			key: "behind-base",
			label: `${git!.behindBase} commit${git!.behindBase === 1 ? "" : "s"} behind ${git!.baseBranch}`,
			tone: "muted",
		};
	return { key: "clean", label: "Up to date", tone: "muted" };
}

/** The PR row's glyph tone in the summary card: where the pull request itself
 *  stands, which is a different question from the headline under it. A merged
 *  PR with an old approval on it must not read as open. */
function prGlyphTone(pr: PrDetails): string {
	if (pr.state === "MERGED") return "text-purple";
	if (pr.state === "CLOSED") return "text-dim";
	if (pr.isDraft) return "text-faint";
	return "text-green";
}

/** The summary card's headline glyph, one per state the strip can report. The
 *  card is a list of rows and every other row opens with a mark, so the
 *  headline needs one too rather than starting on bare text. */
function headlineGlyph(key: PrHeadline["key"]): React.ReactNode {
	switch (key) {
		case "merged":
		case "conflicts":
			return <IconGitMerge size={20} />;
		case "closed":
		case "failing":
		case "changes-requested":
			return <IconX size={20} />;
		case "running":
			return <IconClock size={20} />;
		case "ahead":
			return <IconArrowUp size={20} />;
		case "behind":
		case "behind-base":
			return <IconArrowDown size={20} />;
		case "no-pr":
		case "draft":
		case "stack-blocked":
			return <IconPullRequest size={20} />;
		default:
			return <IconCheck size={20} />;
	}
}

export type { SessionPrRef } from "../lib/pr-refs";
// Re-exported so the strip stays the one import site for PR-ref presentation.
export { refTone } from "../lib/pr-refs";

export function summarizeChecks(pr: PrDetails | null): {
	passed: number;
	failed: number;
	pending: number;
	total: number;
} {
	let passed = 0,
		failed = 0,
		pending = 0;
	for (const c of pr?.checks || []) {
		// StatusContexts (Vercel deploys) report a state, not a status — PENDING
		// there means running, and must not read as done.
		if (
			(c.status !== "COMPLETED" && c.status !== "") ||
			c.conclusion === "PENDING" ||
			c.conclusion === "EXPECTED"
		)
			pending++;
		else if (c.conclusion === "SUCCESS") passed++;
		else if (["FAILURE", "TIMED_OUT", "ERROR"].includes(c.conclusion)) failed++;
	}
	return { passed, failed, pending, total: (pr?.checks || []).length };
}

interface Props {
	sessionId: string;
	/** Primary repo id (for multi-repo sessions the header tracks the primary). */
	repo?: string;
	archived?: boolean;
	/**
	 * Every PR this session spans (`session.prs`: primary branch + attached
	 * repos + linked + footer-discovered). The headline and the primary action
	 * stay on the primary branch's PR — that's the one this worktree can push,
	 * pull and merge — while the rest ride along as chips, so a session that
	 * shipped one feature as four PRs shows all four. No extra fetch: the refs
	 * come enriched from the server's bulk PR cache.
	 */
	prs?: SessionPrRef[];
	/** Prompt the session (Create PR / Resolve conflicts) — WS `prompt` message. */
	send?: (msg: any) => void;
	/** Clicking the headline jumps to the PR tab; a chip jumps to that PR. */
	onOpenPrTab?: (ref?: { repo: string; branch: string }) => void;
	/** Open the primary PR directly on its Checks tab. */
	onOpenChecksTab?: () => void;
	/** Archive via the owning viewer so it can select the neighboring sidebar row. */
	onArchive?: () => void;
	/** Start a new session in this workspace (the tab strip's "+", as a labelled
	    button). Offered beside Archive once the PR has landed, so a merged
	    session is a fork in the road rather than a dead end: file it away, or
	    keep going in a fresh session. Left unset in the session header, which
	    carries its own "+". */
	onNewSession?: () => void;
	/**
	 * - "bar" is the panel's own strip.
	 * - "header" renders just the PR chip + primary action while the panel is
	 *   closed.
	 * - "summary" renders the same two facts as rows for the workspace summary
	 *   card: which PR, and where it stands with its one action. It is a
	 *   variant rather than a copy because everything behind that action —
	 *   headline derivation, the stack merge plan, confirm-then-merge, the
	 *   prompt-the-session paths, busy state — is this component's, and a
	 *   second implementation of it is a second thing that can be wrong about
	 *   whether a merge is in flight.
	 */
	variant?: "bar" | "header" | "summary";
	/** Optional element rendered inside the strip, left of the PR chip (bar
	    variant only) so it shares the strip's tone background — e.g. the globe
	    staging-deploy icon in the Workspace panel. */
	leading?: React.ReactNode;
	/** Live run state — when it falls from running→idle the header refetches, so
	    it reflects the just-finished turn (and any auto-push) immediately. */
	running?: boolean;
	/** Bumped by the viewer on a `git_pushed` or matching `pr_updated` broadcast. */
	refreshTick?: number;
}

interface PrBarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	tone:
		| "green"
		| "purple"
		| "red"
		| "status-red"
		| "status-yellow"
		| "secondary"
		| "purple-dashed"
		| "solid";
	icon?: React.ReactNode;
	confirm?: boolean;
}

function PrBarButton({
	tone,
	icon,
	confirm,
	className = "",
	children,
	...props
}: PrBarButtonProps) {
	const tones = {
		green:
			"bg-[var(--green)] border-[color-mix(in_srgb,var(--green)_78%,black)] text-white",
		purple:
			"bg-[var(--purple)] border-[color-mix(in_srgb,var(--purple)_78%,black)] text-white",
		red: "bg-[var(--red)] border-[color-mix(in_srgb,var(--red)_78%,black)] text-white",
		"status-red":
			"border-[color-mix(in_srgb,var(--red)_45%,transparent)] bg-[color-mix(in_srgb,var(--red)_12%,var(--control-surface))] text-red hover:bg-red-soft hover:brightness-100",
		"status-yellow":
			"border-[color-mix(in_srgb,var(--yellow)_35%,transparent)] bg-[color-mix(in_srgb,var(--yellow)_10%,var(--control-surface))] text-yellow hover:bg-[color-mix(in_srgb,var(--yellow)_16%,var(--control-surface))] hover:brightness-100",
		solid:
			"bg-[var(--text)] text-[var(--bg)] border-[color-mix(in_srgb,var(--text)_84%,transparent)]",
		secondary: "bg-raised text-fg border-line-strong hover:bg-hover hover:brightness-100",
		// The open outline beside a filled button: purple ink on the strip's own
		// band, dashed, so it reads as the road not yet taken next to the solid
		// action. Nothing to fill and nothing to lift, so it drops the shadow.
		"purple-dashed":
			"border-dashed border-[color-mix(in_srgb,var(--purple)_45%,transparent)] bg-transparent text-purple shadow-none hover:bg-[color-mix(in_srgb,var(--purple)_10%,transparent)] hover:brightness-100",
	} as const;
	return (
		<button
			type="button"
			className={cn(
				"inline-flex min-h-[30px] items-center justify-center gap-1.5 rounded-control border px-2.5 py-[5px] text-label leading-none font-semibold whitespace-nowrap smooth-shadow-sm transition-[background-color,border-color,color,filter,transform] duration-150 ease-in-out hover:brightness-[1.08] active:scale-[0.98] active:brightness-[0.98] focus-visible:outline-2 focus-visible:outline-[var(--accent-ink)] focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-60 disabled:shadow-none",
				tones[tone],
				// A leading glyph carries its own margin: the icon set draws in a
				// 4.75–19.25 span of a 24 grid, so an 18px box holds ~3.5px of
				// empty on each side. Equal padding therefore lands the ink 3.5px
				// deeper on the left than the label sits from the right edge, and
				// the pair reads as pushed. Pay the padding back on the icon side,
				// and close the inner gap so the two read as one group rather than
				// two things. Icon-only callers override px themselves, so this
				// never lands on a lone glyph.
				icon && "gap-1 pl-[6.5px]",
				confirm && "outline-2 outline-[color-mix(in_srgb,var(--green)_45%,transparent)] outline-offset-1",
				className,
			)}
			{...props}
		>
			{icon && (
				<span className="inline-flex size-[18px] shrink-0 items-center justify-center [&_svg]:block [&_svg]:stroke-[1.7]">
					{icon}
				</span>
			)}
			{/* Centered on the cap band, not on the em box: `text-box` trims the
			    line box down to cap height and baseline, so the flex centering
			    lands the ink itself in the middle of the button and beside the
			    icon, whatever font the platform picks. Browsers without
			    `text-box` (Firefox) center the em box, which lands within a pixel
			    of it.

			    The half pixel on top is deliberate and is the only part chosen by
			    eye: a word carries more mass under its cap band than over it, so
			    the geometric center reads a touch high. It settles the label
			    without going back to a nudge that has to carry the whole
			    correction. */}
			<span className="translate-y-[0.5px] [text-box:trim-both_cap_alphabetic]">
				{children}
			</span>
		</button>
	);
}

// The open-PR chord's handler lives in SessionViewer; the chip only
// advertises whatever it is bound to.

/**
 * The PR chip links to Open Session's review by default. GitHub remains a
 * separate outbound action, while the context menu holds copy actions.
 */
function PrNumberChip({
	pr,
	tone,
	size,
	onOpenPrTab,
}: {
	pr: PrDetails;
	tone: PrHeadline["tone"];
	/** The strip and the session header size the pair differently. */
	size: "bar" | "head";
	onOpenPrTab?: () => void;
}) {
	const [copied, setCopied] = useState<"link" | "number" | null>(null);
	const provider = providerFromUrl(pr.url);
	const prChord = useShortcutLabel("open-pr");

	const copy = useCallback((kind: "link" | "number", text: string) => {
		navigator.clipboard?.writeText(text).then(() => {
			setCopied(kind);
			setTimeout(() => setCopied(null), 1500);
		});
	}, []);

	return (
		<div className="inline-flex items-center">
			<ContextMenu.Root>
				<ContextMenu.Trigger
					render={
						<button
							type="button"
							className={`${prChipClass(tone, size)} ${PR_CHIP_SEAM}`}
							onClick={onOpenPrTab}
							title={`Review #${pr.number}: ${pr.title}`}
						/>
					}
				>
					{/* Cap band plus the same half pixel as the action button beside
					    it, so the pair reads level. */}
					<span className="translate-y-[0.5px] [text-box:trim-both_cap_alphabetic]">
						#{pr.number}
					</span>
				</ContextMenu.Trigger>
				<ContextMenu.Popup>
					<ContextMenu.Item
						render={
							<a
								href={pr.url}
								target="_blank"
								rel="noopener"
								className="no-underline"
							/>
						}
					>
						<IconArrowUpRight size={20} />
						<span className="grow">Open on {provider.name}</span>
					</ContextMenu.Item>
					<ContextMenu.Item
						closeOnClick={false}
						onClick={() => copy("link", pr.url)}
					>
						{copied === "link" ? (
							<IconCheck size={20} />
						) : (
							<IconCopy size={20} />
						)}
						<span className="grow">
							{copied === "link" ? "Copied" : "Copy link"}
						</span>
					</ContextMenu.Item>
					<ContextMenu.Item
						closeOnClick={false}
						onClick={() => copy("number", `#${pr.number}`)}
					>
						{copied === "number" ? (
							<IconCheck size={20} />
						) : (
							<IconHash size={20} />
						)}
						<span className="grow">
							{copied === "number" ? "Copied" : "Copy number"}
						</span>
					</ContextMenu.Item>
				</ContextMenu.Popup>
			</ContextMenu.Root>
			<Tooltip
				label={
					prChord
						? `Open on ${provider.name} (${prChord})`
						: `Open on ${provider.name}`
				}
			>
				<a
					className={`${prChipExternalClass(tone, size)} ${PR_CHIP_SEAM}`}
					href={pr.url}
					target="_blank"
					rel="noopener"
					aria-label={`Open pull request #${pr.number} on ${provider.name}`}
				>
					<IconArrowUpRight size={18} />
				</a>
			</Tooltip>
		</div>
	);
}

/**
 * The session's other PRs, as compact tone-coloured chips after the primary
 * one. Their tone IS the aggregate signal — a red #72 beside a green "Ready to
 * merge" reads at a glance — and clicking one opens it in the Review tab, which
 * is where per-PR review and merge belong. Past `maxInline` (0 in the session
 * header, where there's no room) they collapse into a `+N` menu.
 */
function PrRefChips({
	refs,
	maxInline,
	primaryRepo,
	onOpen,
}: {
	refs: SessionPrRef[];
	maxInline: number;
	primaryRepo?: string;
	onOpen?: (ref: { repo: string; branch: string }) => void;
}) {
	if (refs.length === 0) return null;
	const inline = refs.slice(0, maxInline);
	const rest = refs.slice(maxInline);
	// The overflow chip carries the worst tone in the hidden set, so a failing
	// PR still shows red even while collapsed.
	const restTone = rest.some((r) => refTone(r) === "red")
		? "red"
		: rest.some((r) => refTone(r) === "yellow")
			? "yellow"
			: rest.every((r) => r.state === "MERGED")
				? "purple"
				: rest.some((r) => refTone(r) === "green")
					? "green"
					: "muted";
	return (
		<div className="inline-flex min-w-0 items-center gap-1">
			{inline.map((ref) => (
				<Tooltip key={`${ref.repo} ${ref.branch}`} label={refLabel(ref)}>
					<button
						type="button"
						className={prChipClass(refTone(ref), "sib")}
						onClick={() => onOpen?.(ref)}
					>
						{refChipText(ref, primaryRepo)}
					</button>
				</Tooltip>
			))}
			{rest.length > 0 && (
				<Menu.Root>
					<Menu.Trigger
						render={
							<button
								type="button"
								className={prChipClass(restTone, "sib")}
								aria-label={`${rest.length} more pull request${rest.length === 1 ? "" : "s"}`}
							/>
						}
					>
						+{rest.length}
					</Menu.Trigger>
					<Menu.Popup>
						{rest.map((ref) => (
							<Menu.Item
								key={`${ref.repo} ${ref.branch}`}
								onClick={() => onOpen?.(ref)}
							>
								<span
								className={`${PR_SIB_DOT} ${PR_SIB_DOT_BG[refTone(ref)]}`}
							/>
								<span className="grow">
									{repoLabel(ref.repo)} #{ref.number}
								</span>
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Root>
			)}
		</div>
	);
}

/** Last-known state per session+repo, so a remount (tab switch, panel toggle)
 * paints the previous status instantly and revalidates behind it instead of
 * blanking for a fresh round-trip. Module-level: survives unmounts, dies with
 * the page (a reload starts honest). */
const lastKnown = new Map<
	string,
	{ pr: PrDetails | null; git: GitStatusInfo | null }
>();

export function PrStatusBar({
	sessionId,
	repo,
	archived,
	prs,
	send,
	onOpenPrTab,
	onOpenChecksTab,
	onArchive,
	onNewSession,
	variant = "bar",
	leading,
	running,
	refreshTick,
}: Props) {
	const presentation = useMemo(() => sessionPrPresentation(prs), [prs]);
	const promoted =
		presentation.primary?.source !== "primary" ? presentation.primary : undefined;
	const targetRepo = promoted?.repo || repo;
	const targetBranch = promoted?.branch;
	const cacheId = `${sessionId}\0${targetRepo || ""}\0${targetBranch || ""}`;
	const seed = lastKnown.get(cacheId);
	const [pr, setPr] = useState<PrDetails | null>(seed?.pr ?? null);
	const [git, setGit] = useState<GitStatusInfo | null>(seed?.git ?? null);
	const [loaded, setLoaded] = useState(!!seed);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmMerge, setConfirmMerge] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isArchived, setIsArchived] = useState(!!archived);
	const [prompted, setPrompted] = useState<string | null>(null);

	useEffect(() => setIsArchived(!!archived), [archived]);

	const load = useCallback(async () => {
		const [prData, gitData] = await Promise.all([
			fetchPr(sessionId, targetRepo, targetBranch).catch(() => null),
			promoted
				? Promise.resolve(null)
				: fetchGitStatus(sessionId, repo).catch(() => null),
		]);
		setPr(prData);
		setGit(gitData);
		setLoaded(true);
		lastKnown.set(cacheId, { pr: prData, git: gitData });
	}, [sessionId, targetRepo, targetBranch, promoted, repo, cacheId]);

	useEffect(() => {
		// Session/repo switch on a mounted component: fall back to that target's
		// last-known state (or the checking placeholder) while the fetch runs.
		const cached = lastKnown.get(cacheId);
		setPr(cached?.pr ?? null);
		setGit(cached?.git ?? null);
		setLoaded(!!cached);
		load();
		return pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
	}, [load]);

	// Refetch the instant a turn ends (running→idle) or an auto-push lands
	// (refreshTick bump), so "Ahead by N commits" clears without waiting on a
	// webhook or fallback poll. Skip initial mount/true edges: load() above covers
	// those. Track the previous run state so only the falling edge
	// triggers (a turn *starting* can't change the pushed/ahead state).
	const prevRunning = React.useRef(running);
	useEffect(() => {
		const fell = prevRunning.current && !running;
		prevRunning.current = running;
		if (fell) load();
	}, [running, load]);
	useEffect(() => {
		if (refreshTick) load();
	}, [refreshTick, load]);

	const headline = useMemo(() => deriveHeadline(pr, git), [pr, git]);

	// Everything except the primary branch's PR (which the headline covers):
	// attached repos, manual links, and PRs discovered through their body
	// footer. Numberless refs are branches with no PR yet — nothing to chip.
	const siblings = presentation.additional;
	// A real GitHub stack is returned with the primary PR detail rather than in
	// session.prs. Expand its other layers into the same compact rows used by a
	// multi-repo series, preferring enriched session refs when both sources know
	// the layer (those refs include check counts and review state).
	const stackRows: SessionPrRef[] =
		pr?.stack && targetRepo
			? stackLayersTopFirst(pr.stack)
					.filter((layer) => !layer.current)
					.map(
						(layer) =>
							siblings.find(
								(ref) => ref.repo === targetRepo && ref.number === layer.number,
							) || {
								repo: targetRepo,
								branch: layer.headRefName,
								source: "discovered" as const,
								number: layer.number,
								url: layer.url,
								title: layer.title,
								state: layer.state,
								isDraft: layer.isDraft,
							},
					)
			: [];
	const stackNumbers = new Set(stackRows.map((ref) => ref.number));
	const statusRows = [
		...stackRows,
		...siblings.filter(
			(ref) => ref.repo !== targetRepo || !stackNumbers.has(ref.number),
		),
	];
	// Slack/Linear sessions carry no explicit `repo` — fall back to the primary
	// ref's, so cross-repo chips still get their repo hint.
	const primaryRepoId =
		targetRepo || (prs || []).find((r) => r.source === "primary")?.repo;
	const openSiblings = statusRows.filter(
		(r) => r.state !== "MERGED" && r.state !== "CLOSED",
	).length;
	// A feature shipped as N PRs is only done when they've all landed — so the
	// merged headline counts the series, and Archive waits for the last one.
	const seriesAllMerged =
		statusRows.length > 0 && statusRows.every((r) => r.state === "MERGED");
	// Nothing on this session's own branch, but it owns PRs elsewhere: "No PR
	// open" would be a lie with three rows sitting under it, and a bare count in
	// the neutral tone hides a failing PR one row down — so the strip borrows the
	// series' own worst tone and says how much of it is still open.
	const series = !pr ? summarizePrSeries(siblings) : null;
	const headlineTone = series ? series.tone : headline.tone;
	const headlineLabel =
		headline.key === "merged" && statusRows.length > 0
			? seriesAllMerged
				? `All ${statusRows.length + 1} merged`
				: `Merged · ${openSiblings} of ${statusRows.length + 1} open`
			: series
				? series.label
				: headline.label;

	// When checks are the reason for the headline, the headline IS the checks
	// control: hovering it shows them, clicking it opens Review's Checks tab —
	// so the strip needs no View checks button beside it.
	const checksPr =
		pr && (headline.key === "running" || headline.key === "failing") ? pr : null;

	async function run(name: string, fn: () => Promise<unknown>) {
		if (busy) return;
		setBusy(name);
		setError(null);
		try {
			await fn();
			await load();
		} catch (e: any) {
			setError(e.message || `${name} failed`);
		} finally {
			setBusy(null);
		}
	}

	// Merging a stack layer means merging everything under it — GitHub takes the
	// whole set atomically, and a single-PR merge of a layer with open layers
	// below it is refused outright. So the action follows the stack whenever
	// there is more than one layer to take, and stays a plain merge otherwise
	// (a bottom layer, or one whose lower layers have already landed).
	const stackPlan = stackMergePlan(pr);
	const stackMerge =
		stackPlan && stackPlan.layers.length > 1 && !stackPlan.blockedBy
			? stackPlan
			: null;

	function handleMerge() {
		if (!confirmMerge) {
			setConfirmMerge(true);
			setTimeout(() => setConfirmMerge(false), 4000);
			return;
		}
		setConfirmMerge(false);
		run("merge", () =>
			stackMerge
				? mergePrStackApi(sessionId, "squash", targetRepo, targetBranch)
				: mergePrApi(sessionId, "squash", targetRepo, targetBranch),
		);
	}

	// Session-driven actions: ask the agent instead of doing bare git plumbing —
	// a session-authored PR gets a real title/description, and conflict
	// resolution needs judgment, not a button.
	function promptSession(label: string, content: string) {
		if (!send) return;
		send({ type: "prompt", sessionId, user: getCurrentUser(), content });
		setPrompted(label);
		setTimeout(() => setPrompted(null), 6000);
	}

	// The strip is where this branch stands against the remote and the base: the
	// PR, or failing that the commits still to push or pull. So it stands down
	// for the two states that hold neither.
	//
	//  - Clean: level with the upstream, the base and the working tree. One
	//    muted "Up to date" over a link to an empty PR tab.
	//  - Nothing but a dirty tree on a shared-checkout repo (Open Session's
	//    own), where work lands as a commit on the default branch and no PR is
	//    ever opened. "Create PR" is the wrong move there, and uncommitted work
	//    is the Git status section's subject, not this strip's.
	const noPr = !pr && statusRows.length === 0;
	const empty =
		noPr &&
		(headline.key === "clean" ||
			(!!git?.sharedCheckout && headline.key === "no-pr"));

	// The strip still holds its place while the PR fetch runs (Kent: a topbar
	// that blinks in and out of existence shouldn't exist), so a session that
	// has a PR doesn't pop the bar in a GitHub round-trip late. Only when the
	// session's refs already say a PR is coming, though: reserving the row for a
	// session that turns out to have nothing is the same blink, pointed the
	// other way.
	if (!loaded) {
		if (
			variant === "header" ||
			// The card fills in row by row as its own fetches land, so a
			// placeholder row here would be the one thing in it that flashes.
			variant === "summary" ||
			!(prs || []).some((ref) => ref.number)
		)
			return null;
		return (
			<div
				className={`pr-bar wco-chrome ${PR_BAR} ${PR_BAR_BG.muted} ${PR_BAR_IN_CARD}`}
			>
				{leading}
				<span className={`pr-bar-checking ${PR_BAR_CHECKING}`}>Checking status…</span>
			</div>
		);
	}
	if (empty) return null;

	// Header mode: only once a PR exists — the chip is the anchor; a bare
	// Create PR/Push button in the chrome would just be noise. A session whose
	// PRs all live elsewhere (nothing on its own branch) still gets its chips.
	if (variant === "header" && !pr && siblings.length === 0) return null;

	// Primary action for the current headline (right side of the strip). In the
	// session header it sizes up to the header's other bordered controls, so the
	// chip and the action read as a matched pair.
	const actionBtn = variant === "header" ? PR_HEAD_BTN : "";
	function renderAction(): React.ReactNode {
		if (prompted) {
			const tone: PrBarButtonProps["tone"] =
				headline.key === "conflicts"
					? "red"
					: headline.key === "no-pr"
						? "secondary"
						: "status-red";
			return (
				<PrBarButton
					className={actionBtn}
					tone={tone}
					icon={<Spinner size="sm" />}
					disabled
				>
					{prompted}
				</PrBarButton>
			);
		}
		switch (headline.key) {
			case "merged": {
				// Landed work is a fork in the road: file the session away, or keep
				// going in a fresh one. Don't offer to archive a session that still
				// has open PRs in its series just because the primary one landed —
				// the new session stands either way, since the branch is behind it.
				const canArchive = !isArchived && openSiblings === 0;
				if (!onNewSession && !canArchive) return null;
				return (
					<div className="flex items-center gap-2">
						{onNewSession && (
							<PrBarButton
								className={cn(actionBtn, "@max-[440px]:px-1.5 @max-[440px]:gap-0")}
								// The open outline: carrying the work on is the choice
								// beside the filed-away one, not the same weight as it.
								tone="purple-dashed"
								icon={<IconPlus size={18} />}
								onClick={onNewSession}
								title="Start a new session in this workspace"
								aria-label="Continue"
							>
								{/* The label is the first thing to go on a narrow panel: the
								    headline beside it is what the strip exists to say. */}
								<span className="@max-[440px]:hidden">Continue</span>
							</PrBarButton>
						)}
						{canArchive && (
							<PrBarButton
								className={actionBtn}
								// The merged strip's own purple, filled: archiving is what
								// a landed PR is for, and the band around it already says
								// purple, so the button is that colour rather than a neutral.
								tone="purple"
								icon={<IconArchive size={18} />}
								disabled={!!busy}
								onClick={() =>
									run("archive", async () => {
										if (onArchive) onArchive();
										else await archiveSessionApi(sessionId, true);
										setIsArchived(true);
									})
								}
							>
								{busy === "archive" ? "Archiving…" : "Archive"}
							</PrBarButton>
						)}
					</div>
				);
			}
			case "ahead":
				return (
					<PrBarButton
						className={actionBtn}
						tone="solid"
						icon={<IconArrowUp size={18} />}
						disabled={!!busy}
						onClick={() => run("push", () => gitPushApi(sessionId, repo))}
					>
						{busy === "push" ? "Pushing…" : "Push"}
					</PrBarButton>
				);
			case "behind":
			case "behind-base":
				return (
					<PrBarButton
						className={actionBtn}
						tone="solid"
						icon={<IconArrowDown size={18} />}
						disabled={!!busy}
						title={
							headline.key === "behind-base"
								? `Merge the latest origin/${git?.baseBranch || "main"}`
								: "Fast-forward to the branch's upstream"
						}
						onClick={() =>
							run("pull", () =>
								gitPullApi(sessionId, repo, headline.key === "behind-base"),
							)
						}
					>
						{busy === "pull" ? "Pulling…" : "Pull"}
					</PrBarButton>
				);
			case "conflicts":
				return send ? (
					<PrBarButton
						className={actionBtn}
						tone="red"
						onClick={() =>
							promptSession(
								"Resolving…",
								`The PR has merge conflicts with ${pr?.baseRefName || git?.baseBranch || "main"}. Rebase this branch on the latest origin/${pr?.baseRefName || git?.baseBranch || "main"}, resolve the conflicts, and push.`,
							)
						}
					>
						Resolve
					</PrBarButton>
				) : null;
			// "N checks pending…" / "Checks failed" IS the affordance: hovering the
			// headline shows the checks, clicking it opens Review's Checks tab. A
			// View checks button beside it would be the same action twice.
			case "running":
				return null;
			case "failing":
				return send ? (
					<PrBarButton
						className={actionBtn}
						tone="status-red"
						onClick={() =>
							promptSession(
								"Fixing checks…",
								`Investigate the failing checks on PR #${pr?.number}, fix the failures, run the relevant tests, commit the changes, and push them.`,
							)
						}
					>
						Fix checks
					</PrBarButton>
				) : null;
			case "changes-requested":
				return send ? (
					<PrBarButton
						className={actionBtn}
						tone="status-red"
						onClick={() =>
							promptSession(
								"Addressing feedback…",
								`Address the requested changes on PR #${pr?.number}, run the relevant tests, commit the changes, and push them.`,
							)
						}
					>
						Address feedback
					</PrBarButton>
				) : null;
			case "no-pr":
				return send ? (
					<PrBarButton
						className={actionBtn}
						tone="secondary"
						icon={<IconPullRequest size={18} />}
						onClick={() =>
							promptSession(
								"Creating PR…",
								"Commit any remaining work, push the branch, and open a PR for it.",
							)
						}
					>
						Create PR
					</PrBarButton>
				) : null;
			case "ready":
				return (
					<PrBarButton
						className={actionBtn}
						tone="green"
						confirm={confirmMerge}
						icon={!busy && !confirmMerge ? <IconGitMerge size={18} /> : undefined}
						disabled={!!busy}
						onClick={handleMerge}
						title={
							stackMerge
								? `Squash and merge ${stackMerge.layers
										.map((l) => `#${l.number}`)
										.join(", ")} into ${pr?.stack?.baseRefName || "the base branch"}, all or nothing`
								: "Squash and merge this PR into its base branch"
						}
					>
						{busy === "merge"
							? stackMerge
								? "Merging stack…"
								: "Merging…"
							: confirmMerge
								? "Confirm merge"
								: stackMerge
									? "Merge stack"
									: "Merge"}
						{stackMerge && busy !== "merge" && (
							<span className="ml-1.5 rounded-full bg-white/20 px-1.5 tabular-nums">
								{stackMerge.layers.length}
							</span>
						)}
					</PrBarButton>
				);
			default:
				return null;
		}
	}

	// The summary card: which PR, then where it stands with its one action.
	//
	// The headline row is a div holding two targets rather than one row-wide
	// button, which is the card's only departure from "the whole row is the
	// target". It has to be: the label opens the PR (or its checks) and the
	// button beside it merges, pushes or pulls, and a button inside a button is
	// not a thing.
	if (variant === "summary") {
		// The label is the button, rather than a button wrapping it: it has to
		// carry the row's truncation and its flex share, and a `display:contents`
		// wrapper would drop the focus ring with the box.
		const labelClass = cn(
			WS_SUMMARY_LABEL,
			"cursor-pointer rounded-sm border-none bg-transparent p-0 text-left text-item-title text-fg hover:text-accent focus-ring",
		);
		return (
			<>
				{pr && (
					<button
						className={WS_SUMMARY_ROW}
						onClick={() => onOpenPrTab?.()}
						title={`#${pr.number} · ${pr.title}`}
					>
						<span className={cn(WS_SUMMARY_RAIL, prGlyphTone(pr))}>
							<IconPullRequest size={20} />
						</span>
						<span className={WS_SUMMARY_LABEL}>{pr.title}</span>
						<span className={cn(WS_SUMMARY_COUNT, "text-faint")}>
							#{pr.number}
						</span>
					</button>
				)}
				<div className={WS_SUMMARY_STATUS_ROW}>
					<span className={cn(WS_SUMMARY_RAIL, PR_STATE_TEXT[headlineTone])}>
						{headlineGlyph(headline.key)}
					</span>
					{/* When checks are the reason for the headline, the headline IS the
					    checks control, exactly as on the strip: hovering lists them,
					    clicking opens Review's Checks tab. */}
					{checksPr ? (
						<PrChecksPopover
							checks={checksPr.checks}
							trigger={
								<button
									type="button"
									className={labelClass}
									onClick={onOpenChecksTab}
								>
									{headlineLabel}
								</button>
							}
						/>
					) : (
						<button
							type="button"
							className={labelClass}
							onClick={() => onOpenPrTab?.()}
						>
							{headlineLabel}
						</button>
					)}
					{error && (
						<span className={PR_HEAD_ERROR} title={error}>
							{error}
						</span>
					)}
					{renderAction()}
				</div>
			</>
		);
	}

	if (variant === "header") {
		return (
			<div className={PR_HEAD}>
				{/* Left of the PR chip: a stack layer's first fact is that it is one
				    of several, and the merge action takes the whole set. */}
				{pr && (
					<PrStackChip
						pr={pr}
						tone={headline.tone}
						size="head"
						headline={headlineLabel}
						repo={primaryRepoId}
						onOpenPr={(r, branch) => onOpenPrTab?.({ repo: r, branch })}
					/>
				)}
				{pr && (
					<PrNumberChip
						pr={pr}
						tone={headline.tone}
						size="head"
						onOpenPrTab={() => onOpenPrTab?.()}
					/>
				)}
				{/* No room for a row of chips in the session header — the siblings
				    collapse into one `+N` menu in their worst tone. */}
				<PrRefChips
					refs={siblings}
					maxInline={0}
					primaryRepo={primaryRepoId}
					onOpen={onOpenPrTab}
				/>
				{headline.key === "running" && pr && (
					<PrChecksPopover
						checks={pr.checks}
						trigger={
								<button
									type="button"
									className={`${PR_BAR_STATE} ${PR_STATE_TEXT[headline.tone]}`}
									onClick={onOpenChecksTab}
								>
									{headlineLabel}
								</button>
							}
						/>
					)}
					{error && (
						<span className={PR_HEAD_ERROR} title={error}>
							{error}
						</span>
					)}
				{renderAction()}
			</div>
		);
	}

	// The primary row is the session's own branch — the one this worktree can
	// push, pull and merge. Its other PRs stack underneath, one row each.
	const primaryRow = (
		<div
			className={`pr-bar wco-chrome ${PR_BAR} ${PR_BAR_BG[headlineTone]} ${PR_BAR_IN_CARD}`}
		>
			{leading}
			{pr && (
				<PrStackChip
					pr={pr}
					tone={headlineTone}
					size="bar"
					headline={headlineLabel}
					repo={primaryRepoId}
					onOpenPr={(r, branch) => onOpenPrTab?.({ repo: r, branch })}
				/>
			)}
			{pr && (
				<PrNumberChip
					pr={pr}
					tone={headlineTone}
					size="bar"
					onOpenPrTab={() => onOpenPrTab?.()}
				/>
			)}
			{checksPr ? (
				<PrChecksPopover
					checks={checksPr.checks}
					trigger={
							<button
								type="button"
								className={`${PR_BAR_STATE} ${PR_BAR_STATE_TEXT[headlineTone]}`}
								onClick={onOpenChecksTab}
							>
							{headlineLabel}
						</button>
					}
				/>
			) : (headline.key !== "no-pr" || statusRows.length > 0) && (
				<Tooltip label="Open the PR tab">
					<button
						className={`${PR_BAR_STATE} ${PR_BAR_STATE_TEXT[headlineTone]}`}
						onClick={() => onOpenPrTab?.()}
					>
						{headlineLabel}
					</button>
				</Tooltip>
			)}
			<span className="flex-1" />
			{error && <span className={PR_BAR_ERROR} title={error}>{error}</span>}
			{renderAction()}
		</div>
	);
	if (statusRows.length === 0) return primaryRow;
	return (
		<div className={PR_BAR_STACK}>
			{primaryRow}
			<PrSeriesRows
				refs={statusRows}
				primaryRepo={primaryRepoId}
				onOpen={onOpenPrTab}
			/>
		</div>
	);
}
