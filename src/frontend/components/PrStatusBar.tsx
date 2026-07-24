import { AGENT_NAME } from "../lib/brand";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GitStatusInfo, PrDetails } from "../lib/types";
import {
	archiveSessionApi,
	closePrApi,
	fetchGitStatus,
	fetchPr,
	gitPullApi,
	gitPushApi,
	mergePrApi,
} from "../lib/api";
import { pollWhileVisible } from "../lib/poll";
import { getCurrentUser } from "./UserPicker";
import { providerFromUrl } from "../lib/provider";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu } from "../ui/menu";
import {
	IconArrowDown,
	IconArrowUp,
	IconArrowUpRight,
	IconPullRequest,
	IconGitMerge,
	IconCopy,
	IconHash,
	IconCheck,
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
		return { key: "ready", label: "Ready to merge", tone: "green" };
	}
	if (behind > 0)
		return {
			key: "behind",
			label: `Behind by ${behind} commit${behind === 1 ? "" : "s"}`,
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
	/** Prompt the session (Create PR / Resolve conflicts) — WS `prompt` message. */
	send?: (msg: any) => void;
	/** Clicking the headline jumps to the PR tab. */
	onOpenPrTab?: () => void;
	/** Archive via the owning viewer so it can select the neighboring sidebar row. */
	onArchive?: () => void;
	/** "header" renders just the PR chip + primary action for the chat header
	    (shown while the Workspace panel is closed); default is the full strip. */
	variant?: "bar" | "header";
	/** Optional element rendered inside the strip, left of the PR chip (bar
	    variant only) so it shares the strip's tone background — e.g. the globe
	    staging-deploy icon in the Workspace panel. */
	leading?: React.ReactNode;
	/** Live run state — when it falls from running→idle the header refetches, so
	    it reflects the just-finished turn (and any auto-push) without waiting on
	    the 45s poll. */
	running?: boolean;
	/** Bumped by the viewer on a `git_pushed` broadcast — an immediate refetch so
	    a server-side auto-push clears "Ahead by N commits" the moment it lands. */
	refreshTick?: number;
}

interface PrBarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	tone: "green" | "purple" | "red" | "secondary" | "solid";
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
	return (
		<button
			type="button"
			className={`pr-bar-btn pr-bar-btn-${tone}${confirm ? " pr-bar-btn-confirm" : ""}${className ? ` ${className}` : ""}`}
			{...props}
		>
			{icon && <span className="pr-bar-btn-icon">{icon}</span>}
			<span className="pr-bar-btn-label">{children}</span>
		</button>
	);
}

// Keyboard hint for the open-PR chord (SessionViewer owns the handler).
const PR_CHORD = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
	? "⌘G"
	: "Ctrl+G";

/**
 * The PR chip links to OpenSession's review by default. GitHub remains a
 * separate outbound action, while the context menu holds copy actions.
 */
