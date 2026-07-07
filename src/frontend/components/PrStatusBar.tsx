import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GitStatusInfo, PrDetails } from "../lib/types";
import {
	archiveSessionApi,
	fetchGitStatus,
	fetchPr,
	gitPushApi,
	mergePrApi,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu } from "../ui/menu";
import {
	IconArrowUp,
	IconArrowUpRight,
	IconPullRequest,
	IconGitMerge,
	IconCopy,
	IconHash,
	IconCheck,
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
		| "behind"
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
	if (pr) {
		if (pr.state === "MERGED") return { key: "merged", label: "Merged", tone: "purple" };
		if (pr.state === "CLOSED") return { key: "closed", label: "Closed", tone: "muted" };
		if (ahead > 0)
			return {
				key: "ahead",
				label: `Ahead by ${ahead} commit${ahead === 1 ? "" : "s"}`,
				tone: "yellow",
			};
		if (pr.mergeable === "CONFLICTING")
			return { key: "conflicts", label: "Merge conflicts", tone: "red" };
		const checks = summarizeChecks(pr);
		if (checks.failed > 0) return { key: "failing", label: "Checks failed", tone: "red" };
		if (checks.pending > 0)
			return { key: "running", label: "Checks running", tone: "yellow" };
		if (pr.isDraft) return { key: "draft", label: "Draft", tone: "muted" };
		if (pr.reviewDecision === "CHANGES_REQUESTED")
			return { key: "changes-requested", label: "Changes requested", tone: "red" };
		return { key: "ready", label: "Ready to merge", tone: "green" };
	}
	if (ahead > 0 || (git?.uncommittedFiles ?? 0) > 0)
		return { key: "no-pr", label: "No PR open", tone: "muted" };
	if ((git?.behindBase ?? 0) > 0)
		return {
			key: "behind",
			label: `${git!.behindBase} commit${git!.behindBase === 1 ? "" : "s"} behind ${git!.baseBranch}`,
			tone: "muted",
		};
	return { key: "clean", label: "", tone: "muted" };
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
	/** "header" renders just the PR chip + primary action for the chat header
	    (shown while the Workspace panel is closed); default is the full strip. */
	variant?: "bar" | "header";
	/** Optional element rendered inside the strip, left of the PR chip (bar
	    variant only) so it shares the strip's tone background — e.g. the globe
	    staging-deploy icon in the Workspace panel. */
	leading?: React.ReactNode;
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

/**
 * The PR chip: a single linked pill — `#1234 ↗`. Left-click opens the PR on
 * GitHub (the trailing arrow marks it as an outbound link); right-click opens a
 * context menu with the secondary actions (Open in GitHub / Copy link / Copy
 * number). This replaced the old segmented split button — one target, no
 * divider, and the less-common copy actions tuck into the menu.
 */
function PrNumberChip({
	pr,
	tone,
}: {
	pr: PrDetails;
	tone: PrHeadline["tone"];
}) {
	const [copied, setCopied] = useState<"link" | "number" | null>(null);

	const copy = useCallback((kind: "link" | "number", text: string) => {
		navigator.clipboard?.writeText(text).then(() => {
			setCopied(kind);
			setTimeout(() => setCopied(null), 1500);
		});
	}, []);

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger
				render={
					<a
						className={`pr-num-chip pr-num-chip-${tone}`}
						href={pr.url}
						target="_blank"
						rel="noopener"
						title={`#${pr.number} ${pr.title}`}
					/>
				}
			>
				#{pr.number}
				<IconArrowUpRight size={20} className="pr-num-chip-arrow" />
			</ContextMenu.Trigger>
			<ContextMenu.Popup>
				<ContextMenu.Item
					render={<a href={pr.url} target="_blank" rel="noopener" />}
				>
					<IconArrowUpRight size={20} />
					<span className="grow">Open in GitHub</span>
				</ContextMenu.Item>
				<ContextMenu.Item
					closeOnClick={false}
					onClick={() => copy("link", pr.url)}
				>
					{copied === "link" ? <IconCheck size={20} /> : <IconCopy size={20} />}
					<span className="grow">{copied === "link" ? "Copied" : "Copy link"}</span>
				</ContextMenu.Item>
				<ContextMenu.Item
					closeOnClick={false}
					onClick={() => copy("number", `#${pr.number}`)}
				>
					{copied === "number" ? <IconCheck size={20} /> : <IconHash size={20} />}
					<span className="grow">
						{copied === "number" ? "Copied" : "Copy number"}
					</span>
				</ContextMenu.Item>
			</ContextMenu.Popup>
		</ContextMenu.Root>
	);
}

export function PrStatusBar({
	sessionId,
	repo,
	archived,
	send,
	onOpenPrTab,
	variant = "bar",
	leading,
}: Props) {
	const [pr, setPr] = useState<PrDetails | null>(null);
	const [git, setGit] = useState<GitStatusInfo | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmMerge, setConfirmMerge] = useState(false);
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
	}, [sessionId, repo]);

	useEffect(() => {
		setLoaded(false);
		setPr(null);
		setGit(null);
		load();
		const interval = setInterval(load, 45000);
		return () => clearInterval(interval);
	}, [load]);

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

	// Session-driven actions: ask Michael instead of doing bare git plumbing —
	// a session-authored PR gets a real title/description, and conflict
	// resolution needs judgment, not a button.
	function promptSession(label: string, content: string) {
		if (!send) return;
		send({ type: "prompt", sessionId, user: getCurrentUser(), content });
		setPrompted(label);
		setTimeout(() => setPrompted(null), 6000);
	}

	// No flash of an empty strip while loading; nothing to say once loaded
	// (no PR, no local commits, clean tree) also keeps the chrome quiet.
	if (!loaded || headline.key === "clean") return null;

	// Header mode: only once a PR exists — the chip is the anchor; a bare
	// Create PR/Push button in the chrome would just be noise.
	if (variant === "header" && !pr) return null;

	// Primary action for the current headline (right side of the strip).
	function renderAction(): React.ReactNode {
		if (prompted)
			return <span className="pr-bar-prompted">Asked Michael to {prompted} ✓</span>;
		switch (headline.key) {
			case "merged":
				return isArchived ? null : (
					<PrBarButton
						tone="purple"
						disabled={!!busy}
						onClick={() =>
							run("archive", async () => {
								await archiveSessionApi(sessionId, true);
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

	if (variant === "header") {
		return (
			<div className="pr-head">
				<PrNumberChip pr={pr!} tone={headline.tone} />
				{error && (
					<span className="pr-bar-error" title={error}>
						{error}
					</span>
				)}
				{renderAction()}
			</div>
		);
	}

	return (
		<div className={`pr-bar pr-bar-${headline.tone}`}>
			{leading}
			{pr && <PrNumberChip pr={pr} tone={headline.tone} />}
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
			{renderAction()}
		</div>
	);
}
