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

function summarizeChecks(pr: PrDetails | null): {
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
}

export function PrStatusBar({
	sessionId,
	repo,
	archived,
	send,
	onOpenPrTab,
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

	// Primary action for the current headline (right side of the strip).
	function renderAction(): React.ReactNode {
		if (prompted)
			return <span className="pr-bar-prompted">Asked Michael to {prompted} ✓</span>;
		switch (headline.key) {
			case "merged":
				return isArchived ? null : (
					<button
						className="pr-bar-btn pr-bar-btn-purple"
						disabled={!!busy}
						onClick={() =>
							run("archive", async () => {
								await archiveSessionApi(sessionId, true);
								setIsArchived(true);
							})
						}
					>
						{busy === "archive" ? "Archiving…" : "Archive"}
					</button>
				);
			case "ahead":
				return (
					<button
						className="pr-bar-btn pr-bar-btn-solid"
						disabled={!!busy}
						onClick={() => run("push", () => gitPushApi(sessionId, repo))}
					>
						{busy === "push" ? "Pushing…" : "↑ Push"}
					</button>
				);
			case "conflicts":
				return send ? (
					<button
						className="pr-bar-btn pr-bar-btn-red"
						onClick={() =>
							promptSession(
								"resolve conflicts",
								`The PR has merge conflicts with ${pr?.baseRefName || git?.baseBranch || "main"}. Rebase this branch on the latest origin/${pr?.baseRefName || git?.baseBranch || "main"}, resolve the conflicts, and push.`,
							)
						}
					>
						Resolve
					</button>
				) : null;
			case "no-pr":
				return send ? (
					<button
						className="pr-bar-btn pr-bar-btn-solid"
						onClick={() =>
							promptSession(
								"create a PR",
								"Commit any remaining work, push the branch, and open a PR for it.",
							)
						}
					>
						⑂ Create PR
					</button>
				) : null;
			case "ready":
			case "failing":
			case "running":
			case "changes-requested":
				return (
					<button
						className={`pr-bar-btn pr-bar-btn-green ${confirmMerge ? "pr-bar-btn-confirm" : ""}`}
						disabled={!!busy}
						onClick={handleMerge}
						title="Squash and merge this PR into its base branch"
					>
						{busy === "merge"
							? "Merging…"
							: confirmMerge
								? "Confirm merge"
								: "⑂ Merge"}
					</button>
				);
			default:
				return null;
		}
	}

	return (
		<div className={`pr-bar pr-bar-${headline.tone}`}>
			{pr && (
				<a
					className={`pr-bar-number pr-bar-number-${headline.tone}`}
					href={pr.url}
					target="_blank"
					rel="noopener"
					title={pr.title}
				>
					#{pr.number} <span className="pr-bar-arrow">↗</span>
				</a>
			)}
			<Tooltip label="Open the PR tab">
				<button
					className={`pr-bar-state pr-bar-state-${headline.tone}`}
					onClick={onOpenPrTab}
				>
					{headline.label}
				</button>
			</Tooltip>
			<span className="pr-bar-spacer" />
			{error && <span className="pr-bar-error" title={error}>{error}</span>}
			{renderAction()}
		</div>
	);
}