function PrNumberChip({
	pr,
	tone,
	onOpenPrTab,
}: {
	pr: PrDetails;
	tone: PrHeadline["tone"];
	onOpenPrTab?: () => void;
}) {
	const [copied, setCopied] = useState<"link" | "number" | null>(null);
	const provider = providerFromUrl(pr.url);

	const copy = useCallback((kind: "link" | "number", text: string) => {
		navigator.clipboard?.writeText(text).then(() => {
			setCopied(kind);
			setTimeout(() => setCopied(null), 1500);
		});
	}, []);

	return (
		<div className="pr-num-chip-group">
			<ContextMenu.Root>
				<ContextMenu.Trigger
					render={
						<button
							type="button"
							className={`pr-num-chip pr-num-chip-${tone}`}
							onClick={onOpenPrTab}
							title={`Review #${pr.number}: ${pr.title}`}
						/>
					}
				>
					#{pr.number}
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
			<Tooltip label={`Open on ${provider.name} (${PR_CHORD})`}>
				<a
					className={`pr-num-chip-external pr-num-chip-${tone}`}
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
	send,
	onOpenPrTab,
	onArchive,
	variant = "bar",
	leading,
	running,
	refreshTick,
}: Props) {
	const cacheId = `${sessionId}\0${repo || ""}`;
	const seed = lastKnown.get(cacheId);
	const [pr, setPr] = useState<PrDetails | null>(seed?.pr ?? null);
	const [git, setGit] = useState<GitStatusInfo | null>(seed?.git ?? null);
	const [loaded, setLoaded] = useState(!!seed);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmMerge, setConfirmMerge] = useState(false);
	const [confirmClose, setConfirmClose] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isArchived, setIsArchived] = useState(!!archived);
	const [prompted, setPrompted] = useState<string | null>(null);

	useEffect(() => setIsArchived(!!archived), [archived]);

	const load = useCallback(async () => {
		const [prData, gitData] = await Promise.all([
			fetchPr(sessionId, repo).catch(() => null),
			fetchGitStatus(sessionId, repo).catch(() => null),
		]);
		setPr(prData);
		setGit(gitData);
		setLoaded(true);
		lastKnown.set(`${sessionId}\0${repo || ""}`, { pr: prData, git: gitData });
	}, [sessionId, repo]);

	useEffect(() => {
		// Session/repo switch on a mounted component: fall back to that target's
		// last-known state (or the checking placeholder) while the fetch runs.
		const cached = lastKnown.get(`${sessionId}\0${repo || ""}`);
		setPr(cached?.pr ?? null);
		setGit(cached?.git ?? null);
		setLoaded(!!cached);
		load();
		return pollWhileVisible(load, 45000);
	}, [load]);

	// Refetch the instant a turn ends (running→idle) or an auto-push lands
	// (refreshTick bump), so "Ahead by N commits" clears without waiting on the
	// 45s poll. Skip the initial mount/true edges — those are already covered by
	// the load() above. Track the previous run state so only the falling edge
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

	function handleMerge() {
		if (!confirmMerge) {
			setConfirmMerge(true);
			setTimeout(() => setConfirmMerge(false), 4000);
			return;
		}
		setConfirmMerge(false);
		run("merge", () => mergePrApi(sessionId, "squash", repo));
	}

	function handleClose() {
		if (!confirmClose) {
			setConfirmClose(true);
			setTimeout(() => setConfirmClose(false), 4000);
			return;
		}
		setConfirmClose(false);
		run("close", () => closePrApi(sessionId, repo));
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

	// The strip is a permanent fixture of the panel (Kent: a topbar that blinks
	// in and out of existence shouldn't exist). First visit with nothing known
	// yet holds its place with a quiet checking line instead of popping the bar
	// in seconds late (the PR fetch can take a GitHub round-trip); a clean
	// session reads "Up to date" rather than vanishing.
	if (!loaded && variant !== "header") {
		return (
			<div className="pr-bar pr-bar-muted">
				{leading}
				<span className="pr-bar-checking">Checking status…</span>
			</div>
		);
	}
	if (!loaded || (headline.key === "clean" && variant === "header"))
		return null;

	// Header mode: only once a PR exists — the chip is the anchor; a bare
	// Create PR/Push button in the chrome would just be noise.
	if (variant === "header" && !pr) return null;

	// Primary action for the current headline (right side of the strip).
	function renderAction(): React.ReactNode {
		if (prompted)
			return <span className="pr-bar-prompted">Asked {AGENT_NAME} to {prompted} ✓</span>;
		switch (headline.key) {
			case "merged":
				return isArchived ? null : (
					<PrBarButton
						tone="purple"
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
				);
			case "ahead":
				return (
					<PrBarButton
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
						tone="solid"
						icon={<IconArrowDown size={18} />}
						disabled={!!busy}
						title={
							headline.key === "behind-base"
								? `Fast-forward to origin/${git?.baseBranch || "main"}`
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
						tone="red"
						onClick={() =>
							promptSession(
								"resolve conflicts",
								`The PR has merge conflicts with ${pr?.baseRefName || git?.baseBranch || "main"}. Rebase this branch on the latest origin/${pr?.baseRefName || git?.baseBranch || "main"}, resolve the conflicts, and push.`,
							)
						}
					>
						Resolve
					</PrBarButton>
				) : null;
			case "no-pr":
				return send ? (
					<PrBarButton
						tone="secondary"
						icon={<IconPullRequest size={18} />}
						onClick={() =>
							promptSession(
								"create a PR",
								"Commit any remaining work, push the branch, and open a PR for it.",
							)
						}
					>
						Create PR
					</PrBarButton>
				) : null;
			case "ready":
			case "failing":
			case "running":
			case "changes-requested":
				return (
					<PrBarButton
						tone="green"
						confirm={confirmMerge}
						icon={!busy && !confirmMerge ? <IconGitMerge size={18} /> : undefined}
						disabled={!!busy}
						onClick={handleMerge}
						title="Squash and merge this PR into its base branch"
					>
						{busy === "merge"
							? "Merging…"
							: confirmMerge
								? "Confirm merge"
								: "Merge"}
					</PrBarButton>
				);
			default:
				return null;
		}
	}

	function renderCloseAction(): React.ReactNode {
		if (pr?.state !== "OPEN") return null;
		return (
			<PrBarButton
				tone={confirmClose ? "red" : "secondary"}
				icon={!busy && !confirmClose ? <IconX size={18} /> : undefined}
				disabled={!!busy}
				onClick={handleClose}
				title="Close this PR without merging it"
			>
				{busy === "close" ? "Closing…" : confirmClose ? "Confirm close" : "Close"}
			</PrBarButton>
		);
	}

	if (variant === "header") {
		return (
			<div className="pr-head">
				<PrNumberChip pr={pr!} tone={headline.tone} onOpenPrTab={onOpenPrTab} />
				{error && (
					<span className="pr-bar-error" title={error}>
						{error}
					</span>
				)}
				{renderCloseAction()}
				{renderAction()}
			</div>
		);
	}

	return (
		<div className={`pr-bar pr-bar-${headline.tone}`}>
			{leading}
			{pr && (
				<PrNumberChip pr={pr} tone={headline.tone} onOpenPrTab={onOpenPrTab} />
			)}
			{headline.key !== "no-pr" && (
				<Tooltip label="Open the PR tab">
					<button
						className={`pr-bar-state pr-bar-state-${headline.tone}`}
						onClick={onOpenPrTab}
					>
						{headline.label}
					</button>
				</Tooltip>
			)}
			<span className="pr-bar-spacer" />
			{error && <span className="pr-bar-error" title={error}>{error}</span>}
			{renderCloseAction()}
			{renderAction()}
		</div>
	);
}
