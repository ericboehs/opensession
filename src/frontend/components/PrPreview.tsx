import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	DiffFileGroup,
	PrDetails,
	UnifiedSession,
	WSServerMessage,
} from "../lib/types";
import {
	API_BASE,
	closePrPreviewApi,
	fetchModels,
	fetchPrPreview,
	fetchPrPreviewDiff,
	fetchPrPreviewDiffGroups,
	fetchPrPreviewGuide,
	relativeTime,
	type ModelOption,
} from "../lib/api";
import { IconX } from "./icons";
import {
	CheckRow,
	checkClass,
	isDeployment,
	sectionsWithPatches,
	type ReviewGuideData,
} from "./PrPanel";
import { CommentableDiff } from "./CommentableDiff";
import { Composer } from "./Composer";
import { useCurrentUser } from "./UserPicker";
import { renderMarkdown } from "../lib/markdown";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { chatPath } from "../lib/share-link";

interface Props {
	/** Repo id (e.g. "tella-fusion") + the PR's head branch — the preview's key. */
	repo: string;
	branch: string;
	connected: boolean;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	/** Live sessions list — used to surface chats related to this PR. */
	sessions: UnifiedSession[];
	onOpenSession: (id: string) => void;
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
export function PrPreview({
	repo,
	branch,
	connected,
	send,
	addHandler,
	sessions,
	onOpenSession,
}: Props) {
	const draftKey = `pr-preview:${repo}:${branch}`;
	const [pr, setPr] = useState<PrDetails | null>(null);
	const [diff, setDiff] = useState<PrDiffData | null>(null);
	const [diffGroups, setDiffGroups] = useState<{
		oid: string;
		groups: DiffFileGroup[] | null;
	} | null>(null);
	const [diffGroupsLoading, setDiffGroupsLoading] = useState(false);
	const [diffGroupsRetry, setDiffGroupsRetry] = useState(0);
	const [tab, setTab] = useState<"overview" | "changes" | "guide">("overview");
	const [guide, setGuide] = useState<ReviewGuideData | null>(null);
	const [guideLoading, setGuideLoading] = useState(false);
	const [guideFailed, setGuideFailed] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [diffLoading, setDiffLoading] = useState(true);
	const [diffError, setDiffError] = useState<string | null>(null);
	const loadGenerationRef = useRef(0);
	const [prompt, setPrompt] = useState(() => loadDraft(draftKey).text);
	useEffect(() => {
		saveDraft(draftKey, { text: prompt });
	}, [draftKey, prompt]);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [closing, setClosing] = useState(false);
	const [confirmClose, setConfirmClose] = useState(false);
	const [closeError, setCloseError] = useState<string | null>(null);
	const startingRef = useRef(false);
	const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const [model, setModel] = useState(""); // "" = default
	const currentUser = useCurrentUser();

	const load = useCallback(async () => {
		const generation = ++loadGenerationRef.current;
		const isCurrent = () => generation === loadGenerationRef.current;
		setDiffLoading(true);
		const diffRequest = fetchPrPreviewDiff(repo, branch)
			.then((data) => {
				if (isCurrent()) {
					setDiff(data);
					setDiffError(null);
				}
				return data;
			})
			.catch((e: any) => {
				if (isCurrent()) {
					setDiff(null);
					setDiffError(e?.message || "Failed to load pull request changes.");
				}
				return null;
			})
			.finally(() => {
				if (isCurrent()) setDiffLoading(false);
			});
		try {
			const [prData] = await Promise.all([fetchPrPreview(repo, branch), diffRequest]);
			if (!isCurrent()) return;
			setPr(prData);
			setLoadError(null);
		} catch (e: any) {
			if (isCurrent()) setLoadError(e?.message || "Failed to load the pull request.");
		} finally {
			if (isCurrent()) setLoading(false);
		}
	}, [repo, branch]);

	useEffect(() => {
		setLoading(true);
		setLoadError(null);
		setDiffLoading(true);
		setDiffError(null);
		setPr(null);
		setDiff(null);
		load();
		const interval = setInterval(load, 60000);
		return () => {
			clearInterval(interval);
			loadGenerationRef.current += 1;
		};
	}, [load]);

	useEffect(() => {
		const files = pr?.files || [];
		if (!diff?.patch || files.length < 3) {
			setDiffGroups(null);
			setDiffGroupsLoading(false);
			return;
		}
		setDiffGroups(null);
		setDiffGroupsLoading(true);
		let live = true;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const retryLater = () => {
			retryTimer = setTimeout(() => setDiffGroupsRetry((attempt) => attempt + 1), 125_000);
		};
		fetchPrPreviewDiffGroups(repo, files, diff.patch)
			.then((result) => {
				if (!live) return;
				setDiffGroups({ oid: diff.headRefOid, groups: result.groups });
				if (!result.groups) retryLater();
			})
			.catch(() => {
				if (!live) return;
				setDiffGroups({ oid: diff.headRefOid, groups: null });
				retryLater();
			})
			.finally(() => {
				if (live) setDiffGroupsLoading(false);
			});
		return () => {
			live = false;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [repo, branch, diff?.headRefOid, pr?.files?.length, diffGroupsRetry]);

	useEffect(() => {
		fetchModels()
			.then((m) => {
				setModels(m.models);
				setDefaultModel(m.default);
			})
			.catch(() => {});
	}, []);

	const loadGuide = useCallback(async () => {
		setGuideLoading(true);
		setGuideFailed(false);
		try {
			const data = await fetchPrPreviewGuide(repo, branch);
			if (data) setGuide(data);
			else setGuideFailed(true);
		} catch {
			setGuideFailed(true);
		} finally {
			setGuideLoading(false);
		}
	}, [repo, branch]);

	// The guide is generated on demand (the first request per head commit takes
	// the model a while) — only fetch once the Guide tab opens, and refetch when
	// the head moves (same pattern as PrPanel).
	useEffect(() => {
		if (tab !== "guide" || !diff?.patch) return;
		if (guideLoading || guideFailed) return;
		if (guide && guide.headRefOid === diff.headRefOid) return;
		void loadGuide();
	}, [tab, diff?.patch, diff?.headRefOid, guide, guideLoading, guideFailed, loadGuide]);

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
			setStartError("Michael didn't respond. Check your connection and try again.");
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

	async function handleClose() {
		if (!confirmClose) {
			setConfirmClose(true);
			setTimeout(() => setConfirmClose(false), 4000);
			return;
		}
		setConfirmClose(false);
		setClosing(true);
		setCloseError(null);
		try {
			await closePrPreviewApi(repo, branch);
			await load();
		} catch (e: any) {
			setCloseError(e.message || "Failed to close the pull request.");
		} finally {
			setClosing(false);
		}
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

	// Old/new image URLs for binary files in the diff — shared by the Changes
	// and Guide views.
	const prImageSrcs = useCallback(
		(file: { name: string; prevName?: string }) => {
			const src = (ref: string, p: string) =>
				`${API_BASE}/pr-image?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(p)}`;
			return {
				oldSrc: pr?.baseRefName
					? src(pr.baseRefName, file.prevName || file.name)
					: undefined,
				newSrc: pr?.headRefName ? src(pr.headRefName, file.name) : undefined,
			};
		},
		[repo, pr?.baseRefName, pr?.headRefName],
	);

	// Sessions related to this PR: primarily via the server-enriched `prs` refs
	// (primary + attached + linked), with primary-branch/number fallbacks for
	// sessions the enrichment hasn't reached. Matching also uses the loaded PR's
	// number and head branch, so /pr/<repo>/<number> URLs (gh resolves either a
	// branch or a number) link the same sessions as branch URLs.
	const relatedSessions = useMemo(() => {
		const num = pr?.number;
		const head = pr?.headRefName;
		const refMatch = (r: { repo: string; branch?: string; number?: number }) =>
			r.repo === repo &&
			((num != null && r.number === num) ||
				r.branch === branch ||
				(!!head && r.branch === head));
		const matched = sessions.filter((s) => {
			if (s.sideChatOf) return false;
			if ((s.prs || []).some(refMatch)) return true;
			if ((s.linkedPrs || []).some(refMatch)) return true;
			const sRepo = s.repo || "tella-fusion";
			if (sRepo === repo && (s.branch === branch || (!!head && s.branch === head)))
				return true;
			if (num != null && sRepo === repo && s.prNumber === num) return true;
			return (s.attachedRepos || []).some(
				(a) => a.repo === repo && (a.branch === branch || (!!head && a.branch === head)),
			);
		});
		return matched.sort((a, b) => {
			if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
			return (b.lastActivity || "").localeCompare(a.lastActivity || "");
		});
	}, [sessions, repo, branch, pr?.number, pr?.headRefName]);

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
					) : loadError && !pr ? (
						<div className="panel-placeholder panel-error">
							<div>{loadError}</div>
							<button
								className="mt-3 rounded-sm border border-line bg-panel px-3 py-1.5 text-xs text-fg hover:bg-hover"
								onClick={() => {
									setLoading(true);
									setLoadError(null);
									void load();
								}}
							>
								Retry
							</button>
						</div>
					) : !pr ? (
						<div className="panel-placeholder">
							No PR found for <code>{branch}</code> in {repo}. It may have just
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
								{pr.state === "OPEN" && (
									<button
										type="button"
										className={`pr-bar-btn ${confirmClose ? "pr-bar-btn-red" : "pr-bar-btn-secondary"}`}
										disabled={closing}
										onClick={handleClose}
										title="Close this PR without merging it"
									>
										{!closing && !confirmClose && <IconX size={16} />}
										{closing ? "Closing…" : confirmClose ? "Confirm close" : "Close"}
									</button>
								)}
							</div>
							{closeError && <div className="pr-bar-error mt-2">{closeError}</div>}

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

							{/* Floating pill tabs (same pattern as the session panel). The
							    strip's panel-context padding is cancelled so the first pill's
							    label lands on the page's content edge. */}
							<div className="panel-tabs px-0 -mx-3 pt-3 pb-1">
								<button
									className={`panel-tab ${tab === "overview" ? "active" : ""}`}
									onClick={() => setTab("overview")}
								>
									Overview
								</button>
								<button
									className={`panel-tab ${tab === "changes" ? "active" : ""}`}
									onClick={() => setTab("changes")}
								>
									Changes
									{pr.changedFiles > 0 && (
										<span className="panel-tab-count">{pr.changedFiles}</span>
									)}
								</button>
								<button
									className={`panel-tab ${tab === "guide" ? "active" : ""}`}
									onClick={() => setTab("guide")}
								>
									Guide
								</button>
							</div>

							{tab === "overview" ? (
								<>
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

									{relatedSessions.length > 0 && (
										<div className="pr-body">
											<div className="pr-checks-title">Sessions</div>
											<div className="flex flex-col">
												{relatedSessions.map((s) => (
													<a
														key={s.id}
														href={chatPath(s)}
														onClick={(e) => {
															// Plain click navigates in-app; modified clicks
															// keep native new-tab behavior.
															if (e.metaKey || e.ctrlKey || e.shiftKey) return;
															e.preventDefault();
															onOpenSession(s.id);
														}}
														className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-md text-[13px] text-fg no-underline hover:bg-surface"
													>
														<span
															className={`w-1.5 h-1.5 rounded-full shrink-0 ${
																s.isRunning ? "bg-green animate-pulse" : "bg-line"
															}`}
														/>
														<span className="truncate">{s.title}</span>
														{s.archived && (
															<span className="text-faint text-[11px] shrink-0">
																archived
															</span>
														)}
														{s.startedBy && (
															<span className="text-faint text-[12px] shrink-0">
																{s.startedBy}
															</span>
														)}
														<span className="text-faint text-[12px] shrink-0 ml-auto">
															{relativeTime(s.lastActivity)}
														</span>
													</a>
												))}
											</div>
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
								</>
							) : tab === "guide" ? (
								!diff?.patch ? (
									<div className={`panel-placeholder ${!diffLoading && diffError ? "panel-error" : ""}`}>
										<div>
											{diffLoading
												? "Loading pull request changes…"
												: diffError || "No text diff is available for this PR."}
										</div>
										{!diffLoading && diffError && (
											<button
												className="mt-3 rounded-sm border border-line bg-panel px-3 py-1.5 text-xs text-fg hover:bg-hover"
												onClick={() => {
													setDiffLoading(true);
													setDiffError(null);
													void load();
												}}
											>
												Retry
											</button>
										)}
									</div>
								) : guideLoading ? (
									<div className="pr-guide-status">Writing the review guide…</div>
								) : guideFailed ? (
									<div className="pr-guide-status">
										Couldn't generate a guide for this PR.
										<button className="prc-show-more" onClick={() => void loadGuide()}>
											Retry
										</button>
									</div>
								) : guide ? (
									<div className="pr-diff-section">
										{sectionsWithPatches(guide, diff.patch).map((section, i, all) => (
											<div className="pr-guide-section" key={`${section.title}-${i}`}>
												<div className="pr-guide-count">
													{String(i + 1).padStart(2, "0")} /{" "}
													{String(all.length).padStart(2, "0")}
												</div>
												<div className="pr-guide-title">{section.title}</div>
												<div className="pr-guide-expl">{section.explanation}</div>
												{section.patch && (
													<CommentableDiff
														patch={section.patch}
														submitLabel="Add comment"
														placeholder=""
														disabled
														disabledHint="Start a session below to review this PR"
														onSubmit={async () => {}}
														imageSrcs={prImageSrcs}
													/>
												)}
											</div>
										))}
									</div>
								) : null
							) : diff?.patch ? (
								<div className="pr-diff-section">
									<CommentableDiff
										patch={diff.patch}
										groups={
											diffGroups?.oid === diff.headRefOid
												? diffGroups.groups || undefined
												: undefined
										}
										groupsLoading={diffGroupsLoading}
										submitLabel="Add comment"
										placeholder=""
										disabled
										disabledHint="Start a session below to review this PR"
										onSubmit={async () => {}}
										imageSrcs={prImageSrcs}
									/>
								</div>
							) : (
								<div className={`panel-placeholder ${!diffLoading && diffError ? "panel-error" : ""}`}>
									<div>
										{diffLoading
											? "Loading pull request changes…"
											: diffError || "No text diff is available for this PR."}
									</div>
									{!diffLoading && diffError && (
										<button
											className="mt-3 rounded-sm border border-line bg-panel px-3 py-1.5 text-xs text-fg hover:bg-hover"
											onClick={() => {
												setDiffLoading(true);
												setDiffError(null);
												void load();
											}}
										>
											Retry
										</button>
									)}
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
