import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PrDetails, WSServerMessage } from "../lib/types";
import {
	fetchModels,
	fetchPrPreview,
	fetchPrPreviewDiff,
	type ModelOption,
} from "../lib/api";
import { CheckRow, checkClass, isDeployment } from "./PrPanel";
import { CommentableDiff } from "./CommentableDiff";
import { Composer } from "./Composer";
import { useCurrentUser } from "./UserPicker";
import { renderMarkdown } from "../lib/markdown";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";

interface Props {
	/** Repo id (e.g. "tella-fusion") + the PR's head branch — the preview's key. */
	repo: string;
	branch: string;
	connected: boolean;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}

interface PrDiffData {
	number: number;
	headRefOid: string;
	patch: string;
}

/**
 * Session-less PR view: what a sidebar PR row opens when no chat exists for
 * the PR yet. Shows the PR's status/checks/description/diff straight from
 * repo+branch (no worktree involved), with a composer at the bottom — the
 * first message creates a real session on the PR's head branch
 * (`create_session` with `fromPr`), and App navigates into it on
 * `session_created` exactly like the Home ask box.
 */
export function PrPreview({ repo, branch, connected, send, addHandler }: Props) {
	const draftKey = `pr-preview:${repo}:${branch}`;
	const [pr, setPr] = useState<PrDetails | null>(null);
	const [diff, setDiff] = useState<PrDiffData | null>(null);
	const [loading, setLoading] = useState(true);
	const [prompt, setPrompt] = useState(() => loadDraft(draftKey).text);
	useEffect(() => {
		saveDraft(draftKey, { text: prompt });
	}, [draftKey, prompt]);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const startingRef = useRef(false);
	const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const [model, setModel] = useState(""); // "" = default
	const currentUser = useCurrentUser();

	const load = useCallback(async () => {
		try {
			const [prData, diffData] = await Promise.all([
				fetchPrPreview(repo, branch),
				fetchPrPreviewDiff(repo, branch).catch(() => null),
			]);
			setPr(prData);
			setDiff(diffData);
		} catch {
			setPr(null);
		} finally {
			setLoading(false);
		}
	}, [repo, branch]);

	useEffect(() => {
		setLoading(true);
		setPr(null);
		setDiff(null);
		load();
		const interval = setInterval(load, 60000);
		return () => clearInterval(interval);
	}, [load]);

	useEffect(() => {
		fetchModels()
			.then((m) => {
				setModels(m.models);
				setDefaultModel(m.default);
			})
			.catch(() => {});
	}, []);

	// Success navigates away on session_created (App handles it); on failure the
	// `starting` lock would stick forever — reset on server error or timeout
	// (same pattern as Home's ask box).
	useEffect(() => {
		return addHandler((msg) => {
			if (msg.type === "error" && startingRef.current) {
				clearTimeout(startTimer.current);
				startingRef.current = false;
				setStarting(false);
				setStartError(msg.message || "Failed to start the session.");
			} else if (msg.type === "session_created" && startingRef.current) {
				clearDraft(draftKey);
			}
		});
	}, [addHandler, draftKey]);
	useEffect(() => () => clearTimeout(startTimer.current), []);

	function handleStart() {
		const q = prompt.trim();
		if (!q || starting || !connected) return;
		setStarting(true);
		startingRef.current = true;
		setStartError(null);
		clearTimeout(startTimer.current);
		startTimer.current = setTimeout(() => {
			if (!startingRef.current) return;
			startingRef.current = false;
			setStarting(false);
			setStartError("Michael didn't respond — check the connection and try again.");
		}, 15_000);
		send({
			type: "create_session",
			mode: "code",
			repo,
			branch,
			fromPr: true,
			prompt: q,
			user: currentUser,
			// Every chat lives in a workspace from birth; name it after the PR so
			// the sidebar row reads as the PR (never auto-renamed — name is given).
			createWorkspace: { name: pr ? `PR #${pr.number}: ${pr.title}`.slice(0, 80) : branch },
			...(model ? { model } : {}),
		});
		// App navigates into the session on session_created
	}

	const checkSummary = useMemo(() => {
		const checks = pr?.checks || [];
		let passed = 0,
			failed = 0,
			pending = 0;
		for (const c of checks) {
			const cls = checkClass(c.status, c.conclusion);
			if (cls === "check-success") passed++;
			else if (cls === "check-failure") failed++;
			else if (cls === "check-pending") pending++;
		}
		const rank = (c: (typeof checks)[number]) => {
			const cls = checkClass(c.status, c.conclusion);
			return cls === "check-failure" ? 0 : cls === "check-pending" ? 1 : cls === "check-success" ? 3 : 2;
		};
		const sorted = [...checks].sort((a, b) => rank(a) - rank(b));
		return {
			passed,
			failed,
			pending,
			total: checks.length,
			deployments: sorted.filter(isDeployment),
			checks: sorted.filter((c) => !isDeployment(c)),
		};
	}, [pr]);

	const bodyHtml = useMemo(() => (pr?.body ? renderMarkdown(pr.body) : ""), [pr?.body]);

	const stateClass = pr
		? pr.state === "MERGED"
			? "pr-pill-merged"
			: pr.state === "CLOSED"
				? "pr-pill-closed"
				: pr.isDraft
					? "pr-pill-draft"
					: "pr-pill-open"
		: "";
	const stateLabel = pr
		? pr.state === "OPEN" && pr.isDraft
			? "Draft"
			: pr.state.charAt(0) + pr.state.slice(1).toLowerCase()
		: "";

	return (
		<div className="flex flex-col h-full min-h-0">
			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="w-full max-w-[860px] mx-auto px-5 py-6">
					{loading ? (
						<div className="panel-placeholder">Loading PR…</div>
					) : !pr ? (
						<div className="panel-placeholder">
							No PR found for <code>{branch}</code> in {repo} — it may have just
							merged or closed.
						</div>
					) : (
						<div className="pr-panel-info">
							<div className="pr-head">
								<span className={`pr-pill ${stateClass}`}>{stateLabel}</span>
								<a className="pr-number" href={pr.url} target="_blank" rel="noopener">
									#{pr.number}
								</a>
								<span className="text-faint text-[12px]">
									{repo} · {pr.author}
								</span>
							</div>

							<a className="pr-title" href={pr.url} target="_blank" rel="noopener">
								{pr.title}
							</a>

							<div className="pr-meta">
								<span className="pr-branch">
									{pr.headRefName} → {pr.baseRefName}
								</span>
								<span>
									{pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}{" "}
									<span className="diff-add">+{pr.additions}</span>{" "}
									<span className="diff-del">−{pr.deletions}</span>
								</span>
								{pr.reviewDecision && (
									<span className={`pr-review pr-review-${pr.reviewDecision.toLowerCase()}`}>
										{pr.reviewDecision.replaceAll("_", " ").toLowerCase()}
									</span>
								)}
							</div>

							{pr.checks.length > 0 && (
								<div className="pr-checks">
									<div className="pr-checks-summary" aria-disabled>
										<span
											className={`pr-checks-status ${
												checkSummary.failed > 0
													? "pr-sum-fail"
													: checkSummary.pending > 0
														? "pr-sum-pending"
														: "pr-sum-pass"
											}`}
										>
											{checkSummary.failed > 0
												? "Some checks failed"
												: checkSummary.pending > 0
													? "Checks running"
													: "All checks passed"}
										</span>
										<span className="pr-checks-counts">
											{checkSummary.passed > 0 && (
												<span className="pr-count check-success-text">✓ {checkSummary.passed}</span>
											)}
											{checkSummary.failed > 0 && (
												<span className="pr-count check-failure-text">✕ {checkSummary.failed}</span>
											)}
											{checkSummary.pending > 0 && (
												<span className="pr-count check-pending-text">● {checkSummary.pending}</span>
											)}
										</span>
									</div>
									{checkSummary.deployments.length > 0 && (
										<>
											<div className="pr-checks-group">Deployments</div>
											{checkSummary.deployments.map((check, i) => (
												<CheckRow key={`d${i}`} check={check} />
											))}
										</>
									)}
									{checkSummary.checks.length > 0 && (
										<>
											{checkSummary.deployments.length > 0 && (
												<div className="pr-checks-group">Checks</div>
											)}
											{checkSummary.checks.map((check, i) => (
												<CheckRow key={`c${i}`} check={check} />
											))}
										</>
									)}
								</div>
							)}

							{pr.body && (
								<div className="pr-body">
									<div className="pr-checks-title">Description</div>
									<div
										className="pr-body-md markdown"
										dangerouslySetInnerHTML={{ __html: bodyHtml }}
									/>
								</div>
							)}

							{diff?.patch && (
								<div className="pr-diff-section mt-4">
									<div className="pr-checks-title">Changes</div>
									<CommentableDiff
										patch={diff.patch}
										submitLabel="Add comment"
										placeholder=""
										disabled
										disabledHint="Start a session below to review this PR"
										onSubmit={async () => {}}
									/>
								</div>
							)}
						</div>
					)}
				</div>
			</div>

			<div className="w-full max-w-[860px] mx-auto px-5 pb-5 shrink-0">
				<Composer
					value={prompt}
					onChange={setPrompt}
					onSend={handleStart}
					placeholder={
						starting
							? "Starting…"
							: "Start a session on this PR…"
					}
					disabled={starting}
					sendDisabled={starting || !connected || !prompt.trim()}
					sendTitle="Start session on this PR (Enter)"
					models={models}
					defaultModel={defaultModel}
					model={model}
					onModelChange={setModel}
					modelTitle="Model for this session"
				/>
				{startError && <div className="ask-error">{startError}</div>}
			</div>
		</div>
	);
}
