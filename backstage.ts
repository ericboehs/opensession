#!/usr/bin/env bun

import { randomUUIDv7 } from "bun";
import { BACKSTAGE_CHATS_DIR } from "./src/server/paths";
import {
	mkdirSync,
	existsSync,
	writeFileSync,
	readFileSync,
	copyFileSync,
	realpathSync,
	statSync,
	watch,
} from "fs";
import homepage from "./src/frontend/index.html";
import {
	getAllSessions,
	getOpenPrs,
	deleteSession,
	getTranscriptPath,
	getEngineTranscriptPath,
	engineSessionPatch,
} from "./src/server/sessions";
import {
	parseTranscript,
	parseTranscriptTail,
	transcriptMatchSnippet,
} from "./src/server/jsonl-parser";
import {
	buildForkHandoffNote,
	buildEngineSwitchHandoffNote,
	buildChatContextNote,
} from "./src/server/fork-handoff";
import { wrapContext, stripContext } from "./src/server/prompt-context";
import {
	buildWorkspaceOverview,
	resolveTranscriptImage,
} from "./src/server/workspace-overview";
import { getSubagentTranscript } from "./src/server/subagents";
import {
	startWatching,
	stopAllWatchesForClient,
	setTranscriptAppendListener,
} from "./src/server/file-watcher";
import {
	listWorktrees,
	createWorktree,
	createWorktreeForExistingBranch,
	worktreePathFor,
	removeWorktree,
	reviveWorktree,
	sweepArchivedWorktrees,
	getRepo,
	repoForPath,
	prepareAttachedWorktree,
	worktreeHasWork,
	REPOS,
} from "./src/server/worktree";
import { effectiveSandboxProvider, sandboxesEnabled, sandboxConfig } from "./src/server/sandbox/config";
import {
	getSandboxProvider,
	workspaceExecFor,
	hasRemoteWorkspace,
	type Sandbox,
} from "./src/server/sandbox";
import { dockerContainerStatus } from "./src/server/sandbox/docker";
import type { RunHostSpec } from "./src/runner-host/protocol";
import {
	STRIPE_CONFIRM_TOOLS,
	activeRunRecords,
} from "./src/server/claude-runner";
import { buildSystemPromptParts } from "./src/server/system-prompt";
import {
	runAgent,
	isAgentSessionBusy,
	markSessionStarting,
	unmarkSessionStarting,
	cancelAgentRun,
	steerAgentRun,
	interruptAgentRun,
	stopAgentRunTurn,
	interruptAndSteerAgentRun,
	resumeInterruptedRuns,
	RESUME_CONTINUATION_PROMPT,
	activeAgentRunCount,
	type StreamEvent,
} from "./src/server/agent-runner";
import {
	writeFileAtomic,
	writeJsonAtomic,
} from "./src/server/shared/atomic-write";
import type { ImageInput } from "./src/server/claude-runner";
import type { ActiveRunRecord } from "./src/server/claude-runner";
import {
	getPins as getUserPins,
	setPins as setUserPins,
} from "./src/server/pins";
import {
	listWorkspaces,
	getWorkspace,
	createWorkspace,
	updateWorkspace,
	deleteWorkspace,
	findWorkspaceByWorktree,
	type Workspace,
} from "./src/server/workspaces";
import {
	getTabColors as getUserTabColors,
	setTabColors as setUserTabColors,
} from "./src/server/tab-colors";
import {
	KNOWN_MODELS,
	getDefaultModel,
	setDefaultModel,
	resolveModel,
	providerFor,
	modelLabel,
	contextWindowFor,
	formatModelList,
	DEFAULT_FALLBACK_MODEL,
	interactiveFallbackModel,
	getModelFallbackAuto,
	setModelFallbackAuto,
} from "./src/server/models";
import {
	listCodexAccountsPublic,
	addCodexAccount,
	removeCodexAccount,
} from "./src/server/codex-accounts";
import { getSessionDiff, discardSessionFile, type SessionDiff } from "./src/server/git-diff";
import { searchRepoFiles } from "./src/server/file-index";
import { searchSkills } from "./src/server/skills";
import { suggestBranchName } from "./src/server/suggest-branch";
import { transcribeAudio, MAX_AUDIO_BYTES } from "./src/server/transcribe";
import {
	getPreviewStatus,
	startPreview,
	stopPreview,
	getSandboxPreviewStatus,
	startSandboxPreview,
	stopSandboxPreview,
} from "./src/server/preview";
import {
	registerSessionControl,
	getSessionControl,
	type SessionState,
	type SessionSummary,
} from "./src/server/session-control";
import {
	registerInteractiveMcpBuilder,
	startRunRpcServer,
	registerRunToken,
	unregisterRunToken,
} from "./src/server/run-rpc";
import {
	handleSandboxWsUpgrade,
	sandboxWsOpen,
	sandboxWsMessage,
	sandboxWsClose,
} from "./src/server/run-ws";
import {
	startTerminal,
	writeTerminal,
	resizeTerminal,
	stopTerminal,
} from "./src/server/terminals";
import {
	listScans,
	deleteScan,
	listProfiles,
	getProfile,
	createProfile,
	updateProfile,
	deleteProfile,
	scannableRepos,
	buildScanPrompt,
	buildInteractivePrompt,
	createScanRecord,
	executeScan,
} from "./src/server/security";
import {
	gitIdentityFor,
	resolveTeammate,
	githubLoginFor,
} from "./src/server/shared/user-mappings";
import { createSessionsMcpServer } from "./src/agents/slack/sessions-tools";
import { createAdminMcpServer } from "./src/agents/slack/admin-tools";
import { createHumansMcpServer } from "./src/agents/slack/humans-tools";
import { createAskUserMcpServer } from "./src/agents/slack/ask-tools";
import { createReposMcpServer } from "./src/agents/slack/repos-tools";
import { createPreviewMcpServer } from "./src/agents/slack/preview-tools";
import {
	createGoalsMcpServer,
	createGoalSelfMcpServer,
} from "./src/agents/slack/goal-tools";
import {
	listGoals,
	getGoal,
	saveGoal,
	createGoal,
	updateGoal,
	deleteGoal,
	resumeGoal,
	type Goal,
} from "./src/server/goals";
import {
	initHumanAsks,
	onSessionIdle as onHumanAsksSessionIdle,
	registerAsk,
	awaitBlockingAnswer,
	cancelAsk,
} from "./src/server/human-asks";
import {
	getPrDetails,
	getPrDiff,
	postPrComment,
	submitPrReview,
	mergePr,
	editPrReviewers,
} from "./src/server/pr-info";
import {
	listTinderPrs,
	listTinderLabels,
	getSeenPrs,
	markPrSeen,
	markPrUnseen,
	closeTinderPr,
	reopenTinderPr,
	commentTinderPr,
	deleteTinderComment,
	labelTinderPr,
} from "./src/server/pr-tinder";
import { getGitStatus, gitPull, gitPush } from "./src/server/git-status";
import {
	listAutomations,
	getAutomation,
	createAutomation,
	updateAutomation,
	deleteAutomation,
	runAutomation,
	isAutomationRunning,
	startScheduler,
	getWebhookRoutes,
	setEventSessionCallback,
	automationDeniedTools,
	automationMcpServersByName,
} from "./src/server/automations";
import { AUTOMATION_TEMPLATES } from "./src/server/automation-templates";
import { draftAutomation } from "./src/server/draft-automation";
import {
	listActions,
	getAction,
	createAction,
	deleteAction,
	runAction,
	introspectScript,
	ensureSeedActions,
} from "./src/server/actions";
import { getWikiTree, getWikiFile, searchWiki } from "./src/server/wiki";
import {
	listNotes,
	createNote,
	deleteNote,
	getNoteState,
	applyNoteUpdate,
	getNoteText,
	setNoteText,
	seedIfEmpty,
	isValidNoteId,
} from "./src/server/notes";
import { editNote } from "./src/server/note-edit";
import {
	sessionForChannel,
	linkInIndex,
	unlinkInIndex,
	rebuildIndex,
	registerLinkedChannelSink,
} from "./src/server/slack-links";
import {
	fetchChannelHistory,
	postChannelMessageAs,
	resolveSlackUser,
	getChannelName,
	sendSlackMessage,
} from "./src/agents/slack/slack-api";
import {
	createSlackChannel,
	inviteBotToChannel,
	setChannelTopic,
	findSlackChannel,
} from "./src/agents/slack/worktree-channels";
import { startPlainArchiveSweep, clearSessionFileArchive } from "./src/server/plain-archive";
import { setArchived, archiveOlderThan, unpinArchivedSessions } from "./src/server/archive";
import {
	getAutoArchiveConfig,
	setAutoArchiveConfig,
	startAutoArchiveSweep,
} from "./src/server/auto-archive";
import { setTitleOverride, getTitleOverride } from "./src/server/title-overrides";
import { setStatusOverride, isManualStatus } from "./src/server/status-overrides";
import {
	setReviewRequest,
	getReviewRequest,
	setReviewAccepted,
} from "./src/server/review-requests";
import { ensureGeneratedTitle } from "./src/server/generated-titles";
import {
	getConnections,
	addMcpServer,
	removeMcpServer,
	setMcpAllowedUsers,
} from "./src/server/connections";
import {
	listAccountsPublic,
	addAccount,
	removeAccount,
	setAccountOwner,
	refreshAllUsage,
	startUsagePoller,
	type ClaudeAccountPublic,
} from "./src/server/claude-accounts";
import { startWebhookServer } from "./src/server/webhook-server";
import type { AgentModule } from "./src/agents/types";
import type {
	UnifiedSession,
	BackstageSessionFile,
	AttachedRepo,
	SessionUsage,
} from "./src/server/types";
import type { TurnUsage } from "./src/server/claude-runner";

const PORT = parseInt(process.env.PORT || "3850");
const HOST = process.env.HOST || "127.0.0.1";
const HOME = process.env.HOME || "/home/ubuntu";
const BACKSTAGE_SESSIONS_DIR = BACKSTAGE_CHATS_DIR;

mkdirSync(BACKSTAGE_SESSIONS_DIR, { recursive: true });

// --- Hot-reload support (bun --hot) ---------------------------------------
// Under `bun --hot`, editing a module re-evaluates this entry file in the SAME
// process, preserving `globalThis`. We exploit that so simple tweaks apply
// without dropping WebSocket clients or killing in-flight runs: live state
// (watchers, pending questions, queues) is parked on globalThis so the fresh
// module binding reuses the same instances, the HTTP/WS server is reloaded in
// place rather than rebound, and all one-time setup (agents, schedulers, timers,
// signal handlers) is guarded behind `__backstageBooted` so it never stacks.
// Long-lived agent *loop code* still needs a real restart — but that's now
// graceful (see SIGTERM handler below). A plain `bun run` (no --hot) just runs
// each branch once, exactly as before.
const g = globalThis as any;

// Unique per OS process (survives hot reloads, changes on a real restart) so
// clients can tell a fresh instance from a draining one and reload at the right
// moment. Every connected WebSocket is also tracked so we can warn them all
// before the process goes down for a deploy.
const BOOT_ID: string = (g.__bootId ??= crypto.randomUUID());
const allClients: Set<any> = (g.__allClients ??= new Set());

function broadcastToAll(msg: object) {
	const payload = JSON.stringify(msg);
	for (const ws of allClients) {
		try {
			ws.send(payload);
		} catch {}
	}
}

// Cache sessions with short TTL
let sessionsCache: { data: UnifiedSession[]; ts: number } | null = null;
const CACHE_TTL = 2000;

function getCachedSessions(): UnifiedSession[] {
	if (sessionsCache && Date.now() - sessionsCache.ts < CACHE_TTL) {
		return sessionsCache.data;
	}
	const data = getAllSessions();
	// Earliest run-start per session id, from the run journal — feeds the "in
	// progress" elapsed ticker and survives a page refresh (a session can carry
	// its bks id and its engine session id across records; key on both).
	const runStarts = new Map<string, string>();
	for (const r of activeRunRecords()) {
		if (!r.startedAt) continue;
		for (const key of [r.bksSessionId, r.claudeSessionId]) {
			if (!key) continue;
			const prev = runStarts.get(key);
			if (!prev || r.startedAt < prev) runStarts.set(key, r.startedAt);
		}
	}
	// Sessions driven from the web UI run in-process; surface those too
	for (const s of data) {
		if (
			!s.isRunning &&
			isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id)
		) {
			s.isRunning = true;
		}
		if (s.isRunning) {
			s.runStartedAt =
				runStarts.get(s.id) ||
				(s.claudeSessionId ? runStarts.get(s.claudeSessionId) : undefined) ||
				(s.codexThreadId ? runStarts.get(s.codexThreadId) : undefined);
		}
	}
	sessionsCache = { data, ts: Date.now() };
	return data;
}

// In-process self-management MCP servers for INTERACTIVE Backstage sessions
// (web UI + loops) — the same michael-sessions / michael-admin tools the Slack
// agent gets, so you can list/steer sessions and manage automations/MCPs from a
// Michael session. Built fresh per run from the prompt's author. NEVER pass
// these to automation runs or to interactive resumes of automation-owned
// sessions — untrusted ticket text must not reach session-control / config
// tools. Backstage is Tailscale- and team-gated and already exposes all of this
// through its UI, so interactive users are treated as admin.
function interactiveMcpServers(
	user?: string,
	sessionId?: string,
): Record<string, unknown> {
	const createdBy = user || "Backstage";
	return {
		"michael-sessions": createSessionsMcpServer({
			createdBy,
			isAdmin: true,
			currentSessionId: sessionId,
		}),
		"michael-admin": createAdminMcpServer({
			channel: "backstage",
			userId: user || "backstage",
			isDM: false,
			isPrivate: false,
			createdBy,
			isAdmin: true,
		}),
		// Long-running goals: create/list/steer persistent, self-pacing missions.
		"michael-goals": createGoalsMcpServer({ createdBy, isAdmin: true }),
		// Human-in-the-loop: ask a teammate and fold the answer back into this
		// session. Needs the session id so the answer routes home. Withheld (like
		// the others) from automation runs — see the runSessionPrompt call site.
		...(sessionId
			? {
					"michael-humans": createHumansMcpServer({
						sessionId,
						createdBy,
						isAdmin: true,
					}),
					// Cross-repo: attach secondary repos as isolated worktrees.
					"michael-repos": createReposMcpServer({
						sessionId,
						attach: (repo, branch) => attachRepo(sessionId, repo, branch),
						switchPrimary: (repo) => switchPrimaryRepo(sessionId, repo),
						snapshot: () => {
							const s = findSession(sessionId);
							if (!s) return null;
							return {
								primaryRepo:
									s.repo ||
									(s.worktreeDir
										? repoForPath(s.worktreeDir).id
										: "tella-fusion"),
								branch: s.branch,
								worktreeDir: s.worktreeDir,
								attached: s.attachedRepos || [],
							};
						},
						repos: () =>
							Object.values(REPOS).map((p) => ({
								id: p.id,
								defaultBranch: p.defaultBranch,
								sharedCheckout: !!p.sharedCheckout,
							})),
					}),
					// Deep-link testing: record where the change should be tested so
					// the Preview/Staging buttons open that route directly.
					"michael-preview": createPreviewMcpServer({
						sessionId,
						setPreviewPath: (path) =>
							touchBackstageSession(sessionId, {
								previewPath: path || undefined,
							}),
						current: () => findSession(sessionId)?.previewPath ?? null,
					}),
					// AskUserQuestion for engines without a canUseTool hook (Codex):
					// blocks on the same UI question card + Slack escalation as the
					// native Claude tool. claude-runner strips this server so Claude
					// keeps using the native AskUserQuestion instead of a duplicate.
					"michael-ask": createAskUserMcpServer({
						ask: makeAskHandler(sessionId),
					}),
				}
			: {}),
	};
}

// Codex cannot consume Claude SDK in-process MCP servers directly. Expose the
// same interactive michael-* tools through the run-rpc stdio proxy so Codex
// sessions can inspect/create/steer Backstage sessions too. Goal-driven
// sessions additionally get michael-goal-self (next-wake/ledger/pause tools),
// matching what the in-process path hands them at the runAgent call sites.
registerInteractiveMcpBuilder((sessionId, user) => {
	const servers = interactiveMcpServers(user, sessionId);
	const goalId = sessionId ? findSession(sessionId)?.goalId : undefined;
	if (goalId)
		(servers as Record<string, unknown>)["michael-goal-self"] =
			createGoalSelfMcpServer(goalId);
	return servers;
});
startRunRpcServer();

/**
 * System-prompt note describing a session's repos when it spans more than one.
 * Lists the primary worktree + every attached repo with its path/branch and how
 * `@<project>:path` mentions resolve. Returns undefined for single-repo sessions
 * so the prompt stays clean.
 */
/**
 * Branch discipline for interactive code sessions in isolated worktrees. Chats
 * in one workspace share a single worktree + branch, so each agent must treat
 * that branch as THE branch — sibling commits included. Without this, each
 * sibling chat decided the extra commits on the shared branch weren't its own
 * and cherry-picked onto a fresh branch, producing one PR per chat instead of
 * one per workspace (tella-fusion PRs #4529–#4531).
 */
function buildBranchNote(session: {
	mode?: "ask" | "code";
	branch?: string | null;
	worktreeDir?: string | null;
}): string | undefined {
	if (session.mode === "ask" || !session.branch || !session.worktreeDir)
		return undefined;
	const repo = repoForPath(session.worktreeDir);
	// Shared-checkout repos (backstage) and main-checkout cwds have their own
	// rules; this note is for isolated per-branch worktrees only.
	if (repo.sharedCheckout || session.worktreeDir === repo.repo)
		return undefined;
	return [
		"## Branch discipline (shared worktree)",
		`You are working in \`${session.worktreeDir}\` on branch \`${session.branch}\`. Other chats in this workspace share this exact worktree and branch — commits you don't recognize are their work, not noise.`,
		`Stay on \`${session.branch}\`: never create or switch branches, and never rebase away, reset, or cherry-pick around sibling commits. Commit your changes on this branch and push with \`git push origin ${session.branch}\`.`,
		`This workspace keeps ONE pull request: if an open PR for \`${session.branch}\` already exists, pushing updates it — do not open another. Only run \`gh pr create\` when the branch has no open PR. Never merge.`,
		"Only deviate from this (separate branch or separate PR) when the user explicitly asks for it.",
	].join("\n");
}

function buildReposNote(session: UnifiedSession): string | undefined {
	const branchNote = buildBranchNote(session);
	const attached = session.attachedRepos || [];
	if (!attached.length) return branchNote;
	const primaryRepo =
		session.repo ||
		(session.worktreeDir
			? repoForPath(session.worktreeDir).id
			: "tella-fusion");
	const lines = [
		"## Repos in this session",
		"This session spans multiple repos. Each is an isolated git worktree — `cd` into the right one to read or edit its files, and commit/push/open PRs in each repo independently (don't edit another repo's shared main checkout).",
		`- **${primaryRepo}** (primary): ${session.worktreeDir}${session.branch ? ` — branch \`${session.branch}\`` : ""}`,
	];
	for (const r of attached)
		lines.push(`- **${r.repo}**: ${r.dir} — branch \`${r.branch}\``);
	lines.push(
		"A file mentioned from an attached repo arrives as `@<project>:<path>` — resolve it under that repo's worktree dir above.",
	);
	return [branchNote, lines.join("\n")].filter(Boolean).join("\n\n");
}

/**
 * Resolve which GitHub repo + branch a PR operation targets. With no `repo`
 * query (or the primary project's id) it's the session's primary branch; an
 * attached project id targets that repo on its attached branch. Returns null
 * when there's no branch to act on.
 */
function resolvePrTarget(
	session: UnifiedSession,
	repoId?: string | null,
): { ghRepo: string; branch: string } | null {
	const primaryRepo =
		session.repo ||
		(session.worktreeDir
			? repoForPath(session.worktreeDir).id
			: "tella-fusion");
	if (!repoId || repoId === primaryRepo) {
		if (!session.branch) return null;
		return {
			ghRepo: getRepo(primaryRepo).ghRepo,
			branch: session.branch,
		};
	}
	const att = (session.attachedRepos || []).find(
		(r) => r.repo === repoId,
	);
	if (!att) return null;
	return { ghRepo: getRepo(att.repo).ghRepo, branch: att.branch };
}

function findSession(sessionId: string): UnifiedSession | undefined {
	return getCachedSessions().find((s) => s.id === sessionId);
}

/**
 * List which of `files` contain `query` (case-insensitive, literal) via
 * ripgrep — the cheap first stage of transcript full-text search. rg exits 1
 * when nothing matches, which we treat as "no hits", not an error. Chunked so a
 * very long file list can't overflow the argv limit.
 */
async function ripgrepFiles(
	query: string,
	files: string[],
): Promise<string[]> {
	const hits = new Set<string>();
	const CHUNK = 1000;
	for (let i = 0; i < files.length; i += CHUNK) {
		const chunk = files.slice(i, i + CHUNK);
		const proc = Bun.spawn(
			["rg", "-l", "-i", "-F", "--no-messages", "--", query, ...chunk],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		for (const line of out.split("\n")) {
			const p = line.trim();
			if (p) hits.add(p);
		}
	}
	return [...hits];
}

/** Derive the at-a-glance state + control surface for a session (for the MCP). */
function buildSummary(s: UnifiedSession): SessionSummary {
	const busyHere = isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id);
	// External runs (CLI in tmux, another process) show as running via PID but
	// aren't in our activeRuns — observe-only, can't steer/cancel them.
	const runningExternal = !!s.isRunning && !busyHere;
	const pending = pendingAsks.get(s.id);
	const queuedCount = promptQueues.get(s.id)?.length || 0;

	let state: SessionState;
	if (s.archived) state = "archived";
	else if (pending) state = "waiting_question";
	else if (busyHere || s.isRunning) state = "running";
	else if (queuedCount > 0) state = "queued";
	else state = "idle";

	return {
		...s,
		state,
		queuedCount,
		controllable: !runningExternal,
		...(pending
			? {
					pendingQuestion: {
						questionId: pending.questionId,
						questions: pending.questions,
					},
				}
			: {}),
	};
}

function touchBackstageSession(
	bksId: string,
	patch: Partial<BackstageSessionFile>,
): void {
	const path = `${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`;
	try {
		const data: BackstageSessionFile = existsSync(path)
			? JSON.parse(readFileSync(path, "utf-8"))
			: ({} as BackstageSessionFile);
		writeJsonAtomic(path, {
			...data,
			...patch,
			lastActivity: new Date().toISOString(),
		});
		sessionsCache = null;
	} catch (e) {
		console.error(`Failed to update backstage session ${bksId}:`, e);
	}
}

// Reasoning-effort values the composer/new-session pill can send. Persisted on
// the session file so queued drains, loops, and restart resumes all run at the
// effort the pill shows; each runner maps it onto its backend's own scale.
const SESSION_EFFORTS = new Set(["low", "medium", "high"]);

/** Persist a composer-sent effort change on a backstage session (no-op otherwise). */
function maybePersistEffort(
	session: UnifiedSession | undefined,
	effort?: string,
): void {
	if (!session || session.source !== "backstage" || !effort) return;
	const e = effort.trim().toLowerCase();
	if (!SESSION_EFFORTS.has(e) || session.effort === e) return;
	touchBackstageSession(session.id, { effort: e });
	session.effort = e; // keep the in-hand snapshot current for this turn
}

/**
 * The workspace that already owns this worktree, or null. Adopt-don't-duplicate:
 * every create path that's about to wrap a chat in a fresh workspace checks here
 * first, so landing on an already-owned worktree joins the existing workspace
 * instead of minting a second one over it. Repo main checkouts never match —
 * they're shared by every backstage/ask chat, so ownership is meaningless there.
 */
function workspaceOwningWorktree(
	worktreeDir: string | null | undefined,
): Workspace | null {
	if (!worktreeDir) return null;
	if (Object.values(REPOS).some((r) => r.repo === worktreeDir)) return null;
	return findWorkspaceByWorktree(worktreeDir);
}

/**
 * Attach a secondary repo to a session: create (or reuse) an isolated worktree
 * for `repoId` and record it on the session. The attached branch defaults to
 * the session's primary branch so cross-repo work shares one branch name (and
 * the PRs line up). Re-attaching the same project just updates its entry. Only
 * code sessions on a real worktree can attach — Ask/main-checkout sessions and
 * the primary project itself are rejected.
 */
async function attachRepo(
	sessionId: string,
	repoId: string,
	branch?: string,
): Promise<{ attached: AttachedRepo; all: AttachedRepo[] }> {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");
	if (session.mode === "ask")
		throw new Error("Can't attach a repo to an Ask (read-only) session");
	if (hasRemoteWorkspace(session))
		throw new Error(
			"This session's workspace lives inside its sandbox volume — attached repos aren't supported in volume mode yet (use a bind-mode sandbox or a plain worktree session for multi-repo work)",
		);
	if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
	if (session.repo === repoId)
		throw new Error(`${repoId} is this session's primary repo`);

	const effectiveBranch = (branch || session.branch || "").trim();
	if (!effectiveBranch) {
		throw new Error("No branch to attach on — pass a branch name");
	}

	const attached = await prepareAttachedWorktree(repoId, effectiveBranch);
	const existing = (session.attachedRepos || []).filter(
		(r) => r.repo !== repoId,
	);
	const all = [...existing, attached];
	touchBackstageSession(sessionId, { attachedRepos: all });
	return { attached, all };
}

/**
 * Switch a session's PRIMARY repo — for when the wrong repo was picked at
 * creation. Clean-only by design: allowed only while the session's worktree has
 * no uncommitted changes and no commits beyond its base, so no work is ever
 * silently stranded (a session that already committed keeps its old repo). The
 * session's branch name is reused in the target repo (keeping any cross-repo
 * PRs aligned); the next prompt runs from the new worktree because
 * runSessionPrompt re-reads `cwd` from `worktreeDir` each turn.
 */
async function switchPrimaryRepo(
	sessionId: string,
	repoId: string,
	force = false,
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");
	if (session.mode === "ask")
		throw new Error("Ask sessions read the main checkout — nothing to switch");
	if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
	if (session.repo === repoId)
		throw new Error(`${repoId} is already this session's primary repo`);
	// A switch just repoints the session at a different worktree — the old one
	// (branch, commits, uncommitted edits) stays on disk, so nothing is ever
	// destroyed. We still block by default when there's work so the agent-facing
	// switch_repo tool can't silently abandon it; the human UI passes force=true
	// after confirming, since fixing a wrong-repo choice is exactly that case.
	if (
		!force &&
		session.worktreeDir &&
		session.branch &&
		(await worktreeHasWork(session.worktreeDir, session.branch, session.repo))
	)
		throw new Error(
			"This session already has work — switching repos is only allowed on a fresh session",
		);

	const target = getRepo(repoId);
	let wtPath: string;
	let branch: string;
	if (target.sharedCheckout) {
		// Backstage: sessions edit the live main checkout on its default branch.
		wtPath = target.repo;
		branch = target.defaultBranch;
	} else {
		branch = (session.branch || "").trim();
		if (!branch) throw new Error("Session has no branch to carry over");
		const worktrees = await listWorktrees(target.id);
		wtPath =
			worktrees.find((w) => w.branch === branch)?.path ||
			(await createWorktree(branch, target.id));
	}

	// Drop the target from attached repos if it was attached — it's the primary now.
	const attachedRepos = (session.attachedRepos || []).filter(
		(r) => r.repo !== repoId,
	);
	touchBackstageSession(sessionId, {
		repo: target.id,
		worktreeDir: wtPath,
		branch,
		attachedRepos,
	});
	return { repo: target.id, branch, worktreeDir: wtPath };
}

// WebSocket client state
interface WSClientData {
	watchingSessionId: string | null;
	watchingNoteId: string | null;
	user: string | null;
}

// sessionId → sockets currently viewing that session (collaboration fan-out)
const sessionWatchers: Map<string, Set<any>> = (g.__sessionWatchers ??=
	new Map());

// Sessions whose workspace (worktree) is still being prepared by their create
// run — the create announces session_created BEFORE the slow git work, and this
// set is what tells clients to show the "Waiting for workspace" state and hold
// the first message in the queue. Cleared (and broadcast via workspace_status)
// the moment the worktree lands or the create fails.
const preparingWorkspaces: Set<string> = (g.__preparingWorkspaces ??= new Set());

function joinSession(ws: any, sessionId: string) {
	let set = sessionWatchers.get(sessionId);
	if (!set) {
		set = new Set();
		sessionWatchers.set(sessionId, set);
	}
	set.add(ws);
	// Global presence shows each person once, at their most recent join — this
	// stamp is how a two-tab user resolves to a single row.
	ws.data.watchJoinedAt = Date.now();
	broadcastPresence(sessionId);
}

function leaveSession(ws: any) {
	const sessionId = ws.data?.watchingSessionId;
	if (!sessionId) return;
	const set = sessionWatchers.get(sessionId);
	if (set) {
		set.delete(ws);
		if (set.size === 0) {
			sessionWatchers.delete(sessionId);
			broadcastGlobalPresence();
		} else broadcastPresence(sessionId);
	}
	ws.data.watchingSessionId = null;
}

function broadcastToSession(sessionId: string, msg: object, except?: any) {
	const set = sessionWatchers.get(sessionId);
	if (!set) return;
	const payload = JSON.stringify(msg);
	for (const ws of set) {
		if (ws === except) continue;
		try {
			ws.send(payload);
		} catch {}
	}
}

function broadcastPresence(sessionId: string) {
	const set = sessionWatchers.get(sessionId);
	const viewers = set
		? Array.from(set, (ws: any) => ws.data?.user || "Anonymous")
		: [];
	broadcastToSession(sessionId, { type: "presence", sessionId, viewers });
	broadcastGlobalPresence();
}

/**
 * Who's looking at what, app-wide — drives the sidebar People band and follow
 * mode. One entry per USER (a person with two tabs open would otherwise show
 * twice): the session they joined most recently wins. Anonymous viewers are
 * skipped (nothing to follow).
 */
function broadcastGlobalPresence() {
	const latest = new Map<string, { sessionId: string; at: number }>();
	for (const [sessionId, set] of sessionWatchers) {
		for (const ws of set) {
			const user = ws.data?.user;
			if (!user || user === "Anonymous") continue;
			const at = ws.data?.watchJoinedAt || 0;
			const prev = latest.get(user);
			if (!prev || at >= prev.at) latest.set(user, { sessionId, at });
		}
	}
	const viewing = [...latest.entries()].map(([user, v]) => ({
		user,
		sessionId: v.sessionId,
	}));
	broadcastToAll({ type: "global_presence", viewing });
}

// ── Collaborative notes fan-out ───────────────────────────────────────────
// Parallel to sessionWatchers: noteId → sockets editing that note. Notes are
// Yjs CRDT docs (src/server/notes.ts); clients relay binary Yjs updates +
// awareness (cursors) as base64 over this same multiplexed JSON socket.
const noteWatchers: Map<string, Set<any>> = (g.__noteWatchers ??= new Map());

function joinNote(ws: any, noteId: string) {
	let set = noteWatchers.get(noteId);
	if (!set) {
		set = new Set();
		noteWatchers.set(noteId, set);
	}
	set.add(ws);
	broadcastNotePresence(noteId);
}

function leaveNote(ws: any) {
	const noteId = ws.data?.watchingNoteId;
	if (!noteId) return;
	const set = noteWatchers.get(noteId);
	if (set) {
		set.delete(ws);
		if (set.size === 0) noteWatchers.delete(noteId);
		else broadcastNotePresence(noteId);
	}
	ws.data.watchingNoteId = null;
}

function broadcastToNote(noteId: string, msg: object, except?: any) {
	const set = noteWatchers.get(noteId);
	if (!set) return;
	const payload = JSON.stringify(msg);
	for (const ws of set) {
		if (ws === except) continue;
		try {
			ws.send(payload);
		} catch {}
	}
}

function broadcastNotePresence(noteId: string) {
	const set = noteWatchers.get(noteId);
	const viewers = set
		? Array.from(set, (ws: any) => ws.data?.user || "Anonymous")
		: [];
	broadcastToNote(noteId, { type: "note_presence", noteId, viewers });
}

const b64encode = (u: Uint8Array) => Buffer.from(u).toString("base64");
const b64decode = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

// Interactive AskUserQuestion: questions broadcast to session watchers, answered
// from the UI. If nobody answers in the UI within ASK_UI_TIMEOUT_MS, the question
// is escalated to the session's original prompter over Slack (the michael-humans
// transport) and we keep blocking on their reply; the UI question stays live the
// whole time, so whoever answers first (web or Slack) wins.
const ASK_UI_TIMEOUT_MS = 4 * 60 * 1000;

interface AskQuestionInput {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

interface PendingAsk {
	questionId: string;
	questions: unknown[];
	resolve: (answers: Record<string, string> | null) => void;
}
const pendingAsks: Map<string, PendingAsk> = (g.__pendingAsks ??= new Map());

// Sessions whose LAST run died on a terminal failure (usage limits exhausted on
// every account, credit/API errors). Those need a human to act — the sidebar
// surfaces them as "Needs input" instead of letting them sink into the Backlog.
// Keyed by canonical session id; parked on globalThis for hot reloads.
// Backstage-owned sessions also persist the error on their session file (via
// recordRunOutcome) so the flag survives a real restart.
const runErrors: Map<string, { message: string; at: string }> = (g.__runErrors ??=
	new Map());

/**
 * Record how a session's run ended: an error message when it died on a terminal
 * failure, or null for a clean finish (which clears any earlier failure). The
 * enriched /api/sessions list exposes this as `lastRunError`.
 */
function recordRunOutcome(sessionId: string, errorMessage: string | null): void {
	const session = findSession(sessionId);
	const id = session?.id || sessionId;
	if (errorMessage) {
		const entry = {
			message: errorMessage.slice(0, 500),
			at: new Date().toISOString(),
		};
		runErrors.set(id, entry);
		if (session?.source === "backstage")
			touchBackstageSession(id, { lastRunError: entry });
	} else {
		// Only rewrite the session file when there's actually a flag to clear
		// (the in-memory map, or one persisted by a previous process).
		const had = runErrors.delete(id) || !!session?.lastRunError;
		if (had && session?.source === "backstage")
			touchBackstageSession(id, { lastRunError: undefined });
	}
}

// Flatten an AskUserQuestion payload into a single Slack-friendly prompt. Option
// buttons are only offered when there's exactly one question (the human-asks card
// carries one option set); multi-question asks fall back to a free-text reply.
function askToSlackPrompt(questions: AskQuestionInput[]): {
	question: string;
	options?: string[];
} {
	if (questions.length === 1) {
		const q = questions[0];
		const text = q.header ? `*${q.header}* — ${q.question}` : q.question;
		return { question: text, options: q.options?.map((o) => o.label) };
	}
	const text = questions
		.map(
			(q, i) => `${i + 1}. ${q.header ? `*${q.header}* — ` : ""}${q.question}`,
		)
		.join("\n");
	return { question: text };
}

// A Slack reply is a single string; apply it as the answer to every question so
// the AskUserQuestion result has a value for each key it expects.
function slackAnswerToAnswers(
	questions: AskQuestionInput[],
	answer: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const q of questions) out[q.question] = answer;
	return out;
}

function makeAskHandler(sessionId: string) {
	return async (
		input: Record<string, unknown>,
	): Promise<
		| { behavior: "allow"; updatedInput: Record<string, unknown> }
		| { behavior: "deny"; message: string }
	> => {
		const questions = input.questions as AskQuestionInput[] | undefined;
		if (!questions || questions.length === 0) {
			return { behavior: "allow", updatedInput: input };
		}

		const questionId = crypto.randomUUID();
		let settled = false;
		let escalatedAskId: string | null = null;

		const answers = await new Promise<Record<string, string> | null>(
			(resolve) => {
				const finish = (a: Record<string, string> | null) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeoutId);
					pendingAsks.delete(sessionId);
					// If the web UI answered after we'd already pinged Slack, retract the
					// Slack ask so the teammate isn't left answering a moot question.
					if (escalatedAskId) cancelAsk(escalatedAskId);
					resolve(a);
				};

				// No UI answer in time → ask the original prompter over Slack and keep
				// blocking on their reply (the UI question stays live in parallel).
				const timeoutId = setTimeout(() => {
					void escalateAskToSlack(sessionId, questions).then((esc) => {
						if (settled) {
							// UI answered in the race window — undo the just-created ask.
							if (esc) cancelAsk(esc.askId);
							return;
						}
						if (!esc) {
							// No teammate to ask (e.g. automation-owned) — fall back to deny.
							finish(null);
							return;
						}
						escalatedAskId = esc.askId;
						void awaitBlockingAnswer(esc.askId).then((slackAnswer) => {
							if (slackAnswer == null) {
								finish(null);
								return;
							}
							// The answer folds into the AskUserQuestion tool result (the agent
							// continues), but that's invisible in the UI — surface it as an
							// attributed bubble so the human sees their Slack reply land, the
							// same way the async human-asks path does.
							broadcastToSession(sessionId, {
								type: "notice",
								message: `💬 **${esc.personName}** answered (via Slack): ${slackAnswer}`,
							});
							finish(slackAnswerToAnswers(questions, slackAnswer));
						});
					});
				}, ASK_UI_TIMEOUT_MS);

				pendingAsks.set(sessionId, {
					questionId,
					questions,
					resolve: (a) => finish(a),
				});
				broadcastToSession(sessionId, {
					type: "ask_question",
					sessionId,
					questionId,
					questions,
				});
				// Phone buzz: Web Push to the session owner's registered devices
				// (opt-in per device in Settings → Notifications). Best-effort —
				// never lets a push hiccup affect the ask flow.
				void (async () => {
					try {
						const s = findSession(sessionId);
						if (!s?.startedBy) return;
						const { sendPushToUser } = await import("./src/server/push");
						await sendPushToUser(s.startedBy, {
							title: "Michael needs input",
							body: `${s.title || sessionId} — ${questions[0]?.question || "a question is waiting"}`.slice(0, 180),
							url: `/backstage/session/${encodeURIComponent(sessionId)}`,
							tag: `ask-${sessionId}`,
						});
					} catch {}
				})();
			},
		);

		broadcastToSession(sessionId, {
			type: "ask_resolved",
			sessionId,
			questionId,
		});

		if (!answers) {
			return {
				behavior: "deny",
				message:
					"Nobody answered in time (web or Slack). Proceed with your best judgment and clearly note the open question and the assumption you made.",
			};
		}
		return { behavior: "allow", updatedInput: { ...input, answers } };
	};
}

// Escalate an unanswered AskUserQuestion to the session's original prompter over
// Slack. Returns the human-ask id (await its blocking answer) + who we asked, or
// null when we can't resolve a teammate. Best-effort: never throws into the handler.
async function escalateAskToSlack(
	sessionId: string,
	questions: AskQuestionInput[],
): Promise<{ askId: string; personName: string } | null> {
	try {
		const session = findSession(sessionId);
		const person = resolveTeammate(session?.startedBy ?? null);
		if (!person) return null;

		const { question, options } = askToSlackPrompt(questions);
		const ask = registerAsk({
			sessionId,
			createdBy: session?.startedBy || "Michael",
			person,
			question,
			context:
				"_Nobody picked this up in Backstage within 4 minutes, so I'm bringing it to you._",
			options,
			mode: "block",
			deliver: "now",
		});
		broadcastToSession(sessionId, {
			type: "notice",
			message: `No answer in Backstage — asked ${person.name} over Slack.`,
		});
		return { askId: ask.id, personName: person.name };
	} catch (e) {
		console.error("[ask] Slack escalation failed:", e);
		return null;
	}
}

// Messages sent while a run is in flight queue up and deliver afterwards,
// the same way Claude Code handles interruptions. Attachments ride along:
// `images` as composer `data:` URLs (parsed to ImageInput at delivery), `files`
// as the raw composer payload (staged-path or inline refs). Both are persisted
// with the queue so a restart doesn't silently drop a message's attachments.
type QueueItem = {
  id?: string;
  content: string;
  user?: string;
  images?: string[];
  files?: unknown;
};
const promptQueues: Map<string, QueueItem[]> = (g.__promptQueues ??= new Map());

function isGitHubQueueItem(item?: QueueItem): boolean {
	return item?.user === "GitHub" || item?.user === "GitHub (automation)";
}

// Steered messages (folded into a live run, delivered at the run's next turn
// boundary) aren't in promptQueues — the drain would re-deliver them. But until
// their turn lands they're invisible on reload, so we keep a display-only
// receipt here: shown as "folded in" in the UI and reconciled away once the real
// transcript entry appears. Cleared when the run finishes (or is cancelled).
const steeredReceipts: Map<string, QueueItem[]> = (g.__steeredReceipts ??=
	new Map());

// Sessions whose run the user explicitly stopped. The queue drain skips these:
// without the flag, stop would requeue the held steers and drainQueue would
// immediately deliver them into a fresh run — "stop then instantly resume".
// Cleared by the next explicit action (any new runSessionPrompt). In-memory
// only: after a real restart a stop is stale anyway, and boot re-drains.
const stoppedSessions: Set<string> = (g.__stoppedSessions ??= new Set());

// Both maps are persisted to disk so a real restart/crash (not just a hot
// reload, which keeps the globalThis maps) doesn't silently drop queued or
// just-steered messages. Restored + re-drained on boot (restorePromptQueues).
const QUEUE_STORE = `${BACKSTAGE_SESSIONS_DIR}/prompt-queues.json`;
function queueItem(item: QueueItem): QueueItem {
	return item.id ? item : { ...item, id: crypto.randomUUID() };
}

function queueWithIds(items: QueueItem[] | undefined): QueueItem[] {
	return (items || []).map((item) => {
		if (item.id) return item;
		return queueItem(item);
	});
}

function persistQueues(): void {
	try {
		const entries = (m: Map<string, QueueItem[]>) =>
			Object.fromEntries(
				[...m]
					.map(([k, v]) => [k, queueWithIds(v)] as const)
					.filter(([, v]) => v.length > 0),
			);
		// Keep the previous copy as .bak before overwriting: if the store on disk
		// ever ends up unparsable, restorePromptQueues falls back to it instead of
		// silently dropping every queued message.
		if (existsSync(QUEUE_STORE)) {
			try {
				copyFileSync(QUEUE_STORE, `${QUEUE_STORE}.bak`);
			} catch {}
		}
		writeJsonAtomic(
			QUEUE_STORE,
			{
				queued: entries(promptQueues),
				steered: entries(steeredReceipts),
			},
			false,
		);
	} catch (e) {
		console.error("[queue] Failed to persist prompt queues:", e);
	}
}

/** Append a message to a session's drainable queue and persist + broadcast. */
function enqueuePrompt(sessionId: string, item: QueueItem): void {
	const queue = promptQueues.get(sessionId) || [];
	queue.push(queueItem(item));
	promptQueues.set(sessionId, queue);
	persistQueues();
	broadcastQueue(sessionId);
	// Queueing is a delivery promise, not just a UI state. Arm the idle watcher
	// here so every queued message drains after the current run, even if a caller
	// forgets to do that explicitly or the session becomes idle between checks.
	watchExternalRunAndDrain(sessionId);
}

/** Record a steered message as a visible receipt until its run finishes. */
function recordSteer(sessionId: string, item: QueueItem): void {
	const list = steeredReceipts.get(sessionId) || [];
	list.push(queueItem(item));
	steeredReceipts.set(sessionId, list);
	persistQueues();
	broadcastQueue(sessionId);
}

/** Clear a session's steer receipts once the run that owned them is done. */
function clearSteerReceipts(sessionId: string): void {
	if (!steeredReceipts.has(sessionId)) return;
	steeredReceipts.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
}

// Clear a steer receipt the moment its message lands in the transcript (the
// file-watcher reports appended entries). Waiting for run end left delivered
// messages showing as "queued" whenever the client's transcript tail didn't
// reach back to their user entry — and a mid-run restart would have re-queued
// (re-delivered) them via restorePromptQueues. Matches the frontend reconcile:
// exact attributed form, or containment for turns joined at one boundary.
// Registered at module scope so every hot reload re-installs the current code.
setTranscriptAppendListener((sessionId, entries) => {
	const steered = steeredReceipts.get(sessionId);
	if (!steered?.length) return;
	const users = entries
		.filter((e) => e.type === "user")
		.map((e) => e.content.trim());
	if (users.length === 0) return;
	const remaining = steered.filter((item) => {
		const attributed = (
			item.user ? `[${item.user}] ${item.content}` : item.content
		).trim();
		return !users.some((u) => u === attributed || u.includes(attributed));
	});
	if (remaining.length === steered.length) return;
	if (remaining.length > 0) steeredReceipts.set(sessionId, remaining);
	else steeredReceipts.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
});

/** Put unconfirmed steers back into the normal queue when their run is cancelled. */
function requeueSteerReceipts(sessionId: string): number {
	const steered = steeredReceipts.get(sessionId);
	if (!steered?.length) return 0;
	const queue = promptQueues.get(sessionId) || [];
	promptQueues.set(sessionId, [...steered, ...queue]);
	steeredReceipts.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
	return steered.length;
}

function queuedPromptIndex(
	queue: QueueItem[],
	queueId?: string,
	queueIndex?: number,
): number {
	if (queueId) {
		const byId = queue.findIndex((item) => item.id === queueId);
		if (byId >= 0) return byId;
	}
	if (
		typeof queueIndex === "number" &&
		Number.isInteger(queueIndex) &&
		queueIndex >= 0 &&
		queueIndex < queue.length
	) {
		return queueIndex;
	}
	return -1;
}

function deleteQueuedPrompt(
	sessionId: string,
	queueId?: string,
	queueIndex?: number,
): boolean {
	const queue = promptQueues.get(sessionId);
	if (queue) {
		const index = queuedPromptIndex(queue, queueId, queueIndex);
		if (index >= 0) {
			const next = queue.filter((_, i) => i !== index);
			if (next.length > 0) promptQueues.set(sessionId, next);
			else promptQueues.delete(sessionId);
			persistQueues();
			broadcastQueue(sessionId);
			return true;
		}
	}
	// Steer receipts are dismissable too (by id only — indexes are queue-
	// relative). A receipt normally reconciles away when its message lands,
	// but it lives server-side until the run finishes; on a long run a stale
	// one must be deletable without waiting for that.
	if (queueId) {
		const steered = steeredReceipts.get(sessionId);
		const index = (steered || []).findIndex((item) => item.id === queueId);
		if (steered && index >= 0) {
			const next = steered.filter((_, i) => i !== index);
			if (next.length > 0) steeredReceipts.set(sessionId, next);
			else steeredReceipts.delete(sessionId);
			persistQueues();
			broadcastQueue(sessionId);
			return true;
		}
	}
	return false;
}

function updateQueuedPrompt(
	sessionId: string,
	queueId: string | undefined,
	queueIndex: number | undefined,
	content: string,
): boolean {
	const queue = promptQueues.get(sessionId);
	if (!queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const item = queue[index];
	if (!item) return false;
	if (isGitHubQueueItem(item)) return false;
	item.content = content;
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

/**
 * Reorder a session's queue to match `order` (queue-item ids in their new send
 * order). Items named in `order` are placed first in that order; any queued item
 * not named — one that arrived after the client took its snapshot — keeps its
 * relative position at the tail, so a racing enqueue is never dropped. No-ops
 * (unknown session, <2 items, or an order that doesn't change anything) return
 * false without a broadcast.
 */
function reorderQueuedPrompt(sessionId: string, order: string[]): boolean {
	const queue = promptQueues.get(sessionId);
	if (!queue || queue.length < 2) return false;
	const byId = new Map(
		queue.filter((it) => it.id).map((it) => [it.id!, it] as const),
	);
	const placed = new Set<string>();
	const next: QueueItem[] = [];
	for (const id of order) {
		const item = byId.get(id);
		if (item && !placed.has(id)) {
			next.push(item);
			placed.add(id);
		}
	}
	for (const item of queue) {
		if (!item.id || !placed.has(item.id)) next.push(item);
	}
	// Same references in the same slots ⇒ nothing moved.
	if (next.every((item, i) => item === queue[i])) return false;
	promptQueues.set(sessionId, next);
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

function steerQueuedPrompt(
	sessionId: string,
	queueId?: string,
	queueIndex?: number,
): boolean {
	const session = findSession(sessionId);
	const queue = promptQueues.get(sessionId);
	if (!session || !queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const [item] = queue.splice(index, 1);
	if (!item) return false;
	if (isGitHubQueueItem(item) || (Array.isArray(item.files) && item.files.length > 0)) {
		queue.splice(index, 0, item);
		return false;
	}
	const attributed = item.user ? `[${item.user}] ${item.content}` : item.content;
	const images = parseImageDataUrls(item.images || []);
	if (
		!isAgentSessionBusy(
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		) ||
		!steerAgentRun(
			[session.claudeSessionId, session.codexThreadId, session.id],
			attributed,
			images,
		)
	) {
		queue.splice(index, 0, item);
		return false;
	}
	if (queue.length > 0) promptQueues.set(sessionId, queue);
	else promptQueues.delete(sessionId);
	recordSteer(sessionId, item);
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

/**
 * Interrupt-deliver a waiting message: abort the run's current turn so the
 * message lands right away instead of at the next natural stopping point.
 * Two cases: an already-steered receipt just needs a bare interrupt (its text
 * is in the run's steer buffer — the forced boundary releases it; pushing it
 * again would double-deliver), while a queued item is folded in through the
 * interrupt-and-steer path. False = still queued, nothing was interrupted.
 */
function interruptQueuedPrompt(
	sessionId: string,
	queueId?: string,
	queueIndex?: number,
): boolean {
	const session = findSession(sessionId);
	if (!session) return false;
	if (queueId && (steeredReceipts.get(sessionId) || []).some((s) => s.id === queueId)) {
		// Receipt stays visible until the message lands in the transcript (the
		// usual reconcile) — dropping it here would lose it if the interrupt
		// fires between release and delivery.
		return interruptAgentRun([
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		]);
	}
	const queue = promptQueues.get(sessionId);
	if (!queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const [item] = queue.splice(index, 1);
	if (!item) return false;
	if (isGitHubQueueItem(item) || (Array.isArray(item.files) && item.files.length > 0)) {
		queue.splice(index, 0, item);
		return false;
	}
	const attributed = item.user ? `[${item.user}] ${item.content}` : item.content;
	const images = parseImageDataUrls(item.images || []);
	if (
		!isAgentSessionBusy(
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		) ||
		!interruptAndSteerAgentRun(
			[session.claudeSessionId, session.codexThreadId, session.id],
			attributed,
			images,
		)
	) {
		queue.splice(index, 0, item);
		return false;
	}
	// No steer receipt: an interrupt delivers almost immediately, so the
	// transcript entry is the record (same treatment as a direct interrupt send).
	if (queue.length > 0) promptQueues.set(sessionId, queue);
	else promptQueues.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

/**
 * Restore queued + steered messages a previous process left behind (a real
 * restart/crash — hot reloads keep the in-memory maps). Drainable queue items
 * are re-armed for delivery; unconfirmed steer receipts are folded back into the
 * queue too (best-effort: we can't know whether their turn landed before the
 * crash, and silently dropping the user's message is the worse failure). Call
 * after resumeInterruptedRuns so a session being resumed reads as busy and the
 * watcher waits it out instead of starting a colliding run.
 */
function restorePromptQueues(): void {
	if (!existsSync(QUEUE_STORE)) return;
	let data: {
		queued?: Record<string, QueueItem[]>;
		steered?: Record<string, QueueItem[]>;
	};
	try {
		data = JSON.parse(readFileSync(QUEUE_STORE, "utf-8"));
	} catch (e) {
		// Corrupt store — these are the user's queued messages, so don't just
		// drop them: fall back to the .bak persistQueues keeps of the last copy.
		console.error("[queue] Failed to read persisted queues:", e);
		try {
			data = JSON.parse(readFileSync(`${QUEUE_STORE}.bak`, "utf-8"));
			console.warn("[queue] Recovered persisted queues from .bak");
		} catch (e2) {
			console.error(
				"[queue] Backup queue store unreadable too — queued messages lost:",
				e2,
			);
			return;
		}
	}
	const merged = new Map<string, QueueItem[]>();
	for (const [id, items] of Object.entries(data.queued || {})) {
		if (items?.length) merged.set(id, [...items]);
	}
	for (const [id, items] of Object.entries(data.steered || {})) {
		if (items?.length) merged.set(id, [...(merged.get(id) || []), ...items]);
	}
	steeredReceipts.clear();
	let restored = 0;
	for (const [id, items] of merged) {
		if (!findSession(id)) continue; // session no longer exists — drop
		promptQueues.set(id, items);
		restored += items.length;
		watchExternalRunAndDrain(id); // drains once idle; waits out a resumed run
	}
	persistQueues();
	if (restored > 0) {
		console.log(
			`[queue] Restored ${restored} queued message(s) from before restart`,
		);
	}
}

// ── Wake-all-active-sessions on restart ──────────────────────────────────────
// The run journal (active-runs.json) only retains runs that are STILL executing
// when the process exits. During a graceful restart the 2-min drain lets runs
// finish their current turn — which clears them from the journal — so a session
// that stopped at a turn boundary mid-task was silently NOT resumed (the user had
// to type "continue"). To fix that we snapshot every active session the moment
// SIGTERM arrives (before the drain) and, on boot, nudge any that the journal
// resume didn't already cover. Crash (no graceful shutdown) still falls back to
// the journal, so both paths are covered.
const RESUME_SNAPSHOT_PATH = `${BACKSTAGE_SESSIONS_DIR}/active-at-shutdown.json`;

/** Capture the sessions with an in-flight run, for boot-time wake-up. Called at
 *  the very start of graceful shutdown, before the drain empties the journal. */
function snapshotActiveSessions(): void {
	try {
		const records = activeRunRecords();
		if (records.length === 0) {
			if (existsSync(RESUME_SNAPSHOT_PATH))
				writeFileAtomic(RESUME_SNAPSHOT_PATH, "[]");
			return;
		}
		writeJsonAtomic(RESUME_SNAPSHOT_PATH, records, false);
		console.log(
			`[resume] Snapshotted ${records.length} active session(s) for wake-up on restart`,
		);
	} catch (e) {
		console.error("[resume] Failed to snapshot active sessions:", e);
	}
}

/** Wake sessions that were active at the last graceful shutdown but finished
 *  their turn during the drain (so they weren't in the journal to resume).
 *  `alreadyResumed` are the bksSessionIds the journal resume already handled. */
function resumeDrainedSessions(alreadyResumed: Set<string>): void {
	let records: ActiveRunRecord[] = [];
	try {
		if (!existsSync(RESUME_SNAPSHOT_PATH)) return;
		records = JSON.parse(readFileSync(RESUME_SNAPSHOT_PATH, "utf-8"));
	} catch (e) {
		console.error("[resume] Failed to read active-session snapshot:", e);
		return;
	}
	// Consume the snapshot so the next (non-graceful) boot doesn't replay it.
	try {
		writeFileAtomic(RESUME_SNAPSHOT_PATH, "[]");
	} catch {}

	let woken = 0;
	for (const r of records) {
		const id = r.bksSessionId;
		if (!id || alreadyResumed.has(id)) continue; // journal already resumed it
		if (r.kind?.startsWith("github-")) continue; // github agent owns its recovery
		const session = findSession(id);
		// Only interactive backstage sessions — never re-trigger automations/loops,
		// which are one-shot and would re-run their whole task.
		if (!session || session.source !== "backstage" || session.automation)
			continue;
		if (
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		)
			continue;
		if (providerFor(session.model) === "claude" && !session.claudeSessionId)
			continue;
		woken++;
		console.log(
			`[resume] Waking session ${id} that finished its turn during the drain`,
		);
		void runSessionPromptAndDrain(
			id,
			RESUME_CONTINUATION_PROMPT,
			"system (restart)",
		).catch((e) => console.error(`[resume] Wake failed for ${id}:`, e));
	}
	if (woken > 0)
		console.log(
			`[resume] Woke ${woken} drained session(s) from before restart`,
		);
}

function recordRecoveredRunEvent(bksSessionId: string, event: StreamEvent): void {
	const session = findSession(bksSessionId);
	if (!session || session.source !== "backstage") return;

	if (event.type === "model_switch") {
		const to = event.toModel || "";
		if (!to) return;
		const reason = `auto-switch — ${modelLabel(event.fromModel)} out of credits`;
		touchBackstageSession(bksSessionId, {
			model: to,
			modelHistory: [
				...(session.modelHistory || []),
				{ model: to, from: event.fromModel, at: new Date().toISOString(), by: reason },
			],
		});
		sessionsCache = null;
		return;
	}

	if (event.type !== "init" && event.type !== "done") return;
	const engineSessionId = event.sessionId || "";
	const model = event.model || session.model;
	const provider = event.provider || providerFor(model);
	touchBackstageSession(bksSessionId, {
		...(engineSessionId ? engineSessionPatch(provider, engineSessionId) : {}),
		...(model ? { model } : {}),
	});
	if (engineSessionId && session.worktreeDir) {
		attachSessionWatchersToEngineTranscript(
			bksSessionId,
			provider,
			session.worktreeDir,
			engineSessionId,
		);
	}
	sessionsCache = null;
}

// Loaded agents (Plain/Linear/Slack/Stripe/…). Module-scoped because request
// handlers (health routes) read it, and globalThis-backed so the set survives a
// hot reload (loadAgents runs only on a real boot, inside the guard below).
let agents: AgentModule[] = (g.__agents as AgentModule[] | undefined) ?? [];

/**
 * Attach every socket viewing `sessionId` to a transcript file that only came
 * into existence after they started watching — a fresh chat's first run (no
 * transcriptPath existed at watch time), or an engine-id rotation forking to a
 * new file mid-conversation. Without this the whole run is silent for viewers:
 * the sent message sticks at "sending…" and the reply vanishes at stream_done,
 * until a reload re-watches the right file. Streams from byte 0 — entry ids
 * are the jsonl line uuids, so anything the client already has upserts
 * instead of duplicating.
 */
function attachSessionWatchersToTranscript(
	sessionId: string,
	path: string,
): void {
	const set = sessionWatchers.get(sessionId);
	if (!set) return;
	for (const ws of set) startWatching(path, ws, 0, sessionId);
}

function attachSessionWatchersToEngineTranscript(
	sessionId: string,
	// "opencode" resolves to no transcript path (opencode keeps its own storage);
	// those sessions stream through run events only, so this attaches nothing.
	provider: "claude" | "codex" | "opencode",
	cwd: string,
	engineSessionId: string,
	attempt = 0,
): void {
	const path = getEngineTranscriptPath(cwd, engineSessionId, provider);
	if (path) {
		attachSessionWatchersToTranscript(sessionId, path);
		return;
	}
	if (provider === "codex" && attempt < 5) {
		setTimeout(
			() =>
				attachSessionWatchersToEngineTranscript(
					sessionId,
					provider,
					cwd,
					engineSessionId,
					attempt + 1,
				),
			250,
		);
	}
}

function broadcastQueue(sessionId: string) {
	const queued = queueWithIds(promptQueues.get(sessionId));
	const steered = queueWithIds(steeredReceipts.get(sessionId));
	if (queued.length > 0) promptQueues.set(sessionId, queued);
	if (steered.length > 0) steeredReceipts.set(sessionId, steered);
	broadcastToSession(sessionId, {
		type: "queue_update",
		sessionId,
		queued,
		steered,
	});
}

async function drainQueue(sessionId: string): Promise<void> {
	let queue;
	while ((queue = promptQueues.get(sessionId)) && queue.length > 0) {
		// The user pressed stop: leave the queue visible-but-parked until their
		// next explicit action instead of restarting the run they just stopped.
		if (stoppedSessions.has(sessionId)) return;
		// A racing run can own the session by the time we loop again (e.g. our
		// last batch lost the start race and got re-queued) — hand off to the
		// idle-watcher instead of busy-spinning runs that immediately bounce.
		const session = findSession(sessionId);
		if (
			session &&
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		) {
			watchExternalRunAndDrain(sessionId);
			return;
		}
		const batch = queue.splice(0, queue.length);
		if (queue.length === 0) promptQueues.delete(sessionId);
		persistQueues();
		broadcastQueue(sessionId);
		const combined = batch
			.map((m) =>
				batch.length > 1 && m.user ? `[${m.user}] ${m.content}` : m.content,
			)
			.join("\n\n");
		// Attachments queued alongside the text ride the drained turn: images are
		// decoded to ImageInput, files handed through as staged/inline refs.
		const combinedImages = parseImageDataUrls(
			batch.flatMap((m) => m.images ?? []),
		);
		const combinedFiles = batch.flatMap((m) =>
			Array.isArray(m.files) ? m.files : [],
		);
		try {
			await runSessionPrompt(
				sessionId,
				combined,
				batch[0].user,
				combinedImages,
				combinedFiles.length ? combinedFiles : undefined,
			);
		} catch (e) {
			// The batch was already spliced out and persisted away — put it back at
			// the front of the queue so a throw doesn't lose the messages.
			const current = promptQueues.get(sessionId) || [];
			promptQueues.set(sessionId, [...batch, ...current]);
			persistQueues();
			broadcastQueue(sessionId);
			throw e;
		}
	}
}

async function runSessionPromptAndDrain(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextChats?: string[],
): Promise<void> {
	await runSessionPrompt(sessionId, content, user, images, rawFiles, contextChats);
	await drainQueue(sessionId);
}

/** Keep only the string `data:` URLs from a composer `images` payload — the
 *  display/queue form (parsed to ImageInput at delivery via parseImageDataUrls). */
function asDataUrlList(urls?: unknown): string[] | undefined {
	if (!Array.isArray(urls)) return undefined;
	const out = urls.filter((u): u is string => typeof u === "string");
	return out.length ? out : undefined;
}

/** Decode composer `data:<mediatype>;base64,<data>` URLs into runner ImageInputs. */
function parseImageDataUrls(urls?: unknown): ImageInput[] | undefined {
	if (!Array.isArray(urls)) return undefined;
	const out: ImageInput[] = [];
	for (const u of urls) {
		if (typeof u !== "string") continue;
		const m = u.match(/^data:([^;]+);base64,(.+)$/s);
		if (m && m[1].startsWith("image/"))
			out.push({ mediaType: m[1], data: m[2] });
	}
	return out.length ? out : undefined;
}

// Non-image composer attachments are staged to disk (the vision path only takes
// images), then the agent is handed their absolute paths in the opening prompt.
// Large files (a packed .crx, a zip, a PDF) stream straight to disk over a
// dedicated HTTP endpoint (POST /backstage/api/upload) and only their {name,path}
// reference rides the WebSocket — base64-over-WS can't carry them (frame cap +
// memory). The legacy inline {name,dataUrl}-over-WS path is still accepted for
// small files and older clients.
const UPLOADS_DIR = `${BACKSTAGE_SESSIONS_DIR}/uploads`;
// The HTTP endpoint stages here — a brand-new chat has no session id yet, so the
// reference is resolved back (and validated) at send time.
const STAGED_UPLOADS_DIR = `${UPLOADS_DIR}/staged`;
// Cap so a single upload can't OOM the process. The HTTP path streams, but the
// inline base64/WS path buffers, so keep it modest.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Images still ride the WebSocket frame base64-encoded (~+33%) inside the JSON
// envelope, and Bun's default WS `maxPayloadLength` is only 16 MB — below the
// base64 size of a max upload — so a large image silently blew the frame
// (close 1009). Size the frame cap off the upload cap + base64 overhead + slack.
const WS_MAX_PAYLOAD_BYTES = Math.ceil(MAX_UPLOAD_BYTES * (4 / 3)) + 8 * 1024 * 1024;

// A composer attachment arrives either pre-staged on disk (HTTP upload — carries a
// `path`) or inline as base64 over the WS frame (legacy — carries a data URL).
type ParsedUpload =
	| { kind: "staged"; name: string; path: string }
	| { kind: "inline"; name: string; data: string };

/** Normalize composer `files` entries into staged-path refs or inline base64. */
function parseFileUploads(raw?: unknown): ParsedUpload[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: ParsedUpload[] = [];
	for (const f of raw) {
		if (!f || typeof f !== "object") continue;
		const name = typeof (f as any).name === "string" ? (f as any).name : "";
		const path = typeof (f as any).path === "string" ? (f as any).path : "";
		if (path) {
			out.push({ kind: "staged", name, path });
			continue;
		}
		const url = typeof (f as any).dataUrl === "string" ? (f as any).dataUrl : "";
		const m = url.match(/^data:[^;]*;base64,(.+)$/s);
		if (!m) continue;
		out.push({ kind: "inline", name, data: m[1] });
	}
	return out.length ? out : undefined;
}

/** Keep a user-supplied filename to a safe basename (no traversal, no exotic chars). */
function sanitizeFilename(name: string): string {
	const base = (name.split(/[\\/]/).pop() || "file").replace(/^\.+/, "");
	const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").trim().slice(0, 120);
	return cleaned || "file";
}

/** Resolve `p` and confirm it lives inside UPLOADS_DIR — guards against a
 *  client-supplied {name,path} ref pointing the agent at an arbitrary file. */
function isWithinUploads(p: string): boolean {
	try {
		const real = realpathSync(p);
		const base = realpathSync(UPLOADS_DIR);
		return real === base || real.startsWith(base + "/");
	} catch {
		return false;
	}
}

/** Pick a collision-free absolute path under `dir` for the sanitized `wanted`. */
function uniqueUploadPath(dir: string, wanted: string, used?: Set<string>): string {
	let fname = wanted;
	let i = 1;
	while (used?.has(fname) || existsSync(`${dir}/${fname}`)) {
		const dot = wanted.lastIndexOf(".");
		fname =
			dot > 0
				? `${wanted.slice(0, dot)}-${i}${wanted.slice(dot)}`
				: `${wanted}-${i}`;
		i++;
	}
	used?.add(fname);
	return `${dir}/${fname}`;
}

/**
 * Stream one HTTP upload body to the staging dir and return the {name, path} the
 * client echoes back in its next turn. Size cap enforced (the route rejects on
 * Content-Length first; this re-checks the actual bytes).
 */
async function stageHttpUpload(
	name: string,
	req: Request,
): Promise<{ name: string; path: string }> {
	mkdirSync(STAGED_UPLOADS_DIR, { recursive: true });
	const wanted = sanitizeFilename(name);
	const p = uniqueUploadPath(STAGED_UPLOADS_DIR, wanted);
	const buf = Buffer.from(await req.arrayBuffer());
	if (buf.length === 0) throw new Error("empty upload");
	if (buf.length > MAX_UPLOAD_BYTES)
		throw new Error(
			`file too large (${buf.length} bytes, max ${MAX_UPLOAD_BYTES})`,
		);
	writeFileSync(p, buf);
	return { name: name || wanted, path: p };
}

/**
 * Turn normalized uploads into on-disk {name, path} pairs the agent can read.
 * Pre-staged refs (HTTP) are validated (confined to UPLOADS_DIR, exists, within
 * cap) and passed through; inline base64 is written to a per-session dir (outside
 * any repo, so it never pollutes git). Collisions de-duped, oversized skipped.
 */
function stageUploads(
	sessionId: string,
	uploads: ParsedUpload[],
): { name: string; path: string }[] {
	const dir = `${UPLOADS_DIR}/${sessionId}`;
	mkdirSync(dir, { recursive: true });
	const staged: { name: string; path: string }[] = [];
	const used = new Set<string>();
	for (const up of uploads) {
		if (up.kind === "staged") {
			if (!isWithinUploads(up.path) || !existsSync(up.path)) {
				console.warn(
					`[uploads] Dropping staged ref outside uploads dir: ${up.path}`,
				);
				continue;
			}
			let sz = 0;
			try {
				sz = statSync(up.path).size;
			} catch {
				continue;
			}
			if (sz === 0 || sz > MAX_UPLOAD_BYTES) {
				console.warn(`[uploads] Skipping ${up.name || up.path} — ${sz} bytes`);
				continue;
			}
			staged.push({
				name: up.name || up.path.split("/").pop() || "file",
				path: up.path,
			});
			continue;
		}
		const buf = Buffer.from(up.data, "base64");
		if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
			console.warn(
				`[uploads] Skipping ${up.name || "(unnamed)"} for ${sessionId} — ${buf.length} bytes`,
			);
			continue;
		}
		const wanted = sanitizeFilename(up.name);
		const p = uniqueUploadPath(dir, wanted, used);
		writeFileSync(p, buf);
		staged.push({ name: up.name || wanted, path: p });
	}
	return staged;
}

/** Append a note listing staged upload paths so the agent knows to read them. */
function withUploadsNote(prompt: string, staged: { name: string; path: string }[]): string {
	if (!staged.length) return prompt;
	const lines = staged.map((s) => `- ${s.name}: ${s.path}`).join("\n");
	return `${prompt}\n\n[The user attached ${staged.length} file(s), saved to disk — read them with your file tools if relevant:\n${lines}\n]`;
}

/** Parse + stage composer file attachments in one step; returns the prompt note-augmenter. */
function stageFileAttachments(
	sessionId: string,
	raw?: unknown,
): { name: string; path: string }[] {
	const uploads = parseFileUploads(raw);
	if (!uploads) return [];
	return stageUploads(sessionId, uploads);
}

// Messages queued while a run we didn't start is in flight (Slack runs, CLI
// sessions in tmux, automations) have no drain loop of their own — watch the
// busy state and deliver the queue once the external run finishes.
const drainWatchers: Set<string> = (g.__drainWatchers ??= new Set());
function watchExternalRunAndDrain(sessionId: string): void {
	if (drainWatchers.has(sessionId)) return;
	drainWatchers.add(sessionId);
	const timer = setInterval(async () => {
		const session = findSession(sessionId);
		if (!session || !(promptQueues.get(sessionId) || []).length) {
			clearInterval(timer);
			drainWatchers.delete(sessionId);
			return;
		}
		if (
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		)
			return;
		clearInterval(timer);
		drainWatchers.delete(sessionId);
		try {
			await drainQueue(sessionId);
		} catch (e) {
			console.error(
				`[queue] Drain after external run failed for ${sessionId}:`,
				e,
			);
		}
	}, 3000);
}

/**
 * Fold a completed run's usage into a session's cumulative totals. Cost and
 * token counts accumulate; context size (contextTokens/contextWindow) reflects
 * the latest turn rather than a sum — it's the current window fill, not lifetime
 * throughput. `costApproximate` sticks once any Codex run contributes a
 * table-priced (non-authoritative) figure.
 */
function foldSessionUsage(
	prev: SessionUsage | undefined,
	turn: TurnUsage,
	model?: string | null,
): SessionUsage {
	const base: SessionUsage = prev ?? {
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		contextTokens: 0,
		contextWindow: 0,
		turns: 0,
		updatedAt: "",
	};
	return {
		costUsd: base.costUsd + (turn.costUsd || 0),
		...(base.costApproximate || turn.costApproximate
			? { costApproximate: true }
			: {}),
		inputTokens: base.inputTokens + turn.inputTokens,
		outputTokens: base.outputTokens + turn.outputTokens,
		cacheReadTokens: base.cacheReadTokens + turn.cacheReadTokens,
		cacheCreationTokens: base.cacheCreationTokens + turn.cacheCreationTokens,
		contextTokens: turn.contextTokens || base.contextTokens,
		contextWindow: contextWindowFor(model) || base.contextWindow,
		turns: base.turns + 1,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Silent auto-push: when a session's turn ends idle, publish any local commits
 * that are ahead of an already-tracked upstream. This is the real "sessions push
 * automatically" mechanism — the agent's prompt-level `git push` is best-effort
 * and silently misses whenever a turn ends between commit and push (or the
 * commits landed outside a turn), leaving the status header parked on a stale
 * "Ahead by N commits". We only touch a branch that:
 *   - is NOT the repo's default branch — never auto-push main/master (this also
 *     excludes the backstage shared checkout, which pushes master by hand), and
 *   - already has an upstream (published once, so pushing follow-up commits is
 *     the expected sync; an un-pushed branch with no PR goes via Create PR), and
 *   - is strictly ahead (behind === 0) — a diverged branch needs a human/agent
 *     to reconcile, and a plain push would be rejected anyway.
 * Never forces. A failed push is swallowed (logged) — it just leaves the Push
 * button as the visible fallback. Fire-and-forget from the turn-end path so it
 * never delays draining the queue; a `git_pushed` broadcast nudges the header to
 * refetch the instant the push lands.
 */
async function autoPushSessionBranches(session: UnifiedSession): Promise<void> {
	const targets: Array<{ dir: string; branch: string; repoId: string }> = [];
	const primaryRepoId =
		session.repo ||
		(session.worktreeDir ? repoForPath(session.worktreeDir).id : "tella-fusion");
	if (session.worktreeDir && session.branch)
		targets.push({
			dir: session.worktreeDir,
			branch: session.branch,
			repoId: primaryRepoId,
		});
	for (const att of session.attachedRepos || [])
		if (att.dir && att.branch)
			targets.push({ dir: att.dir, branch: att.branch, repoId: att.repo });

	for (const { dir, branch, repoId } of targets) {
		// The primary dir of a volume-mode sandbox workspace exists only in the
		// container — status/push route through the session's sandbox exec.
		const isPrimary = dir === session.worktreeDir;
		const remote = isPrimary && hasRemoteWorkspace(session);
		if (!existsSync(dir) && !remote) continue;
		let repo;
		try {
			repo = getRepo(repoId);
		} catch {
			continue;
		}
		// Never auto-push the repo's mainline (covers the backstage shared master).
		if (branch === repo.defaultBranch) continue;
		const exec = isPrimary ? await workspaceExecFor(session, dir) : undefined;
		let git;
		try {
			git = await getGitStatus(dir, repo.defaultBranch, exec);
		} catch {
			continue;
		}
		if (!git.hasUpstream || git.ahead <= 0 || git.behind > 0) continue;
		const result = await gitPush(dir, branch, exec);
		if ("error" in result) {
			console.warn(
				`[auto-push] ${session.id} ${repoId}/${branch}: ${result.error}`,
			);
		} else {
			console.log(
				`[auto-push] ${session.id} ${repoId}/${branch}: pushed ${git.ahead} commit(s)`,
			);
			broadcastToSession(session.id, {
				type: "git_pushed",
				sessionId: session.id,
				repo: repoId,
			});
		}
	}
}

/**
 * Tear down a session's sandbox (container + engine-state volumes; in
 * volume-workspace mode also the workspace volume — documented data loss).
 * Best-effort and detached so a docker hiccup never blocks the caller
 * (session delete, archive sweep). `clearSandboxId` drops the stale id from
 * the session file so later sweeps don't re-destroy — only for sessions that
 * keep existing (the archive sweep); a deleted session has no file to touch.
 */
function destroySessionSandbox(
	session: UnifiedSession,
	why: string,
	clearSandboxId = false,
): void {
	const sb = session.sandbox;
	if (!sb?.sandboxId) return;
	void (async () => {
		try {
			await getSandboxProvider(sb.provider).destroy(sb.sandboxId!);
			console.log(
				`[sandbox] destroyed ${sb.sandboxId} for ${session.id} (${why})`,
			);
			if (clearSandboxId && session.source === "backstage")
				touchBackstageSession(session.id, {
					sandbox: { ...sb, sandboxId: undefined },
				});
		} catch (e) {
			console.warn(
				`[sandbox] destroy ${sb.sandboxId} for ${session.id} (${why}) failed:`,
				e,
			);
		}
	})();
}

/**
 * The session's docker sandbox when it is ACTIVE right now — materialized,
 * config + kill-switch still allow docker, and the container actually running
 * (never started here; same gating as workspace-exec). Null = treat the
 * session as host-local. Used by the preview routes to decide whether the dev
 * server lives in-container.
 */
async function activeSandboxFor(session: UnifiedSession): Promise<Sandbox | null> {
	const sb = session.sandbox;
	if (sb?.provider !== "docker" || !sb.sandboxId) return null;
	if (!sandboxesEnabled()) return null;
	if (effectiveSandboxProvider(session.repo) !== "docker") return null;
	try {
		if ((await dockerContainerStatus(sb.sandboxId)) !== "running") return null;
		return await getSandboxProvider("docker").get(sb.sandboxId);
	} catch {
		return null;
	}
}

/**
 * Docker-sandbox routing for runSessionPromptInner (docs/sandboxes-plan.md
 * Phase 1). Returns the run's event stream when the session opted into a
 * docker sandbox at create time AND the config + kill-switch currently allow
 * it — otherwise null, and the caller's existing in-process runAgent path
 * runs completely unchanged (sessions without a `sandbox` field can never
 * reach any of this).
 *
 * Every failure mode falls back to null (in-process on the host): that is
 * exactly today's trust level for interactive sessions, and a session must
 * never lose a prompt to sandbox infrastructure. Automation-owned sessions
 * are refused outright — Phase 1 sandboxes carry interactive-parity mounts
 * (~/.ssh, gh, account pool) that untrusted prompt text must not reach.
 */
async function maybeLaunchSandboxedRun(
	session: UnifiedSession,
	opts: {
		prompt: string;
		engineSessionId?: string;
		cwd: string;
		user?: string;
		images?: ImageInput[];
		mcpServers?: string[];
		isAutomationSession: boolean;
	},
): Promise<AsyncGenerator<StreamEvent> | null> {
	if (session.sandbox?.provider !== "docker") return null;
	if (!sandboxesEnabled()) return null; // kill-switch file — instant revert
	if (effectiveSandboxProvider(session.repo) !== "docker") return null;
	if (opts.isAutomationSession) {
		console.warn(`[sandbox] ${session.id}: automation sessions are not sandboxed in Phase 1 — running on host`);
		return null;
	}
	// Hoisted so the catch below can unregister it — a failed launch must not
	// leak the run token (spawnHostRun's error path does the same cleanup).
	let rpcToken: string | undefined;
	try {
		const provider = getSandboxProvider("docker");
		const sandbox = await provider.ensure({
			sessionId: session.id,
			repo: session.repo,
			branch: session.branch || undefined,
			mode: session.mode,
			cwd: opts.cwd,
			// Bind-mode containers mount attached repos too (a changed set
			// recreates the container); volume mode rejects them in ensure().
			attachedDirs: (session.attachedRepos || [])
				.map((r) => r.dir)
				.filter(Boolean),
		});
		if (
			session.source === "backstage" &&
			(session.sandbox?.sandboxId !== sandbox.id ||
				session.sandbox?.workspace !== sandbox.workspace)
		) {
			touchBackstageSession(session.id, {
				sandbox: {
					provider: "docker",
					sandboxId: sandbox.id,
					// Record how the workspace materialized ("volume" = it lives only
					// inside the sandbox; host existsSync guards must not gate it).
					workspace: sandbox.workspace,
				},
			});
		}
		// michael-* tools reach the container as stdio proxies over the run-rpc
		// socket — same path Codex and hosted runs use. The names must match
		// what the registered InteractiveMcpBuilder can build for this session —
		// including michael-goal-self for goal-driven sessions (the builder adds
		// it from the session's goalId, mirroring the in-process path below).
		const proxyMcpServers = [
			...Object.keys(interactiveMcpServers(opts.user, session.id)),
			...(session.goalId ? ["michael-goal-self"] : []),
		];
		rpcToken = crypto.randomUUID();
		registerRunToken(rpcToken, { sessionId: session.id, user: opts.user });
		const spec: RunHostSpec = {
			hostId: `rh-${randomUUIDv7()}`,
			bksSessionId: session.id,
			prompt: opts.prompt,
			engineSessionId: opts.engineSessionId || undefined,
			cwd: sandbox.cwd,
			mode: session.mode,
			model: session.model,
			images: opts.images,
			mcpServers: opts.mcpServers,
			proxyMcpServers,
			rpcToken,
			reposNote: buildReposNote(session),
			confirmTools: STRIPE_CONFIRM_TOOLS,
			aws: true,
			author: gitIdentityFor(opts.user),
			user: opts.user,
			fallbackModel: interactiveFallbackModel(session.model),
			effort: session.effort,
			accountId: session.accountId,
			journalKind: "prompt",
		};
		const runCallbacks = {
			onAskUser: makeAskHandler(session.id),
			// A steer that reached the in-container run too late must not
			// evaporate — queue it like the busy-path does.
			onSteerFailed: (text: string) => {
				enqueuePrompt(session.id, { content: text, user: opts.user });
				watchExternalRunAndDrain(session.id);
			},
		};
		// Launch EAGERLY (docker exec + socket connect awaited here) so a failure
		// is caught by this try/catch and falls back to the host run — a lazy
		// launch would only surface the failure as an error bubble mid-stream,
		// after the fallback window has closed.
		const handle = sandbox.launchRunEager
			? await sandbox.launchRunEager(spec, runCallbacks)
			: sandbox.launchRun(spec, runCallbacks);
		console.log(`[sandbox] ${session.id}: running in ${sandbox.id} (${sandbox.cwd})`);
		return handle.events();
	} catch (e: any) {
		// The token was registered mid-try; the failed run will never consume it.
		unregisterRunToken(rpcToken);
		const reason = String(e?.message || e).slice(0, 200);
		if (hasRemoteWorkspace(session)) {
			// Volume-mode workspaces live only inside the sandbox — there is no
			// host checkout to fall back to (the caller ends the turn with an
			// explicit error), so don't promise a host run.
			console.error(`[sandbox] ${session.id}: launch failed (volume workspace — no host fallback):`, e);
			broadcastToSession(session.id, {
				type: "notice",
				message: `Sandbox unavailable (${reason}) — this workspace lives in the sandbox and has no host fallback. Retry when Docker is healthy.`,
			});
		} else {
			console.error(`[sandbox] ${session.id}: launch failed — falling back to host run:`, e);
			broadcastToSession(session.id, {
				type: "notice",
				message: `Sandbox unavailable (${reason}) — running on the host this turn.`,
			});
		}
		return null;
	}
}

/** Run a prompt against an existing session, broadcasting to all watchers. */
async function runSessionPrompt(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextChats?: string[],
): Promise<void> {
	// Any explicit new run lifts a user stop — the queue may drain again.
	stoppedSessions.delete(sessionId);
	// Synchronously reserve the session BEFORE the awaits below (worktree revive,
	// title gen, upload staging) register the run with the runner — otherwise two
	// racing prompts both pass isAgentSessionBusy and the loser's message is
	// dropped as a "Session is busy" error toast.
	markSessionStarting(sessionId);
	try {
		await runSessionPromptInner(sessionId, content, user, images, rawFiles, contextChats);
	} finally {
		unmarkSessionStarting(sessionId);
	}
}

async function runSessionPromptInner(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextChats?: string[],
): Promise<void> {
	const session = findSession(sessionId);
	if (!session) return;

	// The engine session id depends on the session's model: codex models resume
	// the codex thread, claude models the claude session. A missing engine id
	// just means "first run on this provider" — a fresh thread/session starts.
	const provider = providerFor(session.model);
	let effectiveProvider = provider;
	let effectiveModel = session.model;
	// Cumulative token/cost accounting — seeded from the session's stored total,
	// folded per run, persisted + broadcast live (see the `usage_snapshot` and
	// `done` cases). `usageBase` is the total as of the last *completed* run:
	// snapshots are run-cumulative, so each fold recomputes base+run rather than
	// stacking onto the previous snapshot (which would double-count).
	let latestUsage: SessionUsage | undefined = session.usage;
	let usageBase: SessionUsage | undefined = latestUsage;
	const engineSessionId =
		provider === "codex" ? session.codexThreadId : session.claudeSessionId;
	// A claude session with no engine id yet is a *fresh* chat (e.g. a new sibling
	// chat opened from the tab strip's +): its first prompt starts a new claude
	// conversation, and finalSessionId is persisted below — same as codex, which
	// already runs fresh with no thread id. (Previously this hard-errored, which
	// blocked never-run sessions from ever receiving their first message.)
	if (provider === "claude" && !engineSessionId) {
		console.log(`[prompt] ${sessionId}: first claude run (no engine id yet)`);
	}

	// Cross-provider handoff: the session's model was switched to the other engine
	// (Fable orchestrator → gpt-5.5 executor, or back) since the last run. The
	// incoming engine has no memory of the conversation — its thread either never
	// existed or is stale — so bridge it with the recent transcript from whichever
	// engine last drove the session. Without this, a mid-session /model switch
	// across providers drops the agent into a blank continuation. (Same-provider
	// switches — opus↔sonnet, gpt-5.5↔codex — resume their own thread and need no
	// bridge.) Recorded provider is set after every run below.
	const lastProvider = session.lastEngineProvider;
	let switchHandoff: string | null = null;
	if (lastProvider && lastProvider !== provider) {
		const prevEngineId =
			lastProvider === "codex" ? session.codexThreadId : session.claudeSessionId;
		const prevTranscriptPath = prevEngineId
			? getEngineTranscriptPath(
					session.worktreeDir || `${HOME}/projects/tella-fusion`,
					prevEngineId,
					lastProvider,
				)
			: null;
		const prevEntries = prevTranscriptPath
			? parseTranscript(prevTranscriptPath)
			: [];
		if (prevEntries.length) {
			// Claude coming back to a thread it already ran (engineSessionId set)
			// remembers everything up to the switch and only needs the interim
			// turns; a fresh target treats the transcript as the whole conversation.
			switchHandoff = buildEngineSwitchHandoffNote({
				// The model that last drove the session is the second-to-last
				// modelHistory entry (the last is the switch into the current model).
				fromModel:
					session.modelHistory && session.modelHistory.length >= 2
						? session.modelHistory[session.modelHistory.length - 2].model
						: undefined,
				fromProvider: lastProvider,
				toProvider: provider,
				targetResuming: !!engineSessionId,
				entries: prevEntries,
			});
			console.log(
				`[prompt] ${sessionId}: cross-provider switch ${lastProvider}→${provider}; bridging ${prevEntries.length} transcript entries`,
			);
		}
	}

	// A cleaned-up worktree makes the SDK spawn fail with a misleading "binary
	// not found" (ENOENT on the missing cwd) — revive it first. Same path as
	// before, so resuming the claude session keeps its history. Volume-mode
	// sandbox workspaces are exempt: their dir never exists host-side — the
	// sandbox provider materializes it in-container, so reviving a host
	// worktree at the same path would shadow (and fork) the real workspace.
	let cwd = session.worktreeDir || `${HOME}/projects/tella-fusion`;
	if (
		session.worktreeDir &&
		!existsSync(session.worktreeDir) &&
		!hasRemoteWorkspace(session)
	) {
		const repo = session.repo
			? getRepo(session.repo)
			: repoForPath(session.worktreeDir);
		if (session.branch) {
			broadcastToSession(sessionId, {
				type: "notice",
				message: `This session's worktree was cleaned up — recreating it from branch ${session.branch}…`,
			});
			try {
				cwd = await reviveWorktree(session.branch, repo.id);
			} catch (e) {
				broadcastToSession(sessionId, {
					type: "notice",
					message: `Couldn't recreate the worktree (${e}); running in the main checkout instead.`,
				});
				cwd = repo.repo;
			}
		} else {
			broadcastToSession(sessionId, {
				type: "notice",
				message:
					"This session's worktree is gone; running in the main checkout.",
			});
			cwd = repo.repo;
		}
	}
	let prompt = content;
	// A teammate sending into someone else's idle session gets the same
	// "[Name] " attribution the steer path already applies — without it the
	// message lands bare in the transcript and the viewer credits it to the
	// session owner (startedBy). The owner's own turns stay bare (the common
	// case), automation runs pass no user, and multi-message queue drains
	// arrive pre-attributed — don't double-prefix those.
	if (
		user &&
		user !== session.startedBy &&
		!content.startsWith(`[${user}] `)
	) {
		prompt = `[${user}] ${prompt}`;
	}
	// Bridge a cross-provider engine switch (computed above) so the incoming
	// engine continues the conversation instead of starting blank. Fenced so the
	// transcript shows only the human's message — the model-switch divider already
	// marks the engine change; the handoff itself is plumbing (see prompt-context).
	if (switchHandoff) prompt = `${wrapContext(switchHandoff)}\n\n${prompt}`;
	// Sibling-chat transcripts attached from the fresh-chat "Add chat
	// transcripts" chips: inline a bounded digest of each attached chat, fenced
	// so the rendered transcript shows only the human's message. UI-only field,
	// but skip automation sessions anyway (their prompts are untrusted text).
	if (contextChats?.length && !session.automation) {
		const attachedChats = [...new Set(contextChats)]
			.filter((id) => id !== sessionId)
			.map((id) => findSession(id))
			.filter((s): s is UnifiedSession => !!s)
			.map((s) => ({
				id: s.id,
				title: s.title,
				model: s.model,
				entries: s.transcriptPath ? parseTranscript(s.transcriptPath) : [],
			}));
		if (attachedChats.length)
			prompt = `${wrapContext(buildChatContextNote(attachedChats))}\n\n${prompt}`;
	}
	// Non-image attachments: stage to disk and tell the agent where they landed.
	prompt = withUploadsNote(prompt, stageFileAttachments(sessionId, rawFiles));
	if (session.goal) {
		prompt += `\n\n[Pinned session goal — keep working toward it and note how this turn advanced it: ${session.goal}]`;
	}

	// Resuming an automation-owned session must keep that automation's scoping
	// (MCP allowlist + tool denials) — otherwise a resume would silently hand it
	// every MCP server and drop the customer/identity write denials.
	const isAutomationSession = !!session.automation;
	const mcpServers = isAutomationSession
		? automationMcpServersByName(session.automation!)
		: (session.mcpServers && session.mcpServers.length) ? session.mcpServers : [];
	const deniedTools = isAutomationSession ? automationDeniedTools() : undefined;

	// @session:<id> mentions → footer resolving them for the agent's
	// michael-sessions tools. Interactive sessions only (same gate as the tools).
	if (!isAutomationSession) {
		const mentionsNote = sessionMentionsNote(prompt);
		if (mentionsNote) prompt += `\n\n${mentionsNote}`;
	}

	// Sidebar name: make sure this chat has a short generated summary title.
	// Covers tab-strip "New chat" chats (never named at creation — this is
	// their first prompt) and retries chats whose creation-time Haiku call
	// failed (e.g. account exhaustion), which otherwise wear the raw first
	// line of the prompt forever. Retries summarize the stored provisional
	// title (the opening prompt's first line), not this turn's message, so a
	// mid-conversation "yes, do it" never becomes the title source. Automation
	// and goal sessions carry deliberate titles; a manual rename wins anyway.
	if (
		session.source === "backstage" &&
		!isAutomationSession &&
		!session.goalId &&
		!getTitleOverride(session.id)
	) {
		const provisional = !session.title || session.title === "New chat";
		const firstLine = content.trim().split("\n")[0].slice(0, 80);
		if (provisional && firstLine)
			touchBackstageSession(session.id, { title: firstLine });
		void ensureGeneratedTitle(
			session.id,
			provisional ? content : session.title,
			user || session.startedBy || undefined,
			session.model || undefined,
		).then((t) => {
			if (t) sessionsCache = null;
		});
	}

	// Everyone viewing this session sees the prompt and the live run
	broadcastToSession(sessionId, {
		type: "stream_start",
		sessionId,
		by: user || "Anonymous",
	});
	broadcastToSession(sessionId, {
		type: "session_status",
		sessionId,
		isRunning: true,
	});

	// Sandbox routing (docs/sandboxes-plan.md Phase 1): a session that opted
	// into a docker sandbox runs this prompt inside its per-session container;
	// null (the default for every session without the opt-in field, plus every
	// failure/kill-switch case) = the unchanged in-process path below.
	const sandboxRun = await maybeLaunchSandboxedRun(session, {
		prompt,
		engineSessionId: engineSessionId || undefined,
		cwd,
		user,
		images,
		mcpServers,
		isAutomationSession,
	});

	// A volume-mode workspace exists ONLY inside its sandbox — there is no
	// host fallback (runAgent on the nonexistent host path would just ENOENT,
	// and running in the main checkout instead would be worse). End the turn
	// with an explicit error; the kill-switch/config flip that caused this is
	// an operator action, not a transient.
	if (!sandboxRun && hasRemoteWorkspace(session)) {
		const msg =
			"This session's workspace lives in its sandbox volume, but the sandbox is unavailable (disabled by config/kill-switch, or it failed to start) — the prompt was not run. Re-enable sandboxes and try again.";
		broadcastToSession(sessionId, { type: "error", sessionId, message: msg });
		recordRunOutcome(session.id, msg);
		broadcastToSession(sessionId, { type: "stream_done", sessionId });
		broadcastToSession(sessionId, {
			type: "session_status",
			sessionId,
			isRunning: false,
		});
		return;
	}

	let finalSessionId = engineSessionId || "";
	let endedWithError = false;
	// Terminal failure this run died on (usage limits with no account left,
	// credit/API errors) — recorded on the session after the loop so the sidebar
	// surfaces it as "Needs input"; null (a clean finish) clears an earlier one.
	let runFailure: string | null = null;
	// Accumulate the assistant reply so we can mirror it to a linked Slack channel
	// (this path — queue drain / deliverToSession / loops — is where a channel
	// @mention lands; web-typed prompts stream through the WS handler instead, so
	// they don't spam the channel).
	let assistantText = "";

	for await (const event of sandboxRun ?? runAgent({
		prompt,
		sessionId: engineSessionId || undefined,
		cwd,
		mode: session.mode,
		model: session.model,
		// Reasoning effort from the composer pill, persisted on the session.
		effort: session.effort,
		// Pinned subscription for this session (claude-runner prefers it, pool
		// fallback on exhaustion). Ignored by Codex models.
		accountId: session.accountId,
		// Only switch models when a fallback is explicitly configured. By default,
		// usage exhaustion stops the run so the human can choose what to do.
		fallbackModel: interactiveFallbackModel(session.model),
		images,
		mcpServers,
		// Self-management tools for normal sessions; withheld from automation
		// sessions (and their interactive resumes) — same gate as deniedTools above.
		// A goal-driven session also gets its own michael-goal-self controls, so an
		// interactive turn (a human steering it in the UI) can set the next wake,
		// append to the ledger, or pause/finish — the same tools the headless wake has.
		inProcessMcp: isAutomationSession
			? undefined
			: session.goalId
				? {
						...interactiveMcpServers(user, sessionId),
						"michael-goal-self": createGoalSelfMcpServer(session.goalId),
					}
				: interactiveMcpServers(user, sessionId),
		reposNote: isAutomationSession ? undefined : buildReposNote(session),
		deniedTools,
		confirmTools: STRIPE_CONFIRM_TOOLS,
		aws: true, // sessions keep AWS read access (via injected creds)
		// Attribute any commits this turn makes to whoever sent the prompt.
		author: gitIdentityFor(user),
		// Gate per-user MCP servers (allowedUsers) to the prompt's author. Automation
		// sessions pass no user, so they never see a user-restricted server.
		user: isAutomationSession ? undefined : user,
		journal: { bksSessionId: session.id, kind: "prompt" },
		onAskUser: makeAskHandler(sessionId),
	})) {
		switch (event.type) {
			case "init":
				if (event.provider) effectiveProvider = event.provider;
				if (event.model) effectiveModel = event.model;
				if (event.sessionId && event.sessionId !== finalSessionId) {
					finalSessionId = event.sessionId;
					// The engine session id just changed (first run of a fresh chat, or
					// a rotation fork): the run writes to a transcript file nobody is
					// watching yet. Persist + attach NOW — waiting for the run to end
					// (the old behavior) left the entire turn invisible to viewers.
					if (session.source === "backstage") {
						touchBackstageSession(session.id, {
							...engineSessionPatch(effectiveProvider, finalSessionId),
							lastEngineProvider: effectiveProvider,
							...(effectiveModel ? { model: effectiveModel } : {}),
						});
						sessionsCache = null; // new watchers must see the new transcriptPath
					}
					attachSessionWatchersToEngineTranscript(
						sessionId,
						effectiveProvider,
						cwd,
						finalSessionId,
					);
				}
				break;
			case "text_chunk":
				assistantText += event.text;
				broadcastToSession(sessionId, {
					type: "stream_text",
					sessionId,
					text: event.text,
				});
				break;
			case "model_switch": {
				// The primary model ran out of credits pool-wide and the runner
				// switched this session to a fallback (auto-switch is on). Record it
				// the same way a manual /model switch is recorded — a persisted
				// modelHistory entry (durable inline divider on reload) plus a live
				// model_changed broadcast (pill + divider now) — and move the session
				// onto the fallback so later prompts don't re-hit the exhausted model.
				const to = event.toModel || "";
				const reason = `auto-switch — ${modelLabel(event.fromModel)} out of credits`;
				if (to) {
					effectiveModel = to;
					effectiveProvider = providerFor(to);
				}
				if (to && session.source === "backstage") {
					touchBackstageSession(session.id, {
						model: to,
						modelHistory: [
							...(session.modelHistory || []),
							{ model: to, from: event.fromModel, at: new Date().toISOString(), by: reason },
						],
					});
					sessionsCache = null;
				}
				if (to)
					broadcastToSession(sessionId, {
						type: "model_changed",
						sessionId,
						model: to,
						from: event.fromModel,
						by: reason,
					});
				break;
			}
			case "tool_use":
				broadcastToSession(sessionId, {
					type: "stream_tool_use",
					sessionId,
					entry: {
						id: event.toolUseId || crypto.randomUUID(),
						type: "tool_use",
						content: `Using ${event.toolName}`,
						timestamp: new Date().toISOString(),
						toolName: event.toolName,
						toolInput: event.toolInput,
						toolUseId: event.toolUseId,
					},
				});
				break;
			case "tool_result":
				broadcastToSession(sessionId, {
					type: "stream_tool_result",
					sessionId,
					entry: {
						// Same id scheme as the jsonl tail so the full (untruncated)
						// transcript entry upserts over this streamed copy
						id: event.toolUseId ? `tr-${event.toolUseId}` : crypto.randomUUID(),
						type: "tool_result",
						content: event.content || "",
						timestamp: new Date().toISOString(),
						toolUseId: event.toolUseId,
						...(event.images && event.images.length > 0
							? { images: event.images }
							: {}),
						...(event.videos && event.videos.length > 0
							? { videos: event.videos }
							: {}),
					},
				});
				break;
			case "usage_snapshot":
				// Live mid-run cost/context — same fold as `done`, recomputed from
				// the pre-run base (snapshots are cumulative for the run). Broadcast
				// only; persistence waits for the end of the run.
				if (event.usage) {
					latestUsage = foldSessionUsage(
						usageBase,
						event.usage,
						effectiveModel,
					);
					broadcastToSession(sessionId, {
						type: "usage_update",
						sessionId,
						usage: latestUsage,
					});
				}
				break;
			case "done":
				finalSessionId = event.sessionId || finalSessionId;
				if (event.provider) effectiveProvider = event.provider;
				if (event.model) effectiveModel = event.model;
				// Dying on usage limits with no account left reports as a `done`
				// whose result is the limit notice (not an `error` event) — but it
				// still needs a human, so treat it as a failure.
				if (event.usageLimitExhausted)
					runFailure = event.result || "Usage limit reached on every account";
				// Fold this run's token/cost into the session total and push it live
				// to viewers (persisted below with the rest of the session patch).
				if (event.usage) {
					latestUsage = foldSessionUsage(
						usageBase,
						event.usage,
						event.model || effectiveModel,
					);
					usageBase = latestUsage;
					broadcastToSession(sessionId, {
						type: "usage_update",
						sessionId,
						usage: latestUsage,
					});
				}
				sessionsCache = null;
				break;
			case "error":
				// "Session is busy" = we lost the start race to a concurrent run (the
				// pendingStarts guard closes most of that window; the runner's own
				// check is the last line). Queue the message for delivery after the
				// winning run instead of dropping it as an error toast. Return early:
				// the tail below (steer-receipt clearing, stream_done) belongs to the
				// run that actually owns the session.
				if (event.content === "Session is busy") {
					enqueuePrompt(sessionId, { content, user });
					watchExternalRunAndDrain(sessionId);
					broadcastToSession(sessionId, {
						type: "notice",
						message:
							"Session was busy — message queued; it sends when the current run finishes.",
					});
					return;
				}
				endedWithError = true;
				runFailure = event.content || "Run failed";
				broadcastToSession(sessionId, {
					type: "error",
					sessionId,
					message: event.content,
				});
				break;
		}
	}

	// Persist activity on our own session store (slack/linear stores are read-only)
	if (session.source === "backstage") {
		touchBackstageSession(
			session.id,
			{
				...engineSessionPatch(effectiveProvider, finalSessionId),
				lastEngineProvider: effectiveProvider,
				...(effectiveModel ? { model: effectiveModel } : {}),
				...(latestUsage ? { usage: latestUsage } : {}),
			},
		);
	}

	// A terminal failure keeps the session in the "Needs input" bucket until a
	// later run finishes cleanly (which clears it here too).
	recordRunOutcome(session.id, runFailure);

	// On a clean finish any steered messages already landed in the transcript, so
	// drop their display-only receipts. But if the run ended in error/abort (e.g.
	// a restart killed the SDK stream mid-turn), a steered message may NOT have
	// been delivered yet — keep the receipt so persistQueues/restorePromptQueues
	// can re-deliver it on the next boot instead of silently dropping it.
	if (!endedWithError) clearSteerReceipts(sessionId);

	broadcastToSession(sessionId, { type: "stream_done", sessionId });
	broadcastToSession(sessionId, {
		type: "session_status",
		sessionId,
		isRunning: false,
	});

	// Mirror Michael's reply into the session's linked Slack channel, so a channel
	// @mention (which routes here via deliverToSession) gets answered in-channel.
	if (session.slackChannel?.channelId && !endedWithError && assistantText.trim()) {
		void sendSlackMessage(
			session.slackChannel.channelId,
			assistantText.trim().slice(0, 38000),
		).catch(() => {});
	}

	// The session just finished a turn; if nothing's queued it's idle now, so fire
	// any "when_done" / "on_pr" human asks waiting on this session. Idempotent.
	if (!promptQueues.get(sessionId)?.length) {
		onHumanAsksSessionIdle(sessionId);
		// Publish any commits the turn left unpushed so the status header doesn't
		// linger on "Ahead by N commits" (see autoPushSessionBranches). Only on a
		// clean finish — an errored/aborted turn may be mid-work. Fire-and-forget.
		if (!endedWithError) void autoPushSessionBranches(session);
	}
}

/**
 * Backstage-native slash commands. Returns a notice string when the message
 * was consumed as a command, or null to send it to Claude as a normal prompt.
 */
/**
 * Expand `@session:bks-…` mentions in a prompt into a footer the agent can act
 * on with its michael-sessions tools. The mention token itself stays in place
 * (it carries the id); the footer resolves each id to a title/state and points
 * at the tools — including slash commands over send_to_session (e.g. "/loop").
 * Interactive sessions only: automations don't get michael-sessions.
 */
function sessionMentionsNote(content: string): string | null {
	// Only the human's visible message counts: fenced <backstage:context> blocks
	// (attached chat transcripts, handoffs) name sessions as @session:<id> too,
	// and those must not grow a redundant — and unfenced, so user-visible —
	// mentions footer.
	content = stripContext(content);
	const ids = [
		...new Set(
			[...content.matchAll(/@session:(bks-[0-9a-f-]+)/g)].map((m) => m[1]),
		),
	];
	if (!ids.length) return null;
	const lines = ids.map((id) => {
		const s = findSession(id);
		if (!s) return `- @session:${id} — (no session with this id)`;
		const busy = isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id);
		const bits = [
			s.title || "Untitled",
			s.branch ? `branch ${s.branch}` : null,
			busy ? "running" : "idle",
		].filter(Boolean);
		return `- @session:${id} — ${bits.join(" · ")}`;
	});
	return (
		`[The @session mentions above refer to other Backstage sessions:\n${lines.join("\n")}\n` +
		`Use the michael-sessions MCP tools with these ids: get_session (state, pending question, ` +
		`transcript tail), send_to_session (a message — or a slash command handled by backstage ` +
		`itself, e.g. "/loop 15m <prompt>" to set a recurring self-prompt on the target that fires ` +
		`only while it is idle, "/loop stop" to clear it; this works on your own session id too), ` +
		`answer_session_question, cancel_session.]`
	);
}

function handleSlashCommand(
	session: UnifiedSession,
	text: string,
	user?: string,
): string | null {
	if (
		!text.startsWith("/goal") &&
		!text.startsWith("/loop") &&
		!text.startsWith("/model") &&
		text !== "/sub" &&
		!text.startsWith("/sub ") &&
		text !== "/compact" &&
		!text.startsWith("/compact ") &&
		text !== "/help"
	) {
		return null;
	}
	if (session.source !== "backstage") {
		if (text.startsWith("/model") && session.source === "slack") {
			return "Set the model from Slack instead — send /model <name> in the Slack thread (its session file is agent-owned).";
		}
		return "Slash commands only work on backstage-created sessions (Slack/Linear session files are agent-owned).";
	}

	if (text === "/help") {
		return [
			"Backstage commands:",
			"/goal <text> — pin a goal, appended to every prompt until cleared",
			"/goal clear — remove the goal",
			"/loop <interval> <prompt> — re-run a prompt on an interval (e.g. /loop 30m check CI and fix failures)",
			"/loop stop — stop the loop",
			"/model — show the session's model and what's available",
			"/model <name> — switch model (e.g. /model opus, /model gpt-5.5)",
			"/sub — show the session's pinned Claude subscription and what's available",
			"/sub <name> — pin a specific subscription for this session's runs",
			"/sub auto — back to automatic (personal-first, shared-pool fallback)",
			"/compact — summarize the conversation so far to shrink context and cost (Claude sessions only)",
		].join("\n");
	}

	if (text === "/model" || text === "/model show" || text === "/model list") {
		return [
			`Current model: ${session.model || getDefaultModel()}${session.model ? "" : " (default)"}`,
			"",
			"Available models (set with /model <name or alias>):",
			formatModelList(session.model),
		].join("\n");
	}
	if (text.startsWith("/model ")) {
		const input = text.slice("/model ".length).trim();
		const resolved = resolveModel(input);
		if (!resolved) {
			return [
				`Unknown model "${input}". Available:`,
				formatModelList(session.model),
			].join("\n");
		}
		const prevModel = session.model || getDefaultModel();
		const prevProvider = providerFor(session.model);
		touchBackstageSession(session.id, {
			model: resolved.id,
			modelHistory: [
				...(session.modelHistory || []),
				{ model: resolved.id, from: prevModel, at: new Date().toISOString(), by: user },
			],
		});
		// Everyone watching sees the switch (pill + inline divider) immediately
		broadcastToSession(session.id, {
			type: "model_changed",
			sessionId: session.id,
			model: resolved.id,
			from: prevModel,
			by: user,
		});
		const switchedProvider = prevProvider !== resolved.provider;
		return (
			`Model set to ${resolved.id} (${modelLabel(resolved.id)}). Applies from the next prompt.` +
			(switchedProvider
				? resolved.provider === "codex"
					? " Heads up: this hands the wheel to Codex on the next prompt. The Codex engine can't share Claude's internal thread, so it gets a transcript handoff of the conversation so far and continues from there (switching back to a Claude model resumes its own history)."
					: " Heads up: this hands the wheel back to Claude on the next prompt. Claude resumes its own earlier history (if any) and gets a transcript handoff of the turns Codex ran in between."
				: "")
		);
	}

	// Pin (or clear) the Claude subscription used for this session's runs. Like
	// /model, it persists on the session, broadcasts to every viewer, and applies
	// from the next prompt; unlike /model it's a preference the runner falls back
	// off when the pinned account is exhausted (never a hard requirement).
	if (text === "/sub" || text === "/sub show" || text === "/sub list") {
		const accounts = listAccountsPublic();
		const current = session.accountId
			? accounts.find((a) => a.id === session.accountId)
			: null;
		const line = (a: ClaudeAccountPublic) =>
			`${a.id === session.accountId ? "• " : "  "}${a.name}` +
			`${a.owner ? ` (personal — ${a.owner})` : " (pool)"}` +
			`${a.usable ? "" : " — exhausted"}`;
		return [
			`Subscription: ${current ? current.name : "auto (personal-first, pool fallback)"}`,
			"",
			"Available (set with /sub <name>, or /sub auto to unpin):",
			...accounts.map(line),
		].join("\n");
	}
	if (
		text === "/sub auto" ||
		text === "/sub clear" ||
		text === "/sub none" ||
		text === "/sub default"
	) {
		touchBackstageSession(session.id, { accountId: undefined });
		broadcastToSession(session.id, {
			type: "subscription_changed",
			sessionId: session.id,
			accountId: null,
			name: null,
			by: user,
		});
		return "Subscription set to auto (personal-first, shared-pool fallback). Applies from the next prompt.";
	}
	if (text.startsWith("/sub ")) {
		const input = text.slice("/sub ".length).trim();
		const accounts = listAccountsPublic();
		const match =
			accounts.find((a) => a.id === input) ||
			accounts.find((a) => a.name.toLowerCase() === input.toLowerCase());
		if (!match) {
			return [
				`Unknown subscription "${input}". Available:`,
				...accounts.map((a) => `  ${a.name}${a.owner ? ` (personal — ${a.owner})` : " (pool)"}`),
			].join("\n");
		}
		touchBackstageSession(session.id, { accountId: match.id });
		broadcastToSession(session.id, {
			type: "subscription_changed",
			sessionId: session.id,
			accountId: match.id,
			name: match.name,
			by: user,
		});
		const codexNote =
			providerFor(session.model) === "codex"
				? " Note: this session is on a Codex model, which uses its own accounts — the pin applies when you switch back to a Claude model."
				: "";
		const exhaustedNote = match.usable
			? ""
			: " Heads up: this subscription is currently exhausted, so runs fall back to the pool until it resets.";
		return `Subscription pinned to ${match.name}. Applies from the next prompt.${codexNote}${exhaustedNote}`;
	}

	// /compact is a built-in command of the Claude Agent SDK, not a backstage
	// config change: we return null so the "/compact" text flows through to the
	// runner, where the SDK summarizes the live context and continues from that
	// summary (emitting a compact_boundary). We intercept only to (a) block it on
	// Codex sessions, which have no such command and would otherwise get the
	// literal text as a prompt, and (b) give the room immediate feedback, since
	// the SDK's own output for the command is terse. Unlike the marathon-session
	// problem this exists to fight, it's a manual lever — auto-compact still only
	// fires near the context-window ceiling.
	if (text === "/compact" || text.startsWith("/compact ")) {
		if (providerFor(session.model) === "codex") {
			return "/compact only applies to Claude sessions — Codex manages its own context window. Switch to a Claude model with /model first, or start a fresh session to shed context.";
		}
		broadcastToSession(session.id, {
			type: "notice",
			sessionId: session.id,
			message:
				"Compacting context — the next reply continues from a summary of the conversation so far.",
		});
		return null; // fall through: the SDK runs its built-in /compact on this turn
	}

	if (text === "/goal" || text === "/goal show") {
		return session.goal
			? `Current goal: ${session.goal}`
			: "No goal set. Use /goal <text>.";
	}
	if (text === "/goal clear") {
		touchBackstageSession(session.id, { goal: undefined });
		return "Goal cleared.";
	}
	if (text.startsWith("/goal ")) {
		const goal = text.slice("/goal ".length).trim();
		if (!goal) return "Usage: /goal <text>";
		touchBackstageSession(session.id, { goal });
		return `Goal pinned: ${goal} — it will ride along with every prompt until /goal clear.`;
	}

	if (text === "/loop" || text === "/loop status") {
		return session.loop
			? `Loop active: every ${session.loop.intervalMinutes}m — "${session.loop.prompt}"`
			: "No loop set. Use /loop <interval> <prompt> (e.g. /loop 30m check CI).";
	}
	if (text === "/loop stop" || text === "/loop off" || text === "/loop clear") {
		touchBackstageSession(session.id, { loop: undefined });
		return "Loop stopped.";
	}
	if (text.startsWith("/loop ")) {
		const rest = text.slice("/loop ".length).trim();
		const match = rest.match(/^(\d+)\s*(m|min|h|hr)?\s+([\s\S]+)$/);
		if (!match)
			return "Usage: /loop <interval> <prompt> — e.g. /loop 30m check CI and fix failures";
		let minutes = parseInt(match[1]);
		if (match[2] === "h" || match[2] === "hr") minutes *= 60;
		minutes = Math.max(5, minutes);
		const prompt = match[3].trim();
		touchBackstageSession(session.id, {
			loop: {
				prompt,
				intervalMinutes: minutes,
				lastRunAt: new Date().toISOString(),
				setBy: user,
			},
		});
		return `Loop set: every ${minutes}m — "${prompt}". First run in ${minutes}m; /loop stop to end it.`;
	}

	return null;
}

// Loop ticker: fire due session loops (skips busy/archived sessions).
// Guarded so a hot reload doesn't stack a second interval.
if (!g.__backstageBooted) {
	setInterval(() => {
		for (const session of getCachedSessions()) {
			const loop = session.loop;
			if (!loop || session.archived || session.source !== "backstage") continue;
			if (!session.claudeSessionId && !session.codexThreadId) continue;
			if (
				isAgentSessionBusy(
					session.claudeSessionId,
					session.codexThreadId,
					session.id,
				)
			)
				continue;
			const last = loop.lastRunAt ? new Date(loop.lastRunAt).getTime() : 0;
			if (Date.now() - last < loop.intervalMinutes * 60_000) continue;
			touchBackstageSession(session.id, {
				loop: { ...loop, lastRunAt: new Date().toISOString() },
			});
			console.log(
				`[loop] Firing loop prompt for ${session.id} (every ${loop.intervalMinutes}m)`,
			);
			void runSessionPromptAndDrain(
				session.id,
				loop.prompt,
				loop.setBy ? `${loop.setBy} (loop)` : "loop",
			).catch((e) =>
				console.error(`[loop] Loop prompt failed for ${session.id}:`, e),
			);
		}
	}, 60_000);
}

// ── Goals: long-running, self-pacing missions ───────────────────────────────
// A Goal drives ONE managed session across many wakes, resuming the engine
// session each time (so context carries and the SDK compacts rather than
// forgets), pacing itself via the michael-goal-self MCP, and stopping when done.
// The store + validation live in src/server/goals.ts; this is the runner +
// ticker (here because they need the interactive MCP wiring), mirroring how the
// session loop ticker lives in this file.

const runningGoals: Set<string> = (g.__runningGoals ??= new Set());

/** MCP surface for a goal's own run: pull-a-human-in + its self-cadence controls.
 *  Deliberately excludes michael-admin / michael-sessions — an autonomous,
 *  weeks-long run gets least privilege (can't reconfigure Michael or steer other
 *  sessions); human sign-off goes through michael-humans ask_human. */
function goalMcpServers(
	bksSessionId: string,
	goalId: string,
	createdBy: string,
): Record<string, unknown> {
	return {
		"michael-humans": createHumansMcpServer({
			sessionId: bksSessionId,
			createdBy,
			isAdmin: true,
		}),
		"michael-goal-self": createGoalSelfMcpServer(goalId),
	};
}

function buildGoalWakePrompt(goal: Goal, wake: number, cwd: string): string {
	const parts = [
		`# Your mission (pinned)\n\n${goal.mission}`,
		`---`,
		`## This is wake #${wake} of your mission.`,
		`Your durable fact ledger is at:\n    ${goal.stateFile}\nRead it FIRST every wake — it is the authoritative record of what you've baselined, decided, shipped, and measured. Your in-context memory may have been compacted; the ledger is not.`,
		`Do ONE meaningful increment this wake. Then, before you finish, ALWAYS:\n` +
			`- Append what you learned/did this wake (concrete numbers, PR URLs, decisions) to the ledger via the michael-goal-self \`append_ledger\` tool.\n` +
			`- Decide what happens next with michael-goal-self: \`set_next_wake\` (e.g. "in 7 days" after shipping, so metrics can actually move before you re-measure), or \`mark_paused\` if you're blocked on a human decision, or \`mark_done\`/\`mark_failed\` when the mission is settled. If you set none, you'll be woken again in ~24h by default.\n` +
			`- Keep \`update_phase\` current so progress is visible at a glance.`,
		`Human gates: to get sign-off or a decision from a teammate, use the michael-humans \`ask_human\` tool — it DMs them as Michael and folds their reply back into this session. Do NOT email or impersonate anyone.`,
	];
	if (goal.mode === "code") {
		const repo = getRepo(goal.repo);
		if (repo.sharedCheckout) {
			// Shared-checkout repos (backstage) have NO isolated worktree — `cwd` is
			// the live main checkout the running server and every other session share.
			// A `git checkout -B`/`reset`/`pull` here yanks the working tree out from
			// under everyone and orphans their un-pushed commits, so forbid it.
			parts.push(
				`Shipping code: you are in the SHARED, live main checkout at ${cwd} on \`${repo.defaultBranch}\` — the running server and other sessions use this exact working tree at the same time. NEVER create or switch branches, \`reset\`, \`pull\`, \`stash\`, or \`checkout\` (that rips the tree out from under everyone and orphans their commits). Just edit files, then \`git add <your specific files>\` → \`git commit\` → \`git push\` on \`${repo.defaultBranch}\`. Commit + push frequently. No feature branch and no PR — this repo ships directly from \`${repo.defaultBranch}\`.`,
			);
		} else {
			parts.push(
				`Shipping code: you are in a persistent worktree at ${cwd} (kept stable across wakes so your session resumes cleanly). For each change, start clean from the default branch (\`git fetch origin && git checkout -B <feature-branch> origin/${repo.defaultBranch}\`), make edits, follow the repo's AGENTS.md and run its checks/format, then open a PR with \`gh pr create --base ${repo.defaultBranch}\`. NEVER merge — a PR is the human gate.`,
			);
		}
	}
	return parts.join("\n\n");
}

/** Run one wake of a goal: resume (or create) its session, drive one increment,
 *  then persist whatever cadence/status the run chose (with a 24h fallback). */
async function runGoal(goal: Goal): Promise<void> {
	if (runningGoals.has(goal.id)) return;
	runningGoals.add(goal.id);
	const startedAt = new Date();
	const wake = goal.wakeCount + 1;
	const bksId = goal.bksSessionId || `bks-${randomUUIDv7()}`;
	try {
		// Code goals keep ONE persistent worktree so the engine session (keyed on
		// cwd) resumes cleanly across wakes; ask goals read the main checkout.
		let cwd = `${HOME}/projects/tella-fusion`;
		let branch = goal.branch || "";
		if (goal.mode === "code") {
			const repo = getRepo(goal.repo);
			branch = goal.branch || `goal-${goal.id.slice(-8)}`;
			if (goal.worktreePath && existsSync(goal.worktreePath)) {
				cwd = goal.worktreePath;
			} else {
				try {
					cwd = await reviveWorktree(branch, repo.id);
				} catch {
					cwd = await createWorktree(branch, repo.id);
				}
			}
		}

		saveGoal({
			...goal,
			bksSessionId: bksId,
			branch: branch || undefined,
			worktreePath: goal.mode === "code" ? cwd : undefined,
			lastRunAt: startedAt.toISOString(),
			lastRunStatus: "running",
			lastRunError: undefined,
		});

		const createdBy = `${goal.name} (goal)`;
		let effectiveModel = goal.model;
		let effectiveProvider = providerFor(effectiveModel);
		const persistSession = (engineSessionId: string) => {
			const data: BackstageSessionFile = {
				id: bksId,
				claudeSessionId: "",
				...(engineSessionId
					? engineSessionPatch(effectiveProvider, engineSessionId)
					: {}),
				...(engineSessionId
					? { lastEngineProvider: effectiveProvider }
					: {}),
				...(effectiveModel ? { model: effectiveModel } : {}),
				branch: goal.mode === "code" ? branch : "",
				worktreeDir: cwd,
				...(goal.mode === "code" ? { repo: getRepo(goal.repo).id } : {}),
				createdBy,
				createdAt: goal.createdAt,
				lastActivity: new Date().toISOString(),
				title: `${goal.name} — goal`,
				mode: goal.mode,
				goalId: goal.id,
			};
			writeJsonAtomic(`${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`, data);
			sessionsCache = null;
		};

		console.log(`[goals] Wake #${wake} of "${goal.name}" → ${bksId}`);

		let engineSessionId = goal.engineSessionId || "";
		let errorMsg = "";
		for await (const event of runAgent({
			prompt: buildGoalWakePrompt(goal, wake, cwd),
			sessionId: goal.engineSessionId || undefined,
			cwd,
			mode: goal.mode,
			model: goal.model,
			mcpServers: goal.mcpServers,
			inProcessMcp: goalMcpServers(bksId, goal.id, createdBy),
			confirmTools: STRIPE_CONFIRM_TOOLS,
			aws: true,
			author: gitIdentityFor(goal.name),
			// A goal runs on behalf of its creator; gate per-user MCP servers to them.
			user: createdBy,
			fallbackModel:
				goal.fallbackModel === "none"
					? undefined
					: goal.fallbackModel || DEFAULT_FALLBACK_MODEL,
			journal: { bksSessionId: bksId, kind: "goal" },
			// Headless: no onAskUser. Human gates go through michael-humans ask_human
			// (async) and hard blocks through michael-goal-self mark_paused.
		})) {
			if (event.type === "init") {
				engineSessionId = event.sessionId || engineSessionId;
				if (event.provider) effectiveProvider = event.provider;
				if (event.model) effectiveModel = event.model;
				persistSession(engineSessionId);
				// A goal wake's transcript file is new each wake — attach anyone
				// already viewing the goal session so the turn streams live.
				if (engineSessionId) {
					attachSessionWatchersToEngineTranscript(
						bksId,
						effectiveProvider,
						cwd,
						engineSessionId,
					);
				}
			}
			if (event.type === "model_switch") {
				const to = event.toModel || "";
				if (to) {
					effectiveModel = to;
					effectiveProvider = providerFor(to);
				}
			}
			if (event.type === "done") {
				engineSessionId = event.sessionId || engineSessionId;
				if (event.provider) effectiveProvider = event.provider;
				if (event.model) effectiveModel = event.model;
			}
			if (event.type === "error") errorMsg = event.content || "Unknown error";
		}
		persistSession(engineSessionId);

		// The run may have rescheduled / paused / finished itself via
		// michael-goal-self — reload so we don't clobber those, then apply
		// bookkeeping and a 24h fallback if it left no next wake.
		const fresh = getGoal(goal.id) || goal;
		const next: Goal = {
			...fresh,
			bksSessionId: bksId,
			engineSessionId,
			branch: branch || fresh.branch,
			worktreePath: goal.mode === "code" ? cwd : fresh.worktreePath,
			wakeCount: wake,
			lastRunAt: startedAt.toISOString(),
			lastRunStatus: errorMsg ? "error" : "ok",
			lastRunError: errorMsg || undefined,
		};
		if (
			next.status === "active" &&
			Date.parse(next.nextWakeAt) <= startedAt.getTime()
		) {
			next.nextWakeAt = new Date(
				startedAt.getTime() + 24 * 60 * 60 * 1000,
			).toISOString();
			console.log(`[goals] "${goal.name}" set no next wake — defaulting to +24h`);
		}
		saveGoal(next);
		console.log(
			`[goals] "${goal.name}" wake #${wake} ${errorMsg ? `error: ${errorMsg}` : "ok"} (status ${next.status})`,
		);
	} catch (e: any) {
		console.error(`[goals] "${goal.name}" wake failed:`, e);
		const fresh = getGoal(goal.id);
		if (fresh) {
			saveGoal({
				...fresh,
				lastRunAt: startedAt.toISOString(),
				lastRunStatus: "error",
				lastRunError: e?.message || String(e),
				// Back off a day on a hard failure so it can't hot-loop crashing.
				nextWakeAt:
					fresh.status === "active" &&
					Date.parse(fresh.nextWakeAt) <= startedAt.getTime()
						? new Date(startedAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
						: fresh.nextWakeAt,
			});
		}
	} finally {
		runningGoals.delete(goal.id);
	}
}

// Goals ticker: wake due goals (self-pacing, so this only fires them).
// Guarded so a hot reload doesn't stack a second interval.
if (!g.__backstageBooted) {
	setInterval(() => {
		const now = Date.now();
		for (const goal of listGoals()) {
			if (goal.status !== "active") continue;
			if (Date.parse(goal.nextWakeAt) > now) continue;
			if (runningGoals.has(goal.id)) continue;
			// A prior process's run may still be resuming from the journal — don't
			// double-drive the same engine session.
			if (isAgentSessionBusy(goal.engineSessionId, goal.bksSessionId)) continue;
			// Safety cap: stop an out-of-control mission until a human resumes it.
			if (goal.maxWakes && goal.wakeCount >= goal.maxWakes) {
				saveGoal({
					...goal,
					status: "paused",
					pauseReason: `Hit safety cap of ${goal.maxWakes} wakes — resume to continue.`,
				});
				console.log(`[goals] "${goal.name}" hit maxWakes ${goal.maxWakes}; paused`);
				continue;
			}
			void runGoal(goal);
		}
	}, 60_000);
}

// Production frontend: build the SPA with code-splitting so the initial
// download is ~1MB instead of shipping every shiki grammar/theme (~10MB)
// upfront — the heavy chunks load on demand. Dev keeps the HMR HTMLBundle
// (`homepage`) below. Built once per process and parked on globalThis so a
// hot reload reuses it. Assets are content-hashed → safe to cache forever.
const IS_DEV = process.env.BACKSTAGE_DEV === "1";
const FRONTEND_DIST = `${import.meta.dir}/.frontend-dist`;
const FRONTEND_SRC = `${import.meta.dir}/src/frontend`;

type FrontendBundle = {
	indexHtml: string;
	gzip: Map<string, Blob>;
	version: string;
};

// Build (or rebuild) the prod SPA bundle in-process. The result object on
// globalThis is MUTATED in place (never reassigned) so the long-lived `frontend`
// reference + route closures below pick up a rebuild without a process restart —
// which is the whole point: a CSS/frontend change no longer needs a `systemctl
// restart` that would interrupt every in-flight Claude run. `version` changes
// whenever the entry or CSS hash changes, so clients know to refresh.
async function buildFrontend(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [`${FRONTEND_SRC}/App.tsx`],
		outdir: FRONTEND_DIST,
		minify: true,
		splitting: true,
		sourcemap: "none",
		publicPath: "/backstage/",
		naming: {
			entry: "[name]-[hash].[ext]",
			chunk: "[name]-[hash].[ext]",
			asset: "[name]-[hash].[ext]",
		},
	});
	if (!result.success) {
		throw new AggregateError(result.logs, "frontend build failed");
	}
	// Bun's HTML-entry splitting mis-points the bootstrap <script> at a leaf
	// chunk, so we build the JS entry and stitch index.html ourselves: keep the
	// source shell (icons, splash, manifest links) and point it at the hashed
	// entry + the extracted CSS.
	const entry = result.outputs.find((o) => o.kind === "entry-point");
	if (!entry) throw new Error("frontend build produced no entry point");
	const entryName = entry.path.split("/").pop()!;

	// Bun 1.3.14's CSS minifier strips the space after var(...) and breaks the
	// .panel-overlay / .sidebar-overlay inset (and a few color-mix percentages),
	// which knocks out the mobile overlay layer. Bypass it: write the source CSS
	// unmodified with a content-hashed name and serve it ourselves.
	let cssSrc = await Bun.file(`${FRONTEND_SRC}/styles/global.css`).text();
	// xterm stylesheet (the Shell tab) rides along in the same file, vendored
	// straight from the installed package so it can't drift from the JS.
	try {
		const xtermCss = await Bun.file(
			`${import.meta.dir}/node_modules/@xterm/xterm/css/xterm.css`,
		).text();
		cssSrc += `\n\n/* ── vendored @xterm/xterm/css/xterm.css (Shell tab) ── */\n${xtermCss}`;
	} catch {}
	const cssHash = Bun.hash(cssSrc).toString(36);
	const cssName = `global-${cssHash}.css`;
	// Atomic: a mid-write bundle file has shipped corrupt before ("useState is
	// not defined") — never serve a torn asset.
	writeFileAtomic(`${FRONTEND_DIST}/${cssName}`, cssSrc);

	// Tailwind pass (see styles/tailwind.css). Bun can't compile Tailwind, so
	// the real compiler runs as a subprocess (~50ms); its lightningcss minifier
	// doesn't have the var() bug above. Linked after global.css so utilities win
	// source-order ties against legacy rules. Fail-soft: a broken Tailwind
	// compile ships the bundle without utilities rather than taking down the
	// whole server (this build also runs at boot, before Bun.serve).
	let twName: string | null = null;
	try {
		const twTmp = `${FRONTEND_DIST}/.tailwind-build.css`;
		const twProc = Bun.spawn(
			[
				`${import.meta.dir}/node_modules/.bin/tailwindcss`,
				"-i",
				`${FRONTEND_SRC}/styles/tailwind.css`,
				"-o",
				twTmp,
				"--minify",
			],
			{ cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
		);
		if ((await twProc.exited) !== 0) {
			throw new Error(await new Response(twProc.stderr).text());
		}
		const twCss = await Bun.file(twTmp).text();
		twName = `tailwind-${Bun.hash(twCss).toString(36)}.css`;
		writeFileAtomic(`${FRONTEND_DIST}/${twName}`, twCss);
	} catch (e) {
		console.error(
			"[frontend] Tailwind build FAILED — serving without utilities:",
			e,
		);
	}

	let indexHtml = await Bun.file(`${FRONTEND_SRC}/index.html`).text();
	indexHtml = indexHtml.replace(
		'<script type="module" src="./App.tsx"></script>',
		`<script type="module" crossorigin src="/backstage/${entryName}"></script>`,
	);
	const twLink = twName
		? `\n  <link rel="stylesheet" href="/backstage/${twName}">`
		: "";
	indexHtml = indexHtml.replace(
		"</head>",
		`  <link rel="stylesheet" href="/backstage/${cssName}">${twLink}\n</head>`,
	);
	const version = `${entryName}|${cssName}|${twName ?? "no-tw"}`;

	const store: FrontendBundle = (g.__backstageFrontend ??= {
		indexHtml: "",
		gzip: new Map<string, Blob>(),
		version: "",
	});
	store.indexHtml = indexHtml;
	store.gzip.clear(); // stale gzipped blobs were keyed by the old hashed names
	store.version = version;
	console.log(
		`Frontend built: ${result.outputs.length} files → ${FRONTEND_DIST} (v=${version})`,
	);
	return version;
}

if (!IS_DEV && !g.__backstageFrontend) {
	console.log("Building frontend (split + minified)…");
	await buildFrontend();
}

const frontend: FrontendBundle | null = IS_DEV
	? null
	: (g.__backstageFrontend as FrontendBundle);

// SPA entry: the HMR bundle in dev, the prebuilt index.html in prod. Reads
// `frontend.indexHtml` fresh on each request so an in-process rebuild is served
// immediately (the object is mutated, not replaced).
const spaEntry = frontend
	? () =>
			new Response(frontend.indexHtml, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			})
	: homepage;

// Debounced in-process rebuild + client nudge. Triggered by the frontend
// file-watch, a SIGUSR2 signal, or POST /backstage/api/rebuild-frontend — all of
// which replace the "systemctl restart to see my CSS change" habit that was
// interrupting every live Claude run. Clients get a non-intrusive refresh toast;
// the bundle is served from the mutated `frontend` object with no restart.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildInFlight = false;
function scheduleFrontendRebuild(reason: string, debounceMs = 300): void {
	if (IS_DEV || !frontend) return;
	if (rebuildTimer) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(async () => {
		rebuildTimer = null;
		if (rebuildInFlight) return scheduleFrontendRebuild(reason, 300); // coalesce
		rebuildInFlight = true;
		const before = frontend.version;
		try {
			const version = await buildFrontend();
			if (version !== before) {
				console.log(
					`[frontend] Rebuilt (${reason}); notifying clients (v=${version})`,
				);
				broadcastToAll({ type: "frontend_updated", version });
			}
		} catch (e) {
			console.error(`[frontend] Rebuild failed (${reason}):`, e);
			broadcastToAll({
				type: "notice",
				message: `Frontend rebuild failed — see logs. (${e})`,
			});
		} finally {
			rebuildInFlight = false;
		}
	}, debounceMs);
}

// Land a Plain thread in a triage session: reuse the most recent live
// (non-archived) session already linked to the thread, else kick off the
// "Plain ticket triage" automation with the same context the webhook event
// carries and wait (up to 2 min) for its session to boot. Shared by the
// /plain-triage redirect (Plain support cards) and the JSON API behind the
// Support view's "Triage this ticket" button.
async function resolvePlainTriageSession(
	threadId: string,
): Promise<string | null> {
	const existing = getCachedSessions()
		.filter((s) => s.plainThreadId === threadId && !s.archived)
		.sort(
			(a, b) =>
				new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
		)[0];
	if (existing) return existing.id;

	const automation = listAutomations().find(
		(a) => a.eventKey === "plain:thread_created",
	);
	if (!automation) return null;

	// Build the same payload shape the webhook event carries
	let payload: Record<string, unknown> = { threadId };
	try {
		const { getThreadWithMessages } = await import("./src/agents/plain/api");
		const thread = await getThreadWithMessages(threadId);
		payload = {
			threadId,
			title: thread?.title || null,
			previewText: thread?.previewText || thread?.description || null,
			status: thread?.status || null,
			customer: {
				email: thread?.customer?.email?.email || null,
				fullName: thread?.customer?.fullName || null,
			},
		};
	} catch (e) {
		console.error(`[plain-triage] Thread lookup failed for ${threadId}:`, e);
	}

	return new Promise<string | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), 120_000);
		void runAutomation(
			automation,
			(id) => {
				sessionsCache = null;
				clearTimeout(timer);
				resolve(id);
			},
			{
				trigger: "event",
				eventContext: JSON.stringify(payload, null, 2),
			},
		);
	});
}

// The Support sidebar's TODO-thread list, cached briefly so a click-through
// of tickets doesn't hammer Plain's API (every open browser polls this).
let plainTodoCache: { data: unknown[]; ts: number } | null = null;
const PLAIN_TODO_TTL = 30_000;

console.log(`Starting Backstage server on ${HOST}:${PORT}...`);

// Reuse the listening server across hot reloads so existing WebSocket clients
// and in-flight runs survive a tweak; a fresh `bun run` just creates it once.
// (Session/agent logic still hot-updates: the registry below is re-registered
// on every reload, and per-message config is read fresh.)
const server: import("bun").Server<WSClientData> = (g.__backstageServer ??=
	Bun.serve<WSClientData>({
		port: PORT,
		hostname: HOST,
		// The plain-triage route waits for worktree+session boot (~15-60s);
		// Bun's default 10s idleTimeout would drop the connection mid-wait
		idleTimeout: 240,

		routes: {
			"/backstage": spaEntry,
			"/backstage/": spaEntry,
			"/backstage/index.html": spaEntry,
			// Client-side routes must serve the SPA shell, not the raw file
			"/backstage/new": spaEntry,
			"/backstage/session/*": spaEntry,
			"/backstage/automations": spaEntry,
			"/backstage/security": spaEntry,
			"/backstage/goals": spaEntry,
			"/backstage/wiki": spaEntry,
			"/backstage/wiki/*": spaEntry,
			"/backstage/notes": spaEntry,
			"/backstage/notes/*": spaEntry,
			"/backstage/docs": spaEntry,
			"/backstage/docs/*": spaEntry,
			"/backstage/connections": spaEntry,
			"/backstage/settings": spaEntry,
			"/backstage/actions": spaEntry,
			"/backstage/archived": spaEntry,
			"/backstage/catchup": spaEntry,
			"/backstage/reviews": spaEntry,
			"/backstage/reviews/*": spaEntry,
			"/backstage/support/*": spaEntry,
		},

		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			// Stream a local media file referenced by a `BACKSTAGE_VIDEO:` marker in a
			// tool's output, so the session viewer can play it inline (tools can't return
			// video blocks the way Read returns images). Path-scoped: absolute path under
			// /tmp or /home/ubuntu, no traversal, known media extension. Range-enabled
			// so the <video> scrubber can seek.
			if (path === "/backstage/media" && req.method === "GET") {
				const mediaPath = url.searchParams.get("path") || "";
				const mediaTypes: Record<string, string> = {
					".mp4": "video/mp4",
					".webm": "video/webm",
					".mov": "video/quicktime",
					".png": "image/png",
					".jpg": "image/jpeg",
					".jpeg": "image/jpeg",
					".gif": "image/gif",
					".webp": "image/webp",
				};
				const ext = mediaPath.slice(mediaPath.lastIndexOf(".")).toLowerCase();
				const scoped =
					mediaPath.startsWith("/tmp/") ||
					mediaPath.startsWith("/home/ubuntu/");
				if (
					!mediaPath.startsWith("/") ||
					mediaPath.includes("..") ||
					!scoped ||
					!mediaTypes[ext]
				) {
					return new Response("forbidden", { status: 403 });
				}
				const file = Bun.file(mediaPath);
				if (!(await file.exists()))
					return new Response("not found", { status: 404 });

				const type = mediaTypes[ext];
				const size = file.size;
				const range = req.headers.get("range");
				const baseHeaders: Record<string, string> = {
					"Content-Type": type,
					"Accept-Ranges": "bytes",
					"Cache-Control": "private, max-age=60",
				};
				if (range) {
					const m = range.match(/bytes=(\d*)-(\d*)/);
					let start = m && m[1] ? parseInt(m[1], 10) : 0;
					let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
					if (Number.isNaN(start) || start < 0) start = 0;
					if (Number.isNaN(end) || end >= size) end = size - 1;
					if (start > end) {
						return new Response("range not satisfiable", {
							status: 416,
							headers: { "Content-Range": `bytes */${size}` },
						});
					}
					return new Response(file.slice(start, end + 1), {
						status: 206,
						headers: {
							...baseHeaders,
							"Content-Range": `bytes ${start}-${end}/${size}`,
							"Content-Length": String(end - start + 1),
						},
					});
				}
				return new Response(file, {
					headers: { ...baseHeaders, "Content-Length": String(size) },
				});
			}

			// App icons (KITT/red-M) — real PNGs so iOS home-screen and PWA installs
			// pick them up; data-URI apple-touch-icons don't work on iOS. Short cache
			// + must-revalidate so a refreshed design isn't pinned by a stale copy.
			const iconFiles: Record<string, string> = {
				"/backstage/apple-touch-icon.png": "apple-touch-icon.png", // 180×180
				"/backstage/icon-192.png": "icon-192.png",
				"/backstage/icon.png": "icon.png", // 512×512
			};
			if (iconFiles[path]) {
				return new Response(
					Bun.file(`${import.meta.dir}/src/frontend/${iconFiles[path]}`),
					{
						headers: {
							"Content-Type": "image/png",
							"Cache-Control": "public, max-age=3600, must-revalidate",
						},
					},
				);
			}

			// Service worker (Web Push). Must precede the hashed-asset matcher —
			// sw.js is served from source, never cached hard (the browser refetches
			// it on its own schedule and applies updates).
			if (path === "/backstage/sw.js") {
				return new Response(Bun.file(`${FRONTEND_SRC}/sw.js`), {
					headers: {
						"Content-Type": "text/javascript; charset=utf-8",
						"Cache-Control": "no-cache",
						"Service-Worker-Allowed": "/backstage/",
					},
				});
			}

			// iOS PWA launch images (apple-touch-startup-image). One PNG per device
			// resolution, generated by scripts/gen-splash.py. Filename is locked to the
			// apple-splash-<w>-<h>.png pattern so the path can't escape the folder.
			const splashMatch = path.match(
				/^\/backstage\/splash\/(apple-splash-\d+-\d+\.png)$/,
			);
			if (splashMatch) {
				return new Response(
					Bun.file(`${import.meta.dir}/src/frontend/splash/${splashMatch[1]}`),
					{
						headers: {
							"Content-Type": "image/png",
							"Cache-Control": "public, max-age=86400",
						},
					},
				);
			}

			// Built SPA assets (prod only). Content-hashed filenames → cache forever.
			// Served gzipped (computed once, then memoised) since the JS is large.
			const assetMatch =
				frontend && path.match(/^\/backstage\/([\w.-]+\.(?:js|css|map))$/);
			if (assetMatch) {
				const name = assetMatch[1];
				const file = Bun.file(`${FRONTEND_DIST}/${name}`);
				if (await file.exists()) {
					const type = name.endsWith(".css")
						? "text/css"
						: name.endsWith(".map")
							? "application/json"
							: "text/javascript";
					const headers: Record<string, string> = {
						"Content-Type": `${type}; charset=utf-8`,
						"Cache-Control": "public, max-age=31536000, immutable",
					};
					if ((req.headers.get("accept-encoding") || "").includes("gzip")) {
						let gz = frontend.gzip.get(name);
						if (!gz) {
							gz = new Blob([
								Bun.gzipSync(new Uint8Array(await file.arrayBuffer())),
							]);
							frontend.gzip.set(name, gz);
						}
						headers["Content-Encoding"] = "gzip";
						headers["Vary"] = "Accept-Encoding";
						return new Response(gz, { headers });
					}
					return new Response(file, { headers });
				}
			}
			if (path === "/backstage/manifest.webmanifest") {
				return Response.json(
					{
						name: "Backstage",
						short_name: "Backstage",
						start_url: "/backstage/",
						display: "standalone",
						background_color: "#0b0809",
						theme_color: "#0b0809",
						icons: [
							{
								src: "/backstage/icon-192.png?v=3",
								sizes: "192x192",
								type: "image/png",
								purpose: "any",
							},
							{
								src: "/backstage/icon.png?v=3",
								sizes: "512x512",
								type: "image/png",
								purpose: "any",
							},
						],
					},
					{ headers: { "Content-Type": "application/manifest+json" } },
				);
			}

			// Land the user in a Plain triage session for a thread. If one already
			// exists for this thread, jump straight to it; otherwise start a fresh
			// triage run with the same context the automation gets on thread_created.
			// Linked from the Plain support cards.
			const plainTriageMatch = path.match(
				/^\/backstage\/plain-triage\/([^/]+)$/,
			);
			if (plainTriageMatch && req.method === "GET") {
				const threadId = decodeURIComponent(plainTriageMatch[1]);
				const sessionId = await resolvePlainTriageSession(threadId);
				return new Response(null, {
					status: 302,
					headers: {
						Location: sessionId
							? `/backstage/session/${sessionId}`
							: "/backstage/",
					},
				});
			}

			// Health check (includes agent health — Tailscale-only, not public).
			// frontendVersion lets clients detect a frontend-only rebuild (no bootId
			// change) and refresh.
			if (path === "/backstage/api/health") {
				const agentHealth: Record<string, unknown> = {};
				for (const a of agents) {
					agentHealth[a.name] = a.health();
				}
				return Response.json({
					ok: true,
					bootId: BOOT_ID,
					frontendVersion: frontend?.version ?? null,
					uptime: process.uptime(),
					// In-flight runner runs this process is driving — a drain-aware deploy
					// polls this to restart only when the service is idle (or near it), so a
					// restart kills as few in-flight runs/background tasks as possible.
					activeRuns: activeAgentRunCount(),
					agents: agentHealth,
				});
			}

			// Rebuild the frontend bundle in-process (no restart → live runs untouched).
			// Drop-in replacement for `systemctl restart backstage` after a frontend/CSS
			// change. Tailscale + team gated at the network layer like every route here.
			if (path === "/backstage/api/rebuild-frontend" && req.method === "POST") {
				if (IS_DEV || !frontend) {
					return Response.json(
						{ ok: false, error: "not available in dev mode" },
						{ status: 400 },
					);
				}
				try {
					const version = await buildFrontend();
					broadcastToAll({ type: "frontend_updated", version });
					return Response.json({ ok: true, version });
				} catch (e) {
					return Response.json(
						{ ok: false, error: String(e) },
						{ status: 500 },
					);
				}
			}

			// Stream a large composer attachment straight to disk (base64-over-WS
			// can't carry big files). Body is the raw file bytes; filename in the
			// `x-file-name` header. Returns { name, path } the client echoes back in
			// its next prompt/create_session `files` entry.
			if (path === "/backstage/api/upload" && req.method === "POST") {
				try {
					const rawName = req.headers.get("x-file-name") || "file";
					const name = decodeURIComponent(rawName);
					const len = Number(req.headers.get("content-length") || 0);
					if (len > MAX_UPLOAD_BYTES) {
						return Response.json(
							{
								ok: false,
								error: `File too large (${len} bytes, max ${MAX_UPLOAD_BYTES}).`,
							},
							{ status: 413 },
						);
					}
					const staged = await stageHttpUpload(name, req);
					return Response.json({ ok: true, ...staged });
				} catch (e) {
					return Response.json(
						{ ok: false, error: String((e as Error)?.message || e) },
						{ status: 400 },
					);
				}
			}

			// List sessions
			if (path === "/backstage/api/sessions" && req.method === "GET") {
				// Enrich with live, in-process signals that aren't on the cached session
				// objects: whether a run is blocked on a human question (pendingAsks) and
				// how many prompts are queued behind it. Drives the sidebar/tab "needs
				// input" highlight without a second round-trip.
				const enriched = getCachedSessions().map((s) => ({
					...s,
					waitingForInput: pendingAsks.has(s.id),
					queuedCount: promptQueues.get(s.id)?.length || 0,
					// Worktree still being created by this session's create run — the
					// viewer shows "Waiting for workspace" and queues sends meanwhile.
					...(preparingWorkspaces.has(s.id)
						? { workspacePreparing: true }
						: {}),
					// Terminal failure of the last run (credits/limits/API) — persisted
					// on backstage session files, in-memory for slack/linear sessions.
					lastRunError: runErrors.get(s.id) || s.lastRunError,
				}));
				return Response.json(enriched);
			}

			// Every open PR in the repo, attributed to teammates via the GitHub
			// identity table — the sidebar's Open PRs section (which must include
			// PRs that have no Backstage session).
			if (path === "/backstage/api/open-prs" && req.method === "GET") {
				return Response.json({ prs: getOpenPrs() });
			}

			// PR Tinder: the triage deck — every open tella-fusion PR with the
			// rich card fields, the repo's labels, and which PRs this user already
			// kept (so the deck doesn't re-deal them for 14 days).
			if (path === "/backstage/api/pr-tinder" && req.method === "GET") {
				const user = url.searchParams.get("user") || "";
				try {
					const [prs, labels] = await Promise.all([
						listTinderPrs(),
						listTinderLabels(),
					]);
					return Response.json({
						prs,
						labels,
						seen: user ? getSeenPrs(user) : [],
					});
				} catch (e: any) {
					return Response.json(
						{ error: e.message || String(e) },
						{ status: 502 },
					);
				}
			}

			// PR Tinder actions: keep (per-user, local state only), close (with an
			// optional reason comment), reopen (the close undo), comment, label.
			{
				const m = path.match(/^\/backstage\/api\/pr-tinder\/(\d+)\/(\w+)$/);
				if (m && req.method === "POST") {
					const number = parseInt(m[1], 10);
					const body = await req.json().catch(() => ({}));
					try {
						switch (m[2]) {
							case "keep": {
								if (!body.user)
									return Response.json(
										{ error: "user required" },
										{ status: 400 },
									);
								markPrSeen(body.user, number);
								return Response.json({ ok: true });
							}
							case "unkeep": {
								if (!body.user)
									return Response.json(
										{ error: "user required" },
										{ status: 400 },
									);
								markPrUnseen(body.user, number);
								return Response.json({ ok: true });
							}
							case "close": {
								const r = await closeTinderPr(number, body.reason);
								return Response.json(r, { status: "error" in r ? 502 : 200 });
							}
							case "reopen": {
								const r = await reopenTinderPr(number);
								return Response.json(r, { status: "error" in r ? 502 : 200 });
							}
							case "comment": {
								const r = await commentTinderPr(number, body.body || "");
								// Commenting is a triage verdict too — don't re-deal the PR.
								if ("ok" in r && body.user) markPrSeen(body.user, number);
								return Response.json(r, { status: "error" in r ? 502 : 200 });
							}
							case "uncomment": {
								// Undo for a comment: delete it and put the PR back in the
								// user's deck.
								if (!body.commentId)
									return Response.json(
										{ error: "commentId required" },
										{ status: 400 },
									);
								const r = await deleteTinderComment(Number(body.commentId));
								if ("ok" in r && body.user) markPrUnseen(body.user, number);
								return Response.json(r, { status: "error" in r ? 502 : 200 });
							}
							case "labels": {
								const r = await labelTinderPr(number, {
									add: body.add,
									remove: body.remove,
								});
								return Response.json(r, { status: "error" in r ? 502 : 200 });
							}
						}
					} catch (e: any) {
						return Response.json(
							{ error: e.message || String(e) },
							{ status: 500 },
						);
					}
				}
			}

			// Get transcript for a session
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/transcript$/) &&
				req.method === "GET"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/transcript$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				if (!session.transcriptPath) return Response.json([]);
				return Response.json(parseTranscript(session.transcriptPath));
			}

			// Workspace overview: the opening prompt + all media (screenshots,
			// videos) across the workspace's member chats — feeds the floating
			// preview panel in the session viewer. Images come back as
			// transcript-image refs (below), not inline base64.
			{
				const m = path.match(
					/^\/backstage\/api\/workspaces\/([^/]+)\/overview$/,
				);
				if (m && req.method === "GET") {
					const wsId = decodeURIComponent(m[1]);
					const chats = getCachedSessions().filter(
						(s) => s.projectId === wsId,
					);
					return Response.json(buildWorkspaceOverview(chats));
				}
			}

			// One image out of a transcript entry, served as real bytes (decoded
			// from the base64 block) so the overview panel can lazy-load and the
			// browser can cache thumbnails instead of shipping data URLs in JSON.
			{
				const m = path.match(
					/^\/backstage\/api\/sessions\/(.+)\/transcript-image\/([^/]+)\/(\d+)$/,
				);
				if (m && req.method === "GET") {
					const session = findSession(decodeURIComponent(m[1]));
					if (!session?.transcriptPath)
						return Response.json({ error: "Session not found" }, { status: 404 });
					const img = resolveTranscriptImage(
						session.transcriptPath,
						decodeURIComponent(m[2]),
						parseInt(m[3], 10),
					);
					if (!img)
						return Response.json({ error: "Image not found" }, { status: 404 });
					if ("redirect" in img)
						return Response.redirect(img.redirect, 302);
					return new Response(img.bytes, {
						headers: {
							"Content-Type": img.contentType,
							"Content-Length": String(img.bytes.byteLength),
							// A transcript entry never changes once written — cache hard.
							"Cache-Control": "private, max-age=86400, immutable",
						},
					});
				}
			}

			// Full-text search across session transcripts (the ⌘K palette's
			// "search in conversations"). Two-stage: a cheap ripgrep pass narrows
			// hundreds of transcripts to the few that contain the query, then we
			// parse only those (cached) to pull a clean snippet — which also drops
			// matches that only occur in transcript metadata (base64, JSON keys).
			if (path === "/backstage/api/sessions/search" && req.method === "GET") {
				const q = (url.searchParams.get("q") || "").trim();
				if (q.length < 2) return Response.json({ matches: [] });
				const byPath = new Map<string, string>(); // transcriptPath → sessionId
				for (const s of getCachedSessions()) {
					if (
						s.transcriptPath &&
						!byPath.has(s.transcriptPath) &&
						existsSync(s.transcriptPath)
					)
						byPath.set(s.transcriptPath, s.id);
				}
				const files = [...byPath.keys()];
				if (!files.length) return Response.json({ matches: [] });
				const matches: Array<{ id: string; snippet: string }> = [];
				for (const f of await ripgrepFiles(q, files)) {
					const id = byPath.get(f);
					if (!id) continue;
					const snippet = transcriptMatchSnippet(f, q);
					if (snippet) matches.push({ id, snippet });
					if (matches.length >= 50) break;
				}
				return Response.json({ matches });
			}

			// Sub-agent (Task/Agent) conversation for a session. The agentId comes from
			// a Task tool_result's `agentId` field in the parent transcript.
			{
				const m = path.match(
					/^\/backstage\/api\/sessions\/(.+)\/subagent\/([^/]+)$/,
				);
				if (m && req.method === "GET") {
					const session = findSession(decodeURIComponent(m[1]));
					if (!session)
						return Response.json(
							{ error: "Session not found" },
							{ status: 404 },
						);
					if (!session.transcriptPath)
						return Response.json({ error: "No transcript" }, { status: 404 });
					const sub = getSubagentTranscript(
						session.transcriptPath,
						decodeURIComponent(m[2]),
					);
					if (!sub)
						return Response.json(
							{ error: "Sub-agent not found" },
							{ status: 404 },
						);
					return Response.json({ ...sub, sessionRunning: session.isRunning });
				}
			}

			// Live git diff for a session's worktree (Changes tab)
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/diff$/) &&
				req.method === "GET"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/diff$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });

				// One diff per repo in the session: primary worktree + each attached repo.
				// Each carries its repo id so the panel can show a repo switcher and
				// route per-line feedback to the right checkout.
				const targets: Array<{
					repo: string;
					dir: string | null;
					primary: boolean;
				}> = [
					{
						repo:
							session.repo ||
							(session.worktreeDir
								? repoForPath(session.worktreeDir).id
								: "tella-fusion"),
						dir: session.worktreeDir,
						primary: true,
					},
					...(session.attachedRepos || []).map((r) => ({
						repo: r.repo,
						dir: r.dir,
						primary: false,
					})),
				];

				const repos = await Promise.all(
					targets.map(async (t) => {
						let diff: SessionDiff = {
							branch: null,
							baseRef: null,
							files: [],
							totalAdditions: 0,
							totalDeletions: 0,
							rawPatch: "",
						};
						// Volume-mode sandbox workspaces have no host dir — the primary
						// repo's diff runs through the session's sandbox exec instead
						// (workspaceExecFor; host exec when no active sandbox). Attached
						// repos are always host worktrees.
						const remote = t.primary && hasRemoteWorkspace(session);
						if (t.dir && (existsSync(t.dir) || remote)) {
							try {
								diff = await getSessionDiff(
									t.dir,
									getRepo(t.repo).defaultBranch,
									t.primary ? await workspaceExecFor(session, t.dir) : undefined,
								);
							} catch {}
						}
						return { repo: t.repo, dir: t.dir, primary: t.primary, diff };
					}),
				);

				return Response.json({ repos });
			}

			// Discard one file's changes in a session worktree (hover action on a
			// diff row). `{ repo, path, oldPath? }` — resets the file to its
			// base-branch state so it drops out of the Changes diff. Destructive.
			const discardMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/discard-file$/,
			);
			if (discardMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(discardMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = (await req.json().catch(() => ({}))) as {
					repo?: string;
					path?: string;
					oldPath?: string;
				};
				if (!body.path)
					return Response.json({ error: "Missing path" }, { status: 400 });

				// Resolve the worktree dir for the targeted repo (primary or attached).
				const primaryRepo =
					session.repo ||
					(session.worktreeDir
						? repoForPath(session.worktreeDir).id
						: "tella-fusion");
				let dir: string | null = null;
				let repoId = primaryRepo;
				if (!body.repo || body.repo === primaryRepo) {
					dir = session.worktreeDir;
				} else {
					const att = (session.attachedRepos || []).find(
						(r) => r.repo === body.repo,
					);
					dir = att?.dir ?? null;
					repoId = body.repo;
				}
				// Primary volume-mode workspaces exist only in the sandbox — route the
				// discard through its exec instead of requiring a host dir.
				const primaryRemote =
					(!body.repo || body.repo === primaryRepo) && hasRemoteWorkspace(session);
				if (!dir || (!existsSync(dir) && !primaryRemote))
					return Response.json(
						{ error: "No worktree for this repo" },
						{ status: 400 },
					);

				try {
					await discardSessionFile(
						dir,
						getRepo(repoId).defaultBranch,
						body.path,
						body.oldPath,
						!body.repo || body.repo === primaryRepo
							? await workspaceExecFor(session, dir)
							: undefined,
					);
				} catch (e: any) {
					return Response.json(
						{ error: e?.message || "Failed to discard file" },
						{ status: 500 },
					);
				}
				return Response.json({ ok: true });
			}

			// PR details for a session's branch (PR tab). `?repo=<project>` targets an
			// attached repo's PR; default/primary targets the session's own branch.
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/pr$/) &&
				req.method === "GET"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/pr$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const target = resolvePrTarget(session, url.searchParams.get("repo"));
				if (!target) return Response.json(null);
				return Response.json(await getPrDetails(target.branch, target.ghRepo));
			}

			// Local git state for a session's worktree (status header + Git status
			// rows). `?repo=<project>` targets an attached repo's checkout.
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/git-status$/) &&
				req.method === "GET"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/git-status$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const repoId = url.searchParams.get("repo");
				const primaryRepo =
					session.repo ||
					(session.worktreeDir
						? repoForPath(session.worktreeDir).id
						: "tella-fusion");
				const isPrimary = !repoId || repoId === primaryRepo;
				const dir = isPrimary
					? session.worktreeDir
					: (session.attachedRepos || []).find((r) => r.repo === repoId)?.dir;
				// Primary volume-mode workspaces have no host dir — status runs
				// through the sandbox exec (host exec when no active sandbox).
				const remote = isPrimary && hasRemoteWorkspace(session);
				if (!dir || (!existsSync(dir) && !remote)) return Response.json(null);
				const repoConf = getRepo(repoId || primaryRepo);
				return Response.json(
					await getGitStatus(
						dir,
						repoConf.defaultBranch,
						isPrimary ? await workspaceExecFor(session, dir) : undefined,
					),
				);
			}

			// Push the session's branch (sets upstream on first push). Human-triggered
			// from the status header — audited in git-status.ts.
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/git-push$/) &&
				req.method === "POST"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/git-push$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = await req.json().catch(() => ({}));
				const repoId = typeof body?.repo === "string" ? body.repo : null;
				const primaryRepo =
					session.repo ||
					(session.worktreeDir
						? repoForPath(session.worktreeDir).id
						: "tella-fusion");
				const isPrimary = !repoId || repoId === primaryRepo;
				const dir = isPrimary
					? session.worktreeDir
					: (session.attachedRepos || []).find((r) => r.repo === repoId)?.dir;
				if (!dir || (!existsSync(dir) && !(isPrimary && hasRemoteWorkspace(session))))
					return Response.json(
						{ error: "Session has no worktree" },
						{ status: 400 },
					);
				const result = await gitPush(
					dir,
					session.branch || "HEAD",
					isPrimary ? await workspaceExecFor(session, dir) : undefined,
				);
				if ("error" in result) return Response.json(result, { status: 502 });
				return Response.json(result);
			}

			// Fast-forward the session's checkout (git pull --ff-only) — the Pull
			// action in the status header. `body.base` pulls origin/<default branch>
			// instead of the branch's upstream (fresh worktree branches behind base
			// have no upstream to pull from). Audited in git-status.ts.
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/git-pull$/) &&
				req.method === "POST"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/git-pull$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = await req.json().catch(() => ({}));
				const repoId = typeof body?.repo === "string" ? body.repo : null;
				const primaryRepo =
					session.repo ||
					(session.worktreeDir
						? repoForPath(session.worktreeDir).id
						: "tella-fusion");
				const isPrimary = !repoId || repoId === primaryRepo;
				const dir = isPrimary
					? session.worktreeDir
					: (session.attachedRepos || []).find((r) => r.repo === repoId)?.dir;
				if (!dir || (!existsSync(dir) && !(isPrimary && hasRemoteWorkspace(session))))
					return Response.json(
						{ error: "Session has no worktree" },
						{ status: 400 },
					);
				const result = await gitPull(
					dir,
					body?.base ? getRepo(repoId || primaryRepo).defaultBranch : undefined,
					isPrimary ? await workspaceExecFor(session, dir) : undefined,
				);
				if ("error" in result) return Response.json(result, { status: 502 });
				return Response.json(result);
			}

			// PR diff for inline review in the PR tab
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-diff$/) &&
				req.method === "GET"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-diff$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const target = resolvePrTarget(session, url.searchParams.get("repo"));
				if (!target) return Response.json(null);
				return Response.json(await getPrDiff(target.branch, target.ghRepo));
			}

			// Session-less PR preview (sidebar PR rows with no chat yet): PR details
			// and diff straight from repo+branch — same pr-info helpers as the
			// session routes, minus the session lookup.
			if (path === "/backstage/api/pr-preview" && req.method === "GET") {
				const branch = url.searchParams.get("branch") || "";
				if (!branch)
					return Response.json({ error: "branch required" }, { status: 400 });
				const repo = getRepo(url.searchParams.get("repo") || undefined);
				return Response.json(await getPrDetails(branch, repo.ghRepo));
			}
			if (path === "/backstage/api/pr-preview-diff" && req.method === "GET") {
				const branch = url.searchParams.get("branch") || "";
				if (!branch)
					return Response.json({ error: "branch required" }, { status: 400 });
				const repo = getRepo(url.searchParams.get("repo") || undefined);
				return Response.json(await getPrDiff(branch, repo.ghRepo));
			}

			// Local dev-server ("Preview") status for a session's worktree — which
			// services (.ports.conf) are listening, so the header can link to the
			// webapp and show/stop running processes.
			{
				const m = path.match(/^\/backstage\/api\/sessions\/(.+)\/preview$/);
				if (m && req.method === "GET") {
					const session = findSession(decodeURIComponent(m[1]));
					if (!session)
						return Response.json(
							{ error: "Session not found" },
							{ status: 404 },
						);
					// Sandboxed session with a running container: the dev server (if
					// any) lives in-container — status/ports/Caddy go through the
					// sandbox. Otherwise the host path below, unchanged.
					const sbx = session.worktreeDir
						? await activeSandboxFor(session)
						: null;
					if (sbx)
						return Response.json(
							await getSandboxPreviewStatus(sbx, session.worktreeDir!),
						);
					if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
						return Response.json({
							hasPortsConf: false,
							webappPort: null,
							running: false,
							starting: false,
							previewUrl: null,
							services: [],
						});
					}
					return Response.json(await getPreviewStatus(session.worktreeDir));
				}
			}

			// Screenshot the running preview (headless Chrome → PNG).
			{
				const m = path.match(
					/^\/backstage\/api\/sessions\/(.+)\/preview\/screenshot$/,
				);
				if (m && req.method === "POST") {
					const session = findSession(decodeURIComponent(m[1]));
					if (!session)
						return Response.json(
							{ error: "Session not found" },
							{ status: 404 },
						);
					const sbx = session.worktreeDir
						? await activeSandboxFor(session)
						: null;
					if (!session.worktreeDir || (!existsSync(session.worktreeDir) && !sbx))
						return Response.json(
							{ error: "Session has no worktree" },
							{ status: 400 },
						);
					try {
						const { capturePreviewScreenshot } = await import(
							"./src/server/preview"
						);
						// Sandboxed previews: hand the capture the sandbox-derived status
						// (host status can't see in-container listeners); the URL itself
						// is an ordinary Caddy-fronted https origin either way.
						const png = await capturePreviewScreenshot(session.worktreeDir, {
							...(sbx
								? {
										status: await getSandboxPreviewStatus(
											sbx,
											session.worktreeDir,
										),
									}
								: {}),
						});
						return new Response(new Uint8Array(png), {
							headers: { "Content-Type": "image/png" },
						});
					} catch (e: any) {
						return Response.json(
							{ error: e?.message || "Screenshot failed" },
							{ status: 500 },
						);
					}
				}
			}

			// Start the session's dev server (Tella Local) if it isn't up yet.
			{
				const m = path.match(
					/^\/backstage\/api\/sessions\/(.+)\/preview\/start$/,
				);
				if (m && req.method === "POST") {
					const session = findSession(decodeURIComponent(m[1]));
					if (!session)
						return Response.json(
							{ error: "Session not found" },
							{ status: 404 },
						);
					// In-container start is gated on config devServerInSandbox — see
					// startSandboxPreview; without the gate it just reports status.
					const sbx = session.worktreeDir
						? await activeSandboxFor(session)
						: null;
					if (sbx)
						return Response.json(
							await startSandboxPreview(sbx, session.worktreeDir!),
						);
					if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
						return Response.json({
							hasPortsConf: false,
							webappPort: null,
							running: false,
							starting: false,
							previewUrl: null,
							services: [],
						});
					}
					return Response.json(await startPreview(session.worktreeDir));
				}
			}

			// Stop the session's dev server (scoped to its worktree's process group).
			{
				const m = path.match(
					/^\/backstage\/api\/sessions\/(.+)\/preview\/stop$/,
				);
				if (m && req.method === "POST") {
					const session = findSession(decodeURIComponent(m[1]));
					if (!session)
						return Response.json(
							{ error: "Session not found" },
							{ status: 404 },
						);
					// Sandboxed dev servers are stopped in-container (host pgids can't
					// reach them); also drops the Caddy route.
					const sbx = session.worktreeDir
						? await activeSandboxFor(session)
						: null;
					if (sbx)
						return Response.json(
							await stopSandboxPreview(sbx, session.worktreeDir!),
						);
					if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
						return Response.json({
							hasPortsConf: false,
							webappPort: null,
							running: false,
							starting: false,
							previewUrl: null,
							services: [],
						});
					}
					return Response.json(await stopPreview(session.worktreeDir));
				}
			}

			// Post a comment on the session's PR (inline when path+line present)
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-comment$/) &&
				req.method === "POST"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-comment$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });

				const body = await req.json().catch(() => null);
				if (!body?.text?.trim())
					return Response.json({ error: "Empty comment" }, { status: 400 });
				const target = resolvePrTarget(session, body.repo);
				if (!target)
					return Response.json(
						{ error: "No branch/PR for that repo" },
						{ status: 400 },
					);

				const user = body.user || "Someone";
				const result = await postPrComment(
					target.branch,
					{
						body: `**${user}** via Michael:\n\n${body.text.trim()}`,
						path: body.path,
						line: body.line,
						startLine: body.startLine,
						side: body.side,
						startSide: body.startSide,
					},
					target.ghRepo,
				);
				if ("error" in result) return Response.json(result, { status: 502 });
				return Response.json(result);
			}

			// Submit a batched review (all pending inline comments + an event) on the PR.
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-review$/) &&
				req.method === "POST"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-review$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });

				const body = await req.json().catch(() => null);
				const target = resolvePrTarget(session, body?.repo);
				if (!target)
					return Response.json(
						{ error: "No branch/PR for that repo" },
						{ status: 400 },
					);
				const event =
					body?.event === "APPROVE" || body?.event === "REQUEST_CHANGES"
						? body.event
						: "COMMENT";
				const comments = Array.isArray(body?.comments) ? body.comments : [];
				if (!comments.length && !body?.summary?.trim()) {
					return Response.json({ error: "Nothing to submit" }, { status: 400 });
				}

				const user = body?.user || "Someone";
				const summary = body?.summary?.trim();
				const reviewBody = summary
					? `**${user}** via Michael:\n\n${summary}`
					: `Review by **${user}** via Michael.`;
				const result = await submitPrReview(
					target.branch,
					{
						event,
						body: reviewBody,
						comments: comments
							.filter((c: any) => c?.text?.trim() && c?.path && c?.line)
							.map((c: any) => ({
								path: c.path,
								line: c.line,
								startLine: c.startLine,
								side: c.side,
								startSide: c.startSide,
								body: `**${user}**: ${c.text.trim()}`,
							})),
					},
					target.ghRepo,
				);
				if ("error" in result) return Response.json(result, { status: 502 });
				sessionsCache = null; // a review can change reviewDecision in the list
				return Response.json(result);
			}

			// Squash & merge the session's PR — human-triggered from the Reviews view.
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-merge$/) &&
				req.method === "POST"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-merge$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });

				const body = await req.json().catch(() => ({}));
				const target = resolvePrTarget(session, body.repo);
				if (!target)
					return Response.json(
						{ error: "No branch/PR for that repo" },
						{ status: 400 },
					);
				const method =
					body.method === "merge" || body.method === "rebase"
						? body.method
						: "squash";
				try {
					const result = await mergePr(
						target.branch,
						{ method, deleteBranch: !!body.deleteBranch },
						target.ghRepo,
					);
					if ("error" in result) return Response.json(result, { status: 502 });
					sessionsCache = null; // refresh prState in the sessions list
					return Response.json(result);
				} catch (e: any) {
					return Response.json(
						{ error: e.message || String(e) },
						{ status: 500 },
					);
				}
			}

			// Fire a GitHub PR agent behavior straight from the info panel — the same
			// actions the michael-* PR labels / Slack @mentions kick off (review,
			// auto-fix, simplify, adversarial). tella-fusion only (the agent is
			// repo-scoped), and there must be an open PR for the branch.
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-action$/) &&
				req.method === "POST"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-action$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });

				const body = await req.json().catch(() => null);
				const kind = body?.kind;
				if (!["review", "autofix", "simplify", "adversarial"].includes(kind))
					return Response.json({ error: "Unknown action" }, { status: 400 });

				const target = resolvePrTarget(session, body?.repo);
				if (!target)
					return Response.json(
						{ error: "No branch/PR for that repo" },
						{ status: 400 },
					);
				if (target.ghRepo !== "tellahq/tella-fusion")
					return Response.json(
						{ error: "The PR agent only runs on tella-fusion" },
						{ status: 400 },
					);

				const details = await getPrDetails(target.branch, target.ghRepo);
				if (!details?.number)
					return Response.json(
						{ error: "No open PR for this branch yet" },
						{ status: 400 },
					);

				// Auto-fix is code-writing work, not a review pass to post on the PR —
				// so it opens a live chat right in this workspace (shares the worktree +
				// branch) and fixes everything there, where you can watch and steer it,
				// instead of firing a headless GitHub-labeled run. The other actions
				// (review / simplify / adversarial) stay headless and post on the PR.
				if (kind === "autofix") {
					const prompt = [
						"/pr-autofix",
						"",
						`Fix everything on PR #${details.number} (“${details.title}”) — branch \`${target.branch}\`.`,
						"Address every reviewer's open feedback and any failing CI, commit and push to the branch,",
						"and reply in each thread you address with honest attribution. Keep going until it's all handled.",
					].join("\n");
					const { id } = await getSessionControl().createSession({
						prompt,
						repo: session.repo || "tella-fusion",
						mode: "code",
						branch: target.branch,
						parentSessionId: session.id,
						reportBack: false,
						user: body?.user || "Someone",
					});
					return Response.json({ ok: true, bksId: id, openChat: true });
				}

				const { triggerPrAction } = await import("./src/agents/github/trigger");
				const result = await triggerPrAction(
					kind,
					details.number,
					body?.user || "Someone",
				);
				return Response.json({
					ok: result.ok,
					message: result.message,
					url: result.url,
					bksId: result.bksId,
					...(result.ok ? {} : { error: result.message }),
				});
			}

			// Bulk-archive idle sessions
			if (
				path === "/backstage/api/sessions/archive-old" &&
				req.method === "POST"
			) {
				const body = await req.json().catch(() => ({}));
				const days = Math.max(1, parseInt(body.days) || 7);
				const count = archiveOlderThan(getAllSessions(), days);
				sessionsCache = null;
				return Response.json({ archived: count });
			}

			// Archive / unarchive a single session
			const archiveMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/archive$/,
			);
			if (archiveMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(archiveMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = await req.json().catch(() => ({}));
				const archived = body.archived !== false;
				// Archiving means "I'm done with this" — so stop an owned in-flight
				// run rather than leaving an orphaned turn burning tokens after the
				// session already reads as archived. Only runs owned by this process
				// (busyHere) are stoppable; external/CLI runs can't be reached from
				// here. Graceful Esc-style stop (fall back to hard cancel for runs
				// with no interrupt support) keeps the transcript clean and resumable
				// on unarchive.
				let stoppedRun = false;
				if (
					archived &&
					isAgentSessionBusy(
						session.claudeSessionId,
						session.codexThreadId,
						session.id,
					)
				) {
					// Park the queue so the drain doesn't feed requeued steers into a
					// fresh run as the stopped one winds down.
					stoppedSessions.add(session.id);
					const stopped = stopAgentRunTurn([
						session.claudeSessionId,
						session.codexThreadId,
						session.id,
					]);
					if (!stopped) {
						cancelAgentRun(
							session.claudeSessionId,
							session.codexThreadId,
							session.id,
						);
					}
					requeueSteerReceipts(session.id);
					stoppedRun = true;
				}
				setArchived(sessionId, archived);
				// Plain done-tickets are archived via a file-level flag, not the
				// registry; clearing only the registry would leave them archived. On
				// unarchive, also clear the file flag so the session returns to "My
				// sessions".
				if (!archived) clearSessionFileArchive(sessionId);
				sessionsCache = null;
				if (archived) {
					// setArchived drops the plain id pin; also drop legacy alias-id pins,
					// and the workspace pin once its last live chat is archived (else the
					// row resurfaces in Pinned when a new chat joins the workspace).
					unpinArchivedSessions([session], getAllSessions());
				}
				return Response.json({ ok: true, stoppedRun });
			}

			// Rename a session (manual display title; empty/blank clears it back to
			// the derived title). Works for any source via the override registry.
			const titleMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/title$/,
			);
			if (titleMatch && req.method === "PUT") {
				const sessionId = decodeURIComponent(titleMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = await req.json().catch(() => ({}));
				const title =
					typeof body?.title === "string" ? body.title.trim().slice(0, 80) : "";
				setTitleOverride(sessionId, title || null);
				sessionsCache = null;
				return Response.json({ ok: true });
			}

			// Set (or clear) a session's manual sidebar-lane. `status` is one of the
			// lane keys (needsinput/inprogress/review/merged/pending); null/invalid
			// clears the override back to the derived lane.
			const statusMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/status$/,
			);
			if (statusMatch && req.method === "PUT") {
				const sessionId = decodeURIComponent(statusMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = await req.json().catch(() => ({}));
				const status = isManualStatus(body?.status) ? body.status : null;
				setStatusOverride(sessionId, status);
				sessionsCache = null;
				return Response.json({ ok: true });
			}

			// Set (or clear) a session's review request — the info panel's Reviewer
			// picker. `reviewer` is a teammate display name; null/empty clears the
			// request. Setting one pushes a "needs your review" notification to the
			// reviewer's registered devices (mirrors the needs-input ask push).
			const reviewMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/review$/,
			);
			if (reviewMatch && req.method === "PUT") {
				const sessionId = decodeURIComponent(reviewMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = await req.json().catch(() => ({}));
				const by = typeof body?.by === "string" ? body.by.trim().slice(0, 40) : "";

				// Accept / reopen the current request (the reviewer signing off). Keeps
				// the reviewer assignment intact but flips it to a "Reviewed" state that
				// the asker sees in their sidebar. Distinct from setting/clearing a
				// reviewer below, so it never touches GitHub's Reviewers list.
				if (typeof body?.accept === "boolean") {
					const existing = getReviewRequest(sessionId);
					if (!existing)
						return Response.json(
							{ error: "No review request to accept" },
							{ status: 400 },
						);
					setReviewAccepted(
						sessionId,
						body.accept ? { by: by || "someone", at: new Date().toISOString() } : null,
					);
					sessionsCache = null;
					// Buzz whoever asked for the review that it landed (not on self-review).
					if (
						body.accept &&
						existing.by &&
						existing.by.toLowerCase() !== (by || "").toLowerCase()
					) {
						void (async () => {
							try {
								const { sendPushToUser } = await import("./src/server/push");
								await sendPushToUser(existing.by, {
									title: "Review complete",
									body: `${by || "Someone"} reviewed ${session.title || sessionId}`.slice(0, 180),
									url: `/backstage/session/${encodeURIComponent(sessionId)}`,
									tag: `review-${sessionId}`,
								});
							} catch {}
						})();
					}
					return Response.json({ ok: true });
				}

				const reviewer =
					typeof body?.reviewer === "string"
						? body.reviewer.trim().slice(0, 40)
						: "";
				const prevReviewer = getReviewRequest(sessionId)?.to;
				setReviewRequest(
					sessionId,
					reviewer
						? { to: reviewer, by: by || "someone", at: new Date().toISOString() }
						: null,
				);
				sessionsCache = null;
				// Mirror the request onto GitHub's own Reviewers list (best-effort):
				// setting a reviewer adds them, re-assigning swaps, clearing removes.
				// Only for sessions with a branch/PR whose reviewer maps to a GitHub
				// login — a phone buzz always fires below regardless.
				{
					const addLogin = reviewer ? githubLoginFor(reviewer) : null;
					const removeLogin =
						prevReviewer && prevReviewer !== reviewer
							? githubLoginFor(prevReviewer)
							: null;
					const target = resolvePrTarget(session, body?.repo);
					if (target && (addLogin || removeLogin)) {
						void editPrReviewers(
							target.branch,
							{ add: addLogin, remove: removeLogin },
							target.ghRepo,
						).catch(() => {});
					}
				}
				if (reviewer) {
					// Best-effort phone buzz — never let a push hiccup fail the request.
					void (async () => {
						try {
							const { sendPushToUser } = await import("./src/server/push");
							await sendPushToUser(reviewer, {
								title: "Needs your review",
								body: `${by || "Someone"} asked you to review ${session.title || sessionId}`.slice(0, 180),
								url: `/backstage/session/${encodeURIComponent(sessionId)}`,
								tag: `review-${sessionId}`,
							});
						} catch {}
					})();
				}
				return Response.json({ ok: true });
			}

			// Delete a session (+ optional worktree cleanup)
			if (
				path.match(/^\/backstage\/api\/sessions\/(.+)$/) &&
				req.method === "DELETE"
			) {
				const sessionId = decodeURIComponent(
					path.match(/^\/backstage\/api\/sessions\/(.+)$/)![1],
				);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });

				const cleanWorktree = url.searchParams.get("worktree") === "true";
				try {
					deleteSession(session);
					sessionsCache = null;
					// Tear down the session's sandbox (container + engine-state volumes —
					// and in volume-workspace mode the workspace volume itself; that data
					// loss is the mode's documented contract). Best-effort and detached:
					// a docker hiccup must never block the delete.
					destroySessionSandbox(session, "delete");
					// If that was the workspace's last chat, delete the workspace too —
					// otherwise auto-wrapped 1:1 workspaces linger as undeletable empty
					// sidebar rows. PR-backed workspaces (`key`) stay: they regroup new
					// chats for the same PR.
					if (session.projectId) {
						const ws = getWorkspace(session.projectId);
						const members = getAllSessions().filter(
							(s) => s.projectId === session.projectId,
						);
						if (ws && !ws.key && members.length === 0)
							deleteWorkspace(ws.id);
					}
					if (cleanWorktree && session.worktreeDir && session.branch) {
						await removeWorktree(
							session.branch,
							repoForPath(session.worktreeDir).id,
						);
					}
					return Response.json({ ok: true });
				} catch (e: any) {
					return Response.json({ error: e.message }, { status: 500 });
				}
			}

			// List worktrees (optionally for a specific repo)
			if (path === "/backstage/api/worktrees" && req.method === "GET") {
				return Response.json(
					await listWorktrees(url.searchParams.get("repo") || undefined),
				);
			}

			// File-mention autocomplete ("@" in the composer). Searches the session's
			// primary worktree plus any attached repos (cross-repo sessions), falling
			// back to the default repo for new-session composers with no session
			// yet. Each hit carries `insert` (what lands in the textarea: a bare path for
			// the primary repo, `<repo>:path` for an attached one) and a `repo` label
			// when more than one repo is in play.
			if (path === "/backstage/api/files" && req.method === "GET") {
				const q = url.searchParams.get("q") || "";
				const sessionId = url.searchParams.get("session");
				const repos: Array<{ repo: string; dir: string; primary: boolean }> =
					[];
				const session = sessionId ? findSession(sessionId) : undefined;
				// Volume-mode sandbox workspaces have no host dir — the primary
				// repo's `git ls-files` runs through the sandbox exec below.
				if (
					session?.worktreeDir &&
					(existsSync(session.worktreeDir) || hasRemoteWorkspace(session))
				) {
					repos.push({
						repo: session.repo || repoForPath(session.worktreeDir).id,
						dir: session.worktreeDir,
						primary: true,
					});
					for (const r of session.attachedRepos || []) {
						if (existsSync(r.dir))
							repos.push({ repo: r.repo, dir: r.dir, primary: false });
					}
				}
				if (!repos.length) {
					const proj = getRepo(url.searchParams.get("repo") || undefined);
					repos.push({ repo: proj.id, dir: proj.repo, primary: true });
				}
				// Sandbox exec only for the session's own workspace (never for the
				// main-checkout fallback, which isn't mounted in the container).
				const primaryExec =
					session && repos[0]?.primary && repos[0].dir === session.worktreeDir
						? await workspaceExecFor(session, repos[0].dir)
						: undefined;
				const multi = repos.length > 1;
				const perRepo = multi ? Math.max(6, Math.floor(20 / repos.length)) : 20;
				const out: Array<{ display: string; insert: string; repo?: string }> =
					[];
				for (const r of repos) {
					try {
						for (const f of await searchRepoFiles(
							r.dir,
							q,
							perRepo,
							r.primary ? primaryExec : undefined,
						)) {
							out.push({
								display: f,
								insert: r.primary ? f : `${r.repo}:${f}`,
								repo: multi ? r.repo : undefined,
							});
						}
					} catch {}
				}
				// "@"-mentions also surface other sessions (inserted as
				// @session:<id>) so a prompt can reference them by name — e.g.
				// "keep monitoring @session:… and @session:…". Matched on
				// title/branch/id once 2+ chars are typed (a bare "@" stays
				// files-only), newest activity first, after file hits.
				const ql = q.toLowerCase();
				const sessionHits =
					ql.length >= 2
						? getCachedSessions()
								.filter((s) => !s.archived && s.id !== sessionId)
								.filter(
									(s) =>
										(s.title || "").toLowerCase().includes(ql) ||
										(s.branch || "").toLowerCase().includes(ql) ||
										s.id.toLowerCase().includes(ql),
								)
								.sort((a, b) =>
									(b.lastActivity || "").localeCompare(a.lastActivity || ""),
								)
								.slice(0, 5)
								.map((s) => ({
									display: s.title || s.branch || s.id,
									insert: `session:${s.id}`,
									kind: "session" as const,
									sub: s.branch || s.source,
								}))
						: [];
				return Response.json({
					files: [...out.slice(0, 24 - sessionHits.length), ...sessionHits],
				});
			}

			// Skill/command autocomplete ("/" at the start of the composer). Lists
			// what a Claude run in the session's primary checkout would see: user
			// skills+commands (~/.claude) plus the checkout's project ones. Same
			// session/repo resolution as /api/files, primary repo only (project
			// skills load from the run's cwd, so attached repos don't apply).
			if (path === "/backstage/api/skills" && req.method === "GET") {
				const q = url.searchParams.get("q") || "";
				const sessionId = url.searchParams.get("session");
				const session = sessionId ? findSession(sessionId) : undefined;
				let dir: string | undefined =
					session?.worktreeDir && existsSync(session.worktreeDir)
						? session.worktreeDir
						: undefined;
				if (!dir) {
					const proj = getRepo(url.searchParams.get("repo") || undefined);
					if (existsSync(proj.repo)) dir = proj.repo;
				}
				// Backstage's own slash commands (/compact, /model, /goal, …) only
				// work on existing backstage sessions — handleSlashCommand runs in
				// the prompt path, not on new-session opening prompts.
				const includeBuiltins = session?.source === "backstage";
				return Response.json({
					skills: searchSkills(dir, q, undefined, includeBuiltins),
				});
			}

			// Repos available to attach / start a chat against.
			if (path === "/backstage/api/repos" && req.method === "GET") {
				return Response.json({
					repos: Object.values(REPOS).map((p) => ({
						id: p.id,
						defaultBranch: p.defaultBranch,
						sharedCheckout: !!p.sharedCheckout,
					})),
				});
			}

			// ── Projects (folders that group chats) ──
			// A Project is just metadata; membership lives on each chat's `projectId`.
			if (path === "/backstage/api/projects" && req.method === "GET") {
				return Response.json({ projects: listWorkspaces() });
			}

			if (path === "/backstage/api/projects" && req.method === "POST") {
				const body = (await req.json().catch(() => ({}))) as {
					name?: string;
					repo?: string;
					color?: string;
					user?: string;
				};
				if (!body.name || !body.name.trim())
					return Response.json({ error: "name required" }, { status: 400 });
				const project = createWorkspace({
					name: body.name,
					repo: body.repo,
					color: body.color,
					createdBy: body.user || "Anonymous",
				});
				return Response.json({ project });
			}

			const projectMatch = path.match(/^\/backstage\/api\/projects\/(.+)$/);
			if (projectMatch && req.method === "PATCH") {
				const id = decodeURIComponent(projectMatch[1]);
				const body = (await req.json().catch(() => ({}))) as {
					name?: string;
					repo?: string;
					color?: string;
					order?: number;
				};
				const project = updateWorkspace(id, body);
				if (!project)
					return Response.json({ error: "Project not found" }, { status: 404 });
				return Response.json({ project });
			}

			if (projectMatch && req.method === "DELETE") {
				const id = decodeURIComponent(projectMatch[1]);
				// Membership is derived from each chat's projectId — clear it so member
				// chats fall back to standalone rather than pointing at a dead folder.
				for (const s of getAllSessions()) {
					if (s.projectId === id)
						touchBackstageSession(s.id, { projectId: null });
				}
				const ok = deleteWorkspace(id);
				return Response.json({ ok });
			}

			// Start a new sibling chat: an empty chat that shares the source chat's
			// worktree, branch, repo, and project. It has no engine session yet — its
			// first prompt starts a fresh run (see runSessionPrompt). Powers the tab
			// strip's + button ("new chat in this project").
			//
			// Workspace membership is adopt-don't-duplicate: when a chat/create lands
			// on a worktree an existing workspace already owns, it joins that
			// workspace — a second workspace over the same worktree is always the
			// "clicked + and got a whole new workspace" bug. Main checkouts are
			// excluded (shared by every backstage/ask chat, so ownership is
			// meaningless there); see workspaceOwningWorktree.
			const newChatMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/new-chat$/,
			);
			if (newChatMatch && req.method === "POST") {
				const sourceId = decodeURIComponent(newChatMatch[1]);
				const src = findSession(sourceId);
				if (!src)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = (await req.json().catch(() => ({}))) as {
					user?: string;
					mode?: "share" | "stack" | "ask";
					/** Sandbox opt-in (docs/sandboxes-plan.md Phase 0): recorded on the
					 *  session file only — nothing acts on it yet. */
					sandbox?: boolean;
				};
				// share (default): reuse the workspace's worktree/branch (parallel chats,
				// one branch). stack: a new worktree branched off it (stacked PRs). ask:
				// no worktree, read-only on main. Empty chat — first prompt starts the run.
				const chatMode = body.mode || "share";
				// Volume-mode sandbox workspaces live inside ONE session's container —
				// share/stack siblings would either mint a divergent second clone at
				// the same path or ENOENT on the host. Not supported yet.
				if (hasRemoteWorkspace(src) && chatMode !== "ask")
					return Response.json(
						{
							error:
								"This chat's workspace lives inside its sandbox volume — sibling chats aren't supported for volume-mode sandboxes yet (open an Ask chat instead)",
						},
						{ status: 400 },
					);
				const bksId = `bks-${randomUUIDv7()}`;
				let branch = src.branch || "";
				let worktreeDir = src.worktreeDir || "";
				let mode: "ask" | "code" = src.mode || "code";
				let repoId = src.repo;
				if (chatMode === "ask") {
					branch = "";
					worktreeDir = "";
					mode = "ask";
				} else if (chatMode === "stack" && src.branch && src.repo) {
					const repo = getRepo(src.repo);
					if (!repo.sharedCheckout) {
						branch = `${src.branch}-stack-${bksId.slice(4, 10)}`;
						worktreeDir = await createWorktree(branch, repo.id, {
							base: src.branch,
						});
						mode = "code";
					}
				} else if (chatMode === "share" && !worktreeDir && src.projectId) {
					// Same workspace ⇒ same worktree: even when the source chat has no
					// worktree of its own (e.g. + from an ask tab), a share sibling
					// joins the workspace's owned worktree instead of starting bare.
					const ws = getWorkspace(src.projectId);
					if (ws?.worktreeDir && existsSync(ws.worktreeDir)) {
						branch = ws.branch || "";
						worktreeDir = ws.worktreeDir;
						mode = "code";
						repoId = repoForPath(ws.worktreeDir).id;
					}
				}
				// A workspace-less source gets healed here: adopt the workspace that
				// already owns its worktree when there is one (a fresh workspace over
				// an owned worktree is the "clicked + and got a whole new workspace"
				// bug), else wrap the SOURCE in a fresh workspace and put the sibling
				// in it too, so the pair actually links up in the tab strip and
				// sidebar. Read-only sources (slack/linear files) can join an adopted
				// workspace but can't be stamped themselves.
				let workspaceId = src.projectId || null;
				if (!workspaceId) {
					const owned = workspaceOwningWorktree(src.worktreeDir);
					if (owned) {
						workspaceId = owned.id;
						if (src.source === "backstage")
							touchBackstageSession(src.id, { projectId: owned.id });
					} else if (src.source === "backstage") {
						const ws = createWorkspace({
							name: src.title || src.branch || "Workspace",
							repo: src.repo,
							createdBy: body.user || src.startedBy || "Anonymous",
							...(src.branch ? { branch: src.branch } : {}),
							...(src.worktreeDir ? { worktreeDir: src.worktreeDir } : {}),
						});
						touchBackstageSession(src.id, { projectId: ws.id });
						workspaceId = ws.id;
					}
				}
				const data: BackstageSessionFile = {
					id: bksId,
					claudeSessionId: "",
					branch,
					worktreeDir,
					...(repoId ? { repo: repoId } : {}),
					...(workspaceId ? { projectId: workspaceId } : {}),
					createdBy: body.user || "Anonymous",
					createdAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					title: "New chat",
					mode,
					...(body.sandbox === true
						? { sandbox: { provider: effectiveSandboxProvider(repoId) } }
						: {}),
				};
				writeJsonAtomic(`${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`, data);
				sessionsCache = null;
				// Also return the full unified session so the client can drop it into
				// its session list and render the new chat instantly, instead of
				// flashing a loading screen until the next sessions poll lands.
				return Response.json({ id: bksId, session: findSession(bksId) ?? null });
			}

			// Promote an ask chat to code: create a worktree and attach it. Preserves
			// engine memory by copying the ask transcript into the new cwd's project
			// dir so the SDK resume keeps working after the cwd changes (ask chats run
			// in the main checkout; a code worktree has a different cwd-hash dir).
			const promoteMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/promote$/,
			);
			if (promoteMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(promoteMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				if (session.source !== "backstage")
					return Response.json(
						{ error: "Only backstage chats can be promoted" },
						{ status: 400 },
					);
				const body = (await req.json().catch(() => ({}))) as {
					branch?: string;
					repo?: string;
				};
				const repo = getRepo(body.repo || session.repo);
				if (repo.sharedCheckout)
					return Response.json(
						{ error: "Shared-checkout repos have no worktree to create" },
						{ status: 400 },
					);
				const branch = (
					body.branch ||
					(await suggestBranchName(session.title || "chat")) ||
					`chat-${sessionId.slice(4, 10)}`
				).trim();
				const oldCwd = session.worktreeDir || repo.repo;
				const worktreeDir = await createWorktree(branch, repo.id);
				// Best-effort: copy the ask rollout into the new worktree's hash dir so
				// SDK resume (keyed by cwd) finds the prior conversation.
				try {
					if (session.claudeSessionId) {
						const from = getTranscriptPath(oldCwd, session.claudeSessionId);
						const to = getTranscriptPath(worktreeDir, session.claudeSessionId);
						if (existsSync(from) && !existsSync(to)) {
							mkdirSync(to.slice(0, to.lastIndexOf("/")), { recursive: true });
							copyFileSync(from, to);
						}
					}
				} catch (e) {
					console.warn(`[promote] transcript copy failed for ${sessionId}:`, e);
				}
				touchBackstageSession(sessionId, {
					mode: "code",
					branch,
					worktreeDir,
					repo: repo.id,
				});
				// Materialize the workspace's worktree if it doesn't own one yet.
				if (session.projectId) {
					const ws = getWorkspace(session.projectId);
					if (ws && !ws.worktreeDir)
						updateWorkspace(ws.id, { worktreeDir, branch });
				}
				return Response.json({ ok: true, branch, worktreeDir });
			}

			// Move a chat in/out of a Project (folder). `{ projectId: null }` detaches.
			const setProjectMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/project$/,
			);
			if (setProjectMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(setProjectMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = (await req.json().catch(() => ({}))) as {
					projectId?: string | null;
				};
				const projectId = body.projectId ?? null;
				if (projectId && !getWorkspace(projectId))
					return Response.json({ error: "Project not found" }, { status: 404 });
				touchBackstageSession(sessionId, { projectId });
				return Response.json({ ok: true, projectId });
			}

			// Attach a secondary repo to a session (cross-repo work): creates/reuses an
			// isolated worktree and records it on the session.
			const attachMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/attach-repo$/,
			);
			if (attachMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(attachMatch[1]);
				const body = (await req.json().catch(() => ({}))) as {
					repo?: string;
					branch?: string;
				};
				if (!body.repo)
					return Response.json({ error: "repo required" }, { status: 400 });
				try {
					const { attached, all } = await attachRepo(
						sessionId,
						body.repo,
						body.branch,
					);
					return Response.json({ ok: true, attached, attachedRepos: all });
				} catch (e: any) {
					return Response.json(
						{ error: e.message || String(e) },
						{ status: 400 },
					);
				}
			}

			// Is this session fresh enough to switch its primary repo? Drives the
			// clean-only, silent switcher in the RepoBar — no work means no footgun.
			const switchableMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/repo-switchable$/,
			);
			if (switchableMatch && req.method === "GET") {
				const sessionId = decodeURIComponent(switchableMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				// `switchable`: this session type can switch its primary repo at all
				// (ask sessions read the shared checkout — nothing to switch).
				// `hasWork`: it already has commits/edits, so the UI confirms before
				// switching (the work stays in the old worktree, not carried over).
				const switchable = session.mode !== "ask";
				const hasWork =
					switchable &&
					!!session.worktreeDir &&
					!!session.branch &&
					(await worktreeHasWork(
						session.worktreeDir,
						session.branch,
						session.repo,
					));
				return Response.json({ switchable, hasWork });
			}

			// Switch the session's PRIMARY repo (wrong repo picked at creation).
			// Rejects with 400 if the session has work unless `force` is set; the
			// old worktree is left on disk either way, so work is never destroyed.
			const switchMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/switch-primary-repo$/,
			);
			if (switchMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(switchMatch[1]);
				const body = (await req.json().catch(() => ({}))) as {
					repo?: string;
					force?: boolean;
				};
				if (!body.repo)
					return Response.json({ error: "repo required" }, { status: 400 });
				try {
					const result = await switchPrimaryRepo(
						sessionId,
						body.repo,
						!!body.force,
					);
					return Response.json({ ok: true, ...result });
				} catch (e: any) {
					return Response.json(
						{ error: e.message || String(e) },
						{ status: 400 },
					);
				}
			}

			// Detach a secondary repo (drops it from the session; leaves the worktree on
			// disk so unmerged work isn't lost — clean it up via the worktrees sweep).
			// POST, not DELETE, so it isn't swallowed by the generic DELETE /sessions/:id.
			const detachMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/detach-repo$/,
			);
			if (detachMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(detachMatch[1]);
				const body = (await req.json().catch(() => ({}))) as {
					repo?: string;
				};
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const all = (session.attachedRepos || []).filter(
					(r) => r.repo !== body.repo,
				);
				touchBackstageSession(sessionId, { attachedRepos: all });
				return Response.json({ ok: true, attachedRepos: all });
			}

			// ── Linked Slack channels ──
			// Link (or create) a Slack channel for a session so the team can discuss it
			// in context; strictly one channel ↔ one session.
			const linkChanMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/link-channel$/,
			);
			if (linkChanMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(linkChanMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				const body = (await req.json().catch(() => ({}))) as {
					mode?: "create" | "existing";
					name?: string;
					channelId?: string;
				};
				try {
					let channelId: string | undefined;
					let name: string | undefined;
					if (body.mode === "create") {
						const slug =
							(body.name || session.title || "session")
								.toLowerCase()
								.replace(/[^a-z0-9]+/g, "-")
								.replace(/^-+|-+$/g, "")
								.slice(0, 60) || "session";
						const chanName = `michael-${slug}`.slice(0, 80);
						const res = await createSlackChannel(chanName);
						if (!res.ok || !res.channelId)
							return Response.json(
								{ error: res.error || "Could not create channel" },
								{ status: 400 },
							);
						channelId = res.channelId;
						await inviteBotToChannel(channelId);
						await setChannelTopic(channelId, session.title || "Michael session");
						name = (await getChannelName(channelId)) || chanName;
					} else {
						const ref = (body.channelId || body.name || "")
							.trim()
							.replace(/^#/, "");
						if (!ref)
							return Response.json(
								{ error: "channelId or name required" },
								{ status: 400 },
							);
						channelId = /^C[A-Z0-9]+$/i.test(ref)
							? ref
							: (await findSlackChannel(ref)) || undefined;
						if (!channelId)
							return Response.json(
								{ error: "Channel not found" },
								{ status: 404 },
							);
						await inviteBotToChannel(channelId);
						name = (await getChannelName(channelId)) || ref;
					}
					if (!channelId)
						return Response.json(
							{ error: "Could not resolve channel" },
							{ status: 400 },
						);
					// Enforce strictly one-to-one.
					const owner = sessionForChannel(channelId);
					if (owner && owner !== sessionId)
						return Response.json(
							{ error: "That channel is already linked to another session" },
							{ status: 409 },
						);
					const slackChannel = { channelId, name };
					touchBackstageSession(sessionId, { slackChannel });
					linkInIndex(sessionId, channelId);
					broadcastToSession(sessionId, {
						type: "channel_linked",
						sessionId,
						slackChannel,
					});
					return Response.json({ ok: true, slackChannel });
				} catch (e: any) {
					return Response.json(
						{ error: e.message || String(e) },
						{ status: 400 },
					);
				}
			}

			const unlinkChanMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/unlink-channel$/,
			);
			if (unlinkChanMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(unlinkChanMatch[1]);
				const session = findSession(sessionId);
				if (!session)
					return Response.json({ error: "Session not found" }, { status: 404 });
				touchBackstageSession(sessionId, { slackChannel: undefined });
				unlinkInIndex(sessionId);
				broadcastToSession(sessionId, {
					type: "channel_linked",
					sessionId,
					slackChannel: null,
				});
				return Response.json({ ok: true });
			}

			const chanHistMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/channel\/history$/,
			);
			if (chanHistMatch && req.method === "GET") {
				const sessionId = decodeURIComponent(chanHistMatch[1]);
				const session = findSession(sessionId);
				const channelId = session?.slackChannel?.channelId;
				if (!channelId) return Response.json({ messages: [] });
				const messages = await fetchChannelHistory(channelId, 60);
				return Response.json({ messages });
			}

			const chanMsgMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/channel\/message$/,
			);
			if (chanMsgMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(chanMsgMatch[1]);
				const session = findSession(sessionId);
				const channelId = session?.slackChannel?.channelId;
				if (!channelId)
					return Response.json(
						{ error: "No linked channel" },
						{ status: 400 },
					);
				const body = (await req.json().catch(() => ({}))) as {
					text?: string;
					user?: string;
				};
				const rawText = (body.text || "").trim();
				if (!rawText)
					return Response.json({ error: "text required" }, { status: 400 });
				// Tag people: turn "@Name" tokens into real Slack <@id> mentions so the
				// person is pinged. Unknown names are left as plain text.
				const text = rawText.replace(/@([A-Za-z][\w-]*)/g, (whole, nm) => {
					const t = resolveTeammate(nm);
					return t ? `<@${t.slackId}>` : whole;
				});
				// Post as the sender (name + avatar) when we can resolve them.
				const teammate = resolveTeammate(body.user);
				let username = teammate?.name || body.user || "Anonymous";
				let avatarUrl: string | undefined;
				if (teammate) {
					const u = await resolveSlackUser(teammate.slackId);
					username = u.name;
					avatarUrl = u.avatarUrl;
				}
				const res = await postChannelMessageAs(channelId, text, {
					username,
					iconUrl: avatarUrl,
				});
				if (!res.ok)
					return Response.json(
						{ error: "Slack post failed" },
						{ status: 502 },
					);
				const message = {
					ts: res.ts || String(Date.now() / 1000),
					userId: teammate?.slackId || null,
					userName: username,
					avatarUrl,
					text: rawText,
					isBot: !res.overridden,
				};
				// Our bot post is dropped by /slack/events, so echo it to every client.
				broadcastToAll({ type: "slack_message", channelId, message });
				return Response.json({ ok: true, message });
			}

			// The conversation timeline for a session's linked Plain thread,
			// flattened for the session viewer's read-only Plain sidebar.
			const plainThreadMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/plain\/thread$/,
			);
			if (plainThreadMatch && req.method === "GET") {
				const sessionId = decodeURIComponent(plainThreadMatch[1]);
				const session = findSession(sessionId);
				const threadId = session?.plainThreadId;
				if (!threadId)
					return Response.json(
						{ error: "No linked Plain thread" },
						{ status: 400 },
					);
				try {
					const { getThreadWithMessages, normalizePlainThread } =
						await import("./src/agents/plain/api");
					const thread = await getThreadWithMessages(threadId);
					if (!thread)
						return Response.json(
							{ error: "Thread not found" },
							{ status: 404 },
						);
					return Response.json({ thread: normalizePlainThread(thread) });
				} catch (e: any) {
					console.error(`[plain-thread] Lookup failed for ${threadId}:`, e);
					return Response.json(
						{ error: e?.message || "Plain lookup failed" },
						{ status: 502 },
					);
				}
			}

			// The Support sidebar's ticket queue: every TODO Plain thread, newest
			// status change first (Plain's own Todo-inbox ordering). Cached ~30s.
			if (path === "/backstage/api/plain/threads" && req.method === "GET") {
				if (plainTodoCache && Date.now() - plainTodoCache.ts < PLAIN_TODO_TTL)
					return Response.json({ threads: plainTodoCache.data });
				try {
					const { listTodoThreads } = await import("./src/agents/plain/api");
					const threads = await listTodoThreads(50);
					plainTodoCache = { data: threads, ts: Date.now() };
					return Response.json({ threads });
				} catch (e: any) {
					console.error("[plain-threads] List failed:", e);
					return Response.json(
						{ error: e?.message || "Plain lookup failed" },
						{ status: 502 },
					);
				}
			}

			// A thread's conversation timeline by thread id — the session-less
			// Support preview reads this (no session exists for the ticket yet).
			const plainThreadByIdMatch = path.match(
				/^\/backstage\/api\/plain\/threads\/([^/]+)$/,
			);
			if (plainThreadByIdMatch && req.method === "GET") {
				const threadId = decodeURIComponent(plainThreadByIdMatch[1]);
				try {
					const { getThreadWithMessages, normalizePlainThread } =
						await import("./src/agents/plain/api");
					const thread = await getThreadWithMessages(threadId);
					if (!thread)
						return Response.json(
							{ error: "Thread not found" },
							{ status: 404 },
						);
					return Response.json({ thread: normalizePlainThread(thread) });
				} catch (e: any) {
					console.error(`[plain-thread] Lookup failed for ${threadId}:`, e);
					return Response.json(
						{ error: e?.message || "Plain lookup failed" },
						{ status: 502 },
					);
				}
			}

			// Human reply into a Plain thread from the Support preview / a
			// session's Plain tab: a customer-facing reply (email/chat, sent as
			// the Plain machine user) or an internal note. This is the human gate
			// itself — agent runs never get this path as a tool; automation runs
			// are denied Plain thread writes at the tool layer.
			const plainReplyMatch = path.match(
				/^\/backstage\/api\/plain\/threads\/([^/]+)\/reply$/,
			);
			if (plainReplyMatch && req.method === "POST") {
				const threadId = decodeURIComponent(plainReplyMatch[1]);
				const body = (await req.json().catch(() => null)) as {
					text?: string;
					kind?: string;
					user?: string;
				} | null;
				const text = typeof body?.text === "string" ? body.text.trim() : "";
				const kind = body?.kind === "note" ? "note" : "reply";
				if (!text)
					return Response.json({ error: "Empty message" }, { status: 400 });
				// Plain's API can only impersonate customers, not workspace users, so
				// everything lands as the Michael machine user — carry the human's
				// name in the message instead: replies get their first name as an
				// email-style sign-off (unless they already signed), notes get an
				// author prefix.
				const senderName =
					typeof body?.user === "string" ? body.user.trim() : "";
				const firstName = senderName.split(/\s+/)[0] || "";
				try {
					const { getThreadWithMessages, postNote, sendCustomerReply } =
						await import("./src/agents/plain/api");
					if (kind === "note") {
						// Notes need the customer id; the thread lookup carries it.
						const thread = await getThreadWithMessages(threadId);
						const customerId = thread?.customer?.id;
						if (!customerId) throw new Error("Thread has no customer");
						const noteText = firstName
							? `**${senderName} (via Backstage):**\n\n${text}`
							: text;
						const ok = await postNote(threadId, customerId, noteText);
						if (!ok) throw new Error("Plain rejected the note");
					} else {
						const alreadySigned =
							firstName &&
							new RegExp(
								`${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
								"i",
							).test(text.trimEnd());
						const replyText =
							firstName && !alreadySigned
								? `${text.trimEnd()}\n\n${firstName}`
								: text;
						const ok = await sendCustomerReply(threadId, "", replyText);
						if (!ok) throw new Error("Plain rejected the reply");
					}
					console.log(
						`[plain-reply] ${body?.user || "someone"} sent a ${kind} to ${threadId}`,
					);
					return Response.json({ ok: true });
				} catch (e: any) {
					console.error(`[plain-reply] ${kind} to ${threadId} failed:`, e);
					return Response.json(
						{ error: e?.message || "Plain write failed" },
						{ status: 502 },
					);
				}
			}

			// JSON twin of the /backstage/plain-triage/<id> redirect: the Support
			// preview's "Triage this ticket" button. Reuses a live session linked to
			// the thread, else starts the triage automation and waits for its
			// session to boot (~15-60s — the client shows a progress state).
			const plainTriageApiMatch = path.match(
				/^\/backstage\/api\/plain\/triage\/([^/]+)$/,
			);
			if (plainTriageApiMatch && req.method === "POST") {
				const threadId = decodeURIComponent(plainTriageApiMatch[1]);
				const sessionId = await resolvePlainTriageSession(threadId);
				if (!sessionId)
					return Response.json(
						{ error: "Failed to start a triage session" },
						{ status: 502 },
					);
				return Response.json({ sessionId });
			}

			// ── Automations ──
			if (path === "/backstage/api/automation-templates" && req.method === "GET") {
				return Response.json(AUTOMATION_TEMPLATES);
			}

			// Draft an automation config from a free-text description (one-shot
			// Haiku; the draft only pre-fills the form, it's never saved directly).
			if (path === "/backstage/api/automations/draft" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body || typeof body.description !== "string")
					return Response.json({ error: "description required" }, { status: 400 });
				const draft = await draftAutomation(body.description);
				if (!draft)
					return Response.json(
						{ error: "Couldn't draft an automation from that — add more detail or fill the form manually" },
						{ status: 422 },
					);
				return Response.json(draft);
			}

			if (path === "/backstage/api/automations" && req.method === "GET") {
				const list = listAutomations().map((a) => ({
					...a,
					isRunning: isAutomationRunning(a.id),
				}));
				return Response.json(list);
			}

			if (path === "/backstage/api/automations" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const result = createAutomation(body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const autoRunMatch = path.match(
				/^\/backstage\/api\/automations\/([^/]+)\/run$/,
			);
			if (autoRunMatch && req.method === "POST") {
				const automation = getAutomation(autoRunMatch[1]);
				if (!automation)
					return Response.json({ error: "Not found" }, { status: 404 });
				if (isAutomationRunning(automation.id)) {
					return Response.json({ error: "Already running" }, { status: 409 });
				}
				// Fire and forget; session shows up in the list once it boots
				void runAutomation(automation, () => {
					sessionsCache = null;
				});
				return Response.json({ ok: true });
			}

			const autoMatch = path.match(/^\/backstage\/api\/automations\/([^/]+)$/);
			if (autoMatch && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const result = updateAutomation(autoMatch[1], body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			if (autoMatch && req.method === "DELETE") {
				return deleteAutomation(autoMatch[1])
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			// ── Scheduled prompts (composer "send later") ──
			const schedListMatch = path.match(
				/^\/backstage\/api\/sessions\/([^/]+)\/scheduled-prompts$/,
			);
			if (schedListMatch && req.method === "GET") {
				const { listScheduledPrompts } = await import(
					"./src/server/scheduled-prompts"
				);
				return Response.json({
					prompts: listScheduledPrompts(schedListMatch[1]),
				});
			}

			if (schedListMatch && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const { createScheduledPrompt } = await import(
					"./src/server/scheduled-prompts"
				);
				const result = createScheduledPrompt({
					sessionId: schedListMatch[1],
					prompt: body.prompt,
					at: body.at,
					user: body.user,
				});
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const schedDelMatch = path.match(
				/^\/backstage\/api\/scheduled-prompts\/([^/]+)$/,
			);
			if (schedDelMatch && req.method === "DELETE") {
				const { deleteScheduledPrompt } = await import(
					"./src/server/scheduled-prompts"
				);
				return deleteScheduledPrompt(schedDelMatch[1])
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			// ── Human asks (waiting-on-teammates board) ──
			if (path === "/backstage/api/human-asks" && req.method === "GET") {
				const { listAsks } = await import("./src/server/human-asks");
				return Response.json({
					asks: listAsks({
						includeAnswered: url.searchParams.get("all") === "1",
					}),
				});
			}

			const askNudgeMatch = path.match(
				/^\/backstage\/api\/human-asks\/([^/]+)\/nudge$/,
			);
			if (askNudgeMatch && req.method === "POST") {
				const { getAsk } = await import("./src/server/human-asks");
				const ask = getAsk(askNudgeMatch[1]);
				if (!ask) return Response.json({ error: "Not found" }, { status: 404 });
				if (ask.state !== "delivered" || !ask.slack)
					return Response.json(
						{ error: "Ask isn't awaiting an answer on Slack" },
						{ status: 400 },
					);
				const { sendSlackMessage } = await import(
					"./src/agents/slack/slack-api"
				);
				await sendSlackMessage(
					ask.slack.channel,
					`It's Michael — friendly nudge, still waiting on this one 🙏`,
					ask.slack.rootTs,
				);
				return Response.json({ ok: true });
			}

			const askCancelMatch = path.match(
				/^\/backstage\/api\/human-asks\/([^/]+)$/,
			);
			if (askCancelMatch && req.method === "DELETE") {
				const { cancelAsk } = await import("./src/server/human-asks");
				return cancelAsk(askCancelMatch[1])
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			// ── Audit log viewer (Settings → Audit log) ──
			if (path === "/backstage/api/audit" && req.method === "GET") {
				const { listAuditDates, readAuditEvents } = await import(
					"./src/server/audit"
				);
				const date = url.searchParams.get("date") || "";
				const dates = listAuditDates();
				if (!date) return Response.json({ dates });
				return Response.json({
					dates,
					...readAuditEvents({
						date,
						q: url.searchParams.get("q") || undefined,
						type: url.searchParams.get("type") || undefined,
						session: url.searchParams.get("session") || undefined,
						significantOnly: url.searchParams.get("all") !== "1",
						offset: Number(url.searchParams.get("offset")) || 0,
						limit: Number(url.searchParams.get("limit")) || 200,
					}),
				});
			}

			// ── Team chat (native Backstage chat, unrelated to Slack). Channels:
			// "watercooler" (team-wide) and "session:<id>" (per-session Chat tab). ──
			if (path === "/backstage/api/chat/messages" && req.method === "GET") {
				const { getChatMessages, isValidChatChannel } = await import(
					"./src/server/chat"
				);
				const channel = url.searchParams.get("channel") || "watercooler";
				if (!isValidChatChannel(channel))
					return Response.json({ error: "invalid channel" }, { status: 400 });
				const limit = Number(url.searchParams.get("limit")) || 200;
				return Response.json({ messages: getChatMessages(channel, limit) });
			}

			// Upload an image for a chat message. Streams the body to permanent
			// per-image storage (not the transient session-upload staging dir) and
			// returns its {id,name,mime} ref, which the client attaches to the message.
			if (path === "/backstage/api/chat/upload" && req.method === "POST") {
				try {
					const { saveChatImage } = await import("./src/server/chat");
					const name = decodeURIComponent(
						req.headers.get("x-file-name") || "image",
					);
					const mime = req.headers.get("content-type") || "";
					const bytes = new Uint8Array(await req.arrayBuffer());
					const img = saveChatImage(bytes, name, mime);
					return Response.json({ ok: true, ...img });
				} catch (e) {
					return Response.json(
						{ ok: false, error: String((e as Error)?.message || e) },
						{ status: 400 },
					);
				}
			}

			// Serve a stored chat image by id (Content-Type from its sidecar).
			const chatImgMatch = path.match(
				/^\/backstage\/api\/chat\/image\/([0-9a-fA-F-]{36})$/,
			);
			if (chatImgMatch && req.method === "GET") {
				const { getChatImage } = await import("./src/server/chat");
				const img = getChatImage(chatImgMatch[1]);
				if (!img) return new Response("not found", { status: 404 });
				return new Response(Bun.file(img.path), {
					headers: {
						"content-type": img.mime,
						"cache-control": "public, max-age=31536000, immutable",
						"x-content-type-options": "nosniff",
					},
				});
			}

			if (path === "/backstage/api/chat/messages" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				const user = typeof body?.user === "string" ? body.user.trim() : "";
				const text = typeof body?.text === "string" ? body.text.trim() : "";
				const images = Array.isArray(body?.images) ? body.images : [];
				const channel =
					typeof body?.channel === "string" ? body.channel : "watercooler";
				const { addChatMessage, mentionedUsers, isValidChatChannel } =
					await import("./src/server/chat");
				// A message needs either text or at least one image.
				if (!user || (!text && images.length === 0))
					return Response.json(
						{ error: "user and text or image required" },
						{ status: 400 },
					);
				if (!isValidChatChannel(channel))
					return Response.json({ error: "invalid channel" }, { status: 400 });
				const message = addChatMessage(channel, user, text, images);
				// null = nothing to store (no text + no image that landed on disk).
				if (!message)
					return Response.json(
						{ error: "user and text or image required" },
						{ status: 400 },
					);
				// Everyone gets it live — clients not viewing this channel use the
				// same event to bump unread badges.
				broadcastToAll({ type: "chat_message", channel, message });
				// @-mentions ping the tagged teammate's devices (works app-closed).
				const { sendPushToUser } = await import("./src/server/push");
				const inSession = channel.startsWith("session:");
				for (const name of mentionedUsers(text, user)) {
					void sendPushToUser(name, {
						title: inSession
							? `${user} mentioned you in a session chat`
							: `${user} mentioned you in the Watercooler`,
						body: text.length > 140 ? `${text.slice(0, 139)}…` : text,
						url: inSession
							? `/backstage/session/${encodeURIComponent(channel.slice("session:".length))}`
							: "/backstage/watercooler",
						tag: `backstage-chat-${channel}`,
					});
				}
				return Response.json({ message });
			}

			// ── Web Push (phone/desktop notifications, app closed) ──
			if (path === "/backstage/api/push/vapid-key" && req.method === "GET") {
				const { getVapidPublicKey } = await import("./src/server/push");
				return Response.json({ publicKey: getVapidPublicKey() });
			}

			if (path === "/backstage/api/push/subscribe" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const { addPushSubscription } = await import("./src/server/push");
				const result = addPushSubscription({
					user: body.user,
					subscription: body.subscription,
					userAgent: req.headers.get("user-agent") || undefined,
				});
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			if (path === "/backstage/api/push/unsubscribe" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body || typeof body.endpoint !== "string")
					return Response.json({ error: "endpoint required" }, { status: 400 });
				const { removePushSubscription } = await import("./src/server/push");
				removePushSubscription(body.endpoint);
				return Response.json({ ok: true });
			}

			// ── Session monitor (per-user, opt-in) ──
			if (path === "/backstage/api/monitor" && req.method === "GET") {
				const user = (url.searchParams.get("user") || "").trim();
				if (!user)
					return Response.json({ error: "user required" }, { status: 400 });
				const { getMonitorConfig } = await import(
					"./src/agents/loops/session-monitor"
				);
				return Response.json(getMonitorConfig(user));
			}

			if (path === "/backstage/api/monitor" && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body || typeof body.user !== "string" || !body.user.trim())
					return Response.json({ error: "user required" }, { status: 400 });
				const { setMonitorConfig } = await import(
					"./src/agents/loops/session-monitor"
				);
				return Response.json(setMonitorConfig(body.user, body));
			}

			// ── Auto-archive (per-user, opt-in by repo) ──
			if (path === "/backstage/api/auto-archive" && req.method === "GET") {
				const user = (url.searchParams.get("user") || "").trim();
				if (!user)
					return Response.json({ error: "user required" }, { status: 400 });
				return Response.json({
					...getAutoArchiveConfig(user),
					availableRepos: Object.keys(REPOS),
				});
			}

			if (path === "/backstage/api/auto-archive" && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body || typeof body.user !== "string" || !body.user.trim())
					return Response.json({ error: "user required" }, { status: 400 });
				return Response.json(setAutoArchiveConfig(body.user, body));
			}

			// ── Security (deepsec scans + profiles) ──
			if (path === "/backstage/api/security" && req.method === "GET") {
				return Response.json({
					scans: listScans(),
					profiles: listProfiles(),
					repos: scannableRepos().map((r) => ({
						id: r.id,
						defaultBranch: r.defaultBranch,
					})),
				});
			}

			if (path === "/backstage/api/security/scans" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const allIds = scannableRepos().map((r) => r.id);
				const repos: string[] =
					body.repos === "all"
						? allIds
						: Array.isArray(body.repos)
							? body.repos.filter((r: unknown): r is string =>
									typeof r === "string" && allIds.includes(r),
								)
							: [];
				if (!repos.length)
					return Response.json(
						{ error: "Pick at least one repository" },
						{ status: 400 },
					);
				const createdBy =
					typeof body.createdBy === "string" && body.createdBy.trim()
						? body.createdBy.trim()
						: "Anonymous";
				const profile =
					typeof body.profileId === "string" && body.profileId
						? getProfile(body.profileId)
						: null;
				const instructions =
					typeof body.instructions === "string" ? body.instructions : undefined;
				const recurrence =
					body.recurrence === "daily" || body.recurrence === "weekly"
						? body.recurrence
						: null;

				// Recurring scans become automations (single source of scheduling
				// truth — they show up on the Security page's Recurring list and in
				// Automations). Code-mode automations run tella-fusion worktrees only.
				if (recurrence) {
					if (repos.length !== 1 || repos[0] !== "tella-fusion")
						return Response.json(
							{ error: "Recurring scans support a single repo (tella-fusion) for now" },
							{ status: 400 },
						);
					const result = createAutomation({
						name: `deepsec ${recurrence} scan — ${profile?.name || "custom"}`,
						prompt: buildScanPrompt(getRepo(repos[0]), profile, instructions),
						schedule: recurrence === "daily" ? "0 13 * * *" : "0 8 * * 0",
						mode: "code",
						createdBy,
						mcpServers: [],
					});
					if ("error" in result)
						return Response.json(result, { status: 400 });
					return Response.json({ automation: result });
				}

				// Interactive: one collaborative session that tailors the threat
				// model with the user before scanning. Registry sessions run
				// tella-fusion worktrees, so single-repo tella-fusion only.
				if (body.interactive) {
					if (repos.length !== 1 || repos[0] !== "tella-fusion")
						return Response.json(
							{ error: "Interactive scans support a single repo (tella-fusion) for now" },
							{ status: 400 },
						);
					const branch = `deepsec-interactive-${new Date()
						.toISOString()
						.slice(0, 16)
						.replace(/[-T:]/g, "")}`;
					const { id } = await getSessionControl().createSession({
						prompt: buildInteractivePrompt(getRepo(repos[0]), profile, instructions),
						branch,
						mode: "code",
						user: createdBy,
					});
					const scan = createScanRecord({
						repos,
						profileId: profile?.id,
						instructions,
						interactive: true,
						createdBy,
						sessionId: id,
					});
					return Response.json({ scan, sessionId: id });
				}

				const scan = createScanRecord({
					repos,
					profileId: profile?.id,
					instructions,
					createdBy,
				});
				void executeScan(scan, {
					onSessionCreated: () => {
						sessionsCache = null;
					},
				});
				return Response.json({ scan });
			}

			const scanMatch = path.match(/^\/backstage\/api\/security\/scans\/([^/]+)$/);
			if (scanMatch && req.method === "DELETE") {
				return deleteScan(scanMatch[1])
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			if (path === "/backstage/api/security/profiles" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const result = createProfile(body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const profileMatch = path.match(
				/^\/backstage\/api\/security\/profiles\/([^/]+)$/,
			);
			if (profileMatch && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const result = updateProfile(profileMatch[1], body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			if (profileMatch && req.method === "DELETE") {
				return deleteProfile(profileMatch[1])
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			// ── Goals (long-running, self-pacing missions) ──
			if (path === "/backstage/api/goals" && req.method === "GET") {
				const list = listGoals().map((g) => ({
					...g,
					isRunning: runningGoals.has(g.id),
				}));
				return Response.json(list);
			}

			if (path === "/backstage/api/goals" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const result = createGoal(body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			// Specific sub-routes must precede the bare /:id matcher.
			const goalRunMatch = path.match(/^\/backstage\/api\/goals\/([^/]+)\/run$/);
			if (goalRunMatch && req.method === "POST") {
				const goal = getGoal(goalRunMatch[1]);
				if (!goal) return Response.json({ error: "Not found" }, { status: 404 });
				if (runningGoals.has(goal.id)) {
					return Response.json({ error: "Already running" }, { status: 409 });
				}
				// Fire a wake now; the session shows up in the list once it boots.
				void runGoal(goal);
				return Response.json({ ok: true });
			}

			const goalResumeMatch = path.match(
				/^\/backstage\/api\/goals\/([^/]+)\/resume$/,
			);
			if (goalResumeMatch && req.method === "POST") {
				const body = await req.json().catch(() => null);
				const result = resumeGoal(goalResumeMatch[1], body?.when);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const goalPauseMatch = path.match(
				/^\/backstage\/api\/goals\/([^/]+)\/pause$/,
			);
			if (goalPauseMatch && req.method === "POST") {
				const body = await req.json().catch(() => null);
				const result = updateGoal(goalPauseMatch[1], {
					status: "paused",
					pauseReason: body?.reason?.trim() || "Paused from the UI",
				});
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const goalMatch = path.match(/^\/backstage\/api\/goals\/([^/]+)$/);
			if (goalMatch && req.method === "GET") {
				const goal = getGoal(goalMatch[1]);
				if (!goal) return Response.json({ error: "Not found" }, { status: 404 });
				let ledger = "";
				try {
					if (existsSync(goal.stateFile))
						ledger = readFileSync(goal.stateFile, "utf-8");
				} catch {}
				return Response.json({
					...goal,
					ledger,
					isRunning: runningGoals.has(goal.id),
				});
			}

			if (goalMatch && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const result = updateGoal(goalMatch[1], body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			if (goalMatch && req.method === "DELETE") {
				return deleteGoal(goalMatch[1])
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			// ── Actions (run a registered repo script behind a form) ──
			if (path === "/backstage/api/actions" && req.method === "GET") {
				return Response.json(listActions());
			}

			if (path === "/backstage/api/actions" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const result = createAction(body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			// Suggest inputs for a script being registered (parses $1..$9 / $VAR).
			if (
				path === "/backstage/api/actions/introspect" &&
				req.method === "POST"
			) {
				const body = (await req.json().catch(() => ({}))) as {
					repo?: string;
					scriptPath?: string;
				};
				const result = introspectScript(
					body.repo || "tella-fusion",
					String(body.scriptPath || ""),
				);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const actionRunMatch = path.match(
				/^\/backstage\/api\/actions\/([^/]+)\/run$/,
			);
			if (actionRunMatch && req.method === "POST") {
				const action = getAction(actionRunMatch[1]);
				if (!action)
					return Response.json({ error: "Not found" }, { status: 404 });
				const body = (await req.json().catch(() => ({}))) as {
					values?: Record<string, unknown>;
					user?: string;
				};
				const result = runAction(action, body.values || {}, body.user, () => {
					sessionsCache = null;
				});
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const actionMatch = path.match(/^\/backstage\/api\/actions\/([^/]+)$/);
			if (actionMatch && req.method === "GET") {
				const action = getAction(actionMatch[1]);
				return action
					? Response.json(action)
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			if (actionMatch && req.method === "DELETE") {
				return deleteAction(actionMatch[1])
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			// ── Connections ──
			if (path === "/backstage/api/connections" && req.method === "GET") {
				const force = url.searchParams.get("refresh") === "1";
				const mcpServers = await getConnections(force);
				const agentHealth: Record<string, unknown> = {};
				for (const a of agents) agentHealth[a.name] = a.health();
				return Response.json({ mcpServers, agents: agentHealth });
			}

			if (path === "/backstage/api/connections/mcp" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const result = addMcpServer(body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const mcpDelMatch = path.match(
				/^\/backstage\/api\/connections\/mcp\/([^/]+)$/,
			);
			if (mcpDelMatch && req.method === "DELETE") {
				const result = removeMcpServer(decodeURIComponent(mcpDelMatch[1]));
				if ("error" in result) return Response.json(result, { status: 404 });
				return Response.json(result);
			}

			// Restrict an existing MCP server to specific users (or clear the
			// restriction with an empty/absent list).
			if (mcpDelMatch && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				const allowedUsers = Array.isArray(body?.allowedUsers)
					? body.allowedUsers
					: undefined;
				const result = setMcpAllowedUsers(
					decodeURIComponent(mcpDelMatch[1]),
					allowedUsers,
				);
				if ("error" in result) return Response.json(result, { status: 404 });
				return Response.json(result);
			}

			// ── Plain triage router (spam gate + model routing for new tickets) ──
			// The prompt is editable so routing can be tweaked without a deploy;
			// the JSON output contract is appended in code and can't be broken here.
			if (
				path === "/backstage/api/connections/plain-router" &&
				req.method === "GET"
			) {
				const { getRouterConfig, DEFAULT_ROUTER_PROMPT, DEFAULT_BASIC_MODEL } =
					await import("./src/agents/plain/ticket-router");
				return Response.json({
					...getRouterConfig(),
					defaultPrompt: DEFAULT_ROUTER_PROMPT,
					defaultBasicModel: DEFAULT_BASIC_MODEL,
				});
			}

			if (
				path === "/backstage/api/connections/plain-router" &&
				req.method === "PUT"
			) {
				const body = (await req.json().catch(() => null)) as {
					prompt?: string;
					basicModel?: string;
				} | null;
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const { setRouterConfig } = await import(
					"./src/agents/plain/ticket-router"
				);
				const result = setRouterConfig(body);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			// ── Claude account pool (tokens are never sent back, only masked) ──
			if (path === "/backstage/api/claude-accounts" && req.method === "GET") {
				return Response.json({ accounts: listAccountsPublic() });
			}

			if (path === "/backstage/api/claude-accounts" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (!body?.name || !body?.token) {
					return Response.json(
						{ error: "name and token are required" },
						{ status: 400 },
					);
				}
				const result = await addAccount(
					body.name,
					body.token,
					typeof body.owner === "string" ? body.owner : undefined,
					typeof body.credentialsPath === "string" ? body.credentialsPath : undefined,
				);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			if (
				path === "/backstage/api/claude-accounts/refresh" &&
				req.method === "POST"
			) {
				await refreshAllUsage();
				return Response.json({ accounts: listAccountsPublic() });
			}

			const accountDelMatch = path.match(
				/^\/backstage\/api\/claude-accounts\/([^/]+)$/,
			);
			if (accountDelMatch && req.method === "DELETE") {
				return removeAccount(decodeURIComponent(accountDelMatch[1]))
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}
			// Set/clear an account's personal owner ({"owner": "Michiel"} or "").
			if (accountDelMatch && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				const updated = setAccountOwner(
					decodeURIComponent(accountDelMatch[1]),
					typeof body?.owner === "string" ? body.owner : undefined,
					typeof body?.credentialsPath === "string"
						? body.credentialsPath
						: undefined,
				);
				return updated
					? Response.json(updated)
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			// ── Models available to sessions ──
			if (path === "/backstage/api/models" && req.method === "GET") {
				return Response.json({
					models: KNOWN_MODELS,
					default: getDefaultModel(),
					autoFallback: getModelFallbackAuto(),
				});
			}

			// What an interactive session will be told on top of the claude_code
			// preset — previewed in the New Session modal. Same builder the runner
			// uses (src/server/system-prompt.ts), so this can't drift from reality.
			if (path === "/backstage/api/system-prompt" && req.method === "GET") {
				const isAsk = url.searchParams.get("mode") === "ask";
				return Response.json({
					preset: "claude_code",
					settingSources: ["user", "project"],
					parts: buildSystemPromptParts({
						isAsk,
						sessionLink: isAsk
							? undefined
							: `${process.env.MICHAEL_UI_BASE || "https://michael.taila5d766.ts.net/backstage"}/session/<this-session>`,
						interactiveTools: true,
					}),
				});
			}

			// Toggle interactive auto model-switch (manual vs auto) on running out
			// of credits. { auto: boolean }.
			if (path === "/backstage/api/models/auto-fallback" && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body || typeof body.auto !== "boolean") {
					return Response.json(
						{ error: "auto (boolean) is required" },
						{ status: 400 },
					);
				}
				return Response.json({ autoFallback: setModelFallbackAuto(body.auto) });
			}

			// Suggest a branch name from a task prompt (one no-tools Haiku call).
			// Used to auto-fill the New Session "Branch name" field as you type.
			if (path === "/backstage/api/suggest-branch" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				const prompt = typeof body?.prompt === "string" ? body.prompt : "";
				const branch = await suggestBranchName(prompt);
				return Response.json({ branch });
			}

			// Voice dictation: raw audio body (whatever MediaRecorder produced) in,
			// transcribed text out. Providers chain in src/server/transcribe.ts —
			// hosted keys when configured, local whisper.cpp otherwise.
			if (path === "/backstage/api/transcribe" && req.method === "POST") {
				try {
					const audio = await req.blob();
					if (audio.size === 0) {
						return Response.json({ error: "empty audio" }, { status: 400 });
					}
					if (audio.size > MAX_AUDIO_BYTES) {
						return Response.json({ error: "audio too large" }, { status: 413 });
					}
					const mime = req.headers.get("content-type") || "audio/webm";
					const result = await transcribeAudio(audio, mime);
					return Response.json(result);
				} catch (e: any) {
					console.error("[transcribe]", e);
					return Response.json(
						{ error: e?.message || "transcription failed" },
						{ status: 500 },
					);
				}
			}

			// Set (or clear, with model:null) the default model new sessions run on.
			if (path === "/backstage/api/models/default" && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body || !("model" in body)) {
					return Response.json(
						{ error: "model is required (id, or null to clear)" },
						{ status: 400 },
					);
				}
				try {
					const next = setDefaultModel(body.model ?? null);
					return Response.json({ default: next });
				} catch (e: any) {
					return Response.json(
						{ error: e?.message || "Failed to set default model" },
						{ status: 400 },
					);
				}
			}

			// ── Per-user pinned tabs ──
			// Keyed on the self-selected `user` name (team-internal, not auth). GET reads
			// a user's pins; PUT replaces them wholesale (the frontend sends the full list
			// on every toggle and on first-load localStorage migration).
			if (path === "/backstage/api/pins" && req.method === "GET") {
				const user = url.searchParams.get("user") || "Anonymous";
				return Response.json({ pins: getUserPins(user) });
			}

			if (path === "/backstage/api/pins" && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (
					!body ||
					typeof body.user !== "string" ||
					!Array.isArray(body.pins)
				) {
					return Response.json(
						{ error: "user (string) and pins (array) are required" },
						{ status: 400 },
					);
				}
				return Response.json({ pins: setUserPins(body.user, body.pins) });
			}

			// ── Per-user session tab colors ──
			// Same per-user model as pins: GET reads a user's tab colors; PUT replaces
			// the whole map (the frontend sends the full map on every color change).
			if (path === "/backstage/api/tab-colors" && req.method === "GET") {
				const user = url.searchParams.get("user") || "Anonymous";
				return Response.json({ colors: getUserTabColors(user) });
			}

			if (path === "/backstage/api/tab-colors" && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (
					!body ||
					typeof body.user !== "string" ||
					typeof body.colors !== "object" ||
					body.colors === null
				) {
					return Response.json(
						{ error: "user (string) and colors (object) are required" },
						{ status: 400 },
					);
				}
				return Response.json({
					colors: setUserTabColors(body.user, body.colors),
				});
			}

			// ── Codex (OpenAI) account pool ──
			if (path === "/backstage/api/codex-accounts" && req.method === "GET") {
				return Response.json({ accounts: listCodexAccountsPublic() });
			}

			if (path === "/backstage/api/codex-accounts" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				if (
					!body?.name ||
					!body?.value ||
					!["api_key", "home"].includes(body?.kind)
				) {
					return Response.json(
						{ error: "name, kind (api_key|home) and value are required" },
						{ status: 400 },
					);
				}
				const result = addCodexAccount(body.name, body.kind, body.value);
				if ("error" in result) return Response.json(result, { status: 400 });
				return Response.json(result);
			}

			const codexAccountDelMatch = path.match(
				/^\/backstage\/api\/codex-accounts\/([^/]+)$/,
			);
			if (codexAccountDelMatch && req.method === "DELETE") {
				return removeCodexAccount(decodeURIComponent(codexAccountDelMatch[1]))
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			// ── Notes (shared, collaborative; content syncs over WS) ──
			if (path === "/backstage/api/notes" && req.method === "GET") {
				seedIfEmpty();
				return Response.json({ notes: listNotes() });
			}

			if (path === "/backstage/api/notes" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				const note = createNote(
					typeof body?.title === "string" ? body.title : undefined,
				);
				return Response.json({ note });
			}

			// Full-text search across notes (merged with docs hits client-side).
			// Must precede the generic /notes/:id matcher ("search" is not an id).
			if (path === "/backstage/api/notes/search" && req.method === "GET") {
				const { searchNotes } = await import("./src/server/notes");
				return Response.json({
					hits: searchNotes(url.searchParams.get("q") || ""),
				});
			}

			const noteBacklinksMatch = path.match(
				/^\/backstage\/api\/notes\/([^/]+)\/backlinks$/,
			);
			if (noteBacklinksMatch && req.method === "GET") {
				const id = decodeURIComponent(noteBacklinksMatch[1]);
				if (!isValidNoteId(id))
					return Response.json({ error: "Invalid id" }, { status: 400 });
				const { noteBacklinks } = await import("./src/server/notes");
				return Response.json({ notes: noteBacklinks(id) });
			}

			const noteMatch = path.match(/^\/backstage\/api\/notes\/([^/]+)$/);
			if (noteMatch && req.method === "GET") {
				const id = decodeURIComponent(noteMatch[1]);
				if (!isValidNoteId(id))
					return Response.json({ error: "Invalid id" }, { status: 400 });
				const notes = listNotes();
				const meta = notes.find((n) => n.id === id);
				if (!meta) return Response.json({ error: "Not found" }, { status: 404 });
				return Response.json({ ...meta, text: getNoteText(id) });
			}

			if (noteMatch && req.method === "DELETE") {
				const id = decodeURIComponent(noteMatch[1]);
				if (!isValidNoteId(id))
					return Response.json({ error: "Invalid id" }, { status: 400 });
				return deleteNote(id)
					? Response.json({ ok: true })
					: Response.json({ error: "Not found" }, { status: 404 });
			}

			const notePromptMatch = path.match(
				/^\/backstage\/api\/notes\/([^/]+)\/prompt$/,
			);
			if (notePromptMatch && req.method === "POST") {
				const id = decodeURIComponent(notePromptMatch[1]);
				if (!isValidNoteId(id))
					return Response.json({ error: "Invalid id" }, { status: 400 });
				const body = await req.json().catch(() => null);
				const instruction = typeof body?.prompt === "string" ? body.prompt : "";
				if (!instruction.trim())
					return Response.json({ error: "prompt required" }, { status: 400 });
				const next = await editNote(getNoteText(id), instruction);
				if (next == null)
					return Response.json(
						{ error: "Could not update the note" },
						{ status: 422 },
					);
				// Apply as a minimal diff to the shared doc and broadcast to editors.
				const update = setNoteText(id, next);
				if (update.length)
					broadcastToNote(id, {
						type: "note_update",
						noteId: id,
						update: b64encode(update),
					});
				return Response.json({ ok: true });
			}

			// ── Wiki ──
			if (path === "/backstage/api/wiki/tree" && req.method === "GET") {
				return Response.json(getWikiTree());
			}

			if (path === "/backstage/api/wiki/file" && req.method === "GET") {
				const rel = url.searchParams.get("path") || "";
				const file = getWikiFile(rel);
				if (!file)
					return Response.json({ error: "Not found" }, { status: 404 });
				return Response.json(file);
			}

			if (path === "/backstage/api/wiki/search" && req.method === "GET") {
				const q = url.searchParams.get("q") || "";
				return Response.json(searchWiki(q));
			}

			// WebSocket upgrade
			if (path === "/backstage/ws") {
				const upgraded = server.upgrade(req, {
					data: { watchingSessionId: null, watchingNoteId: null, user: null },
				});
				if (!upgraded) {
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				return undefined;
			}

			// Sandbox WS transport (Phase 3): run hosts + MCP proxies inside
			// sandboxes dial back here instead of sharing unix sockets. Token-
			// authed per run BEFORE the upgrade — see src/server/run-ws.ts.
			if (path.startsWith("/backstage/run-ws/") || path === "/backstage/rpc-ws") {
				return handleSandboxWsUpgrade(req, server, path);
			}

			// SPA fallback: any unmatched GET under /backstage/ that isn't an API
			// path serves the app shell, so client-side routes deep-link correctly
			// even when they're missing from the explicit `routes` map above (which
			// has silently 404'd every newly added view — settings, actions — until
			// someone remembered to register it).
			if (
				frontend &&
				(req.method === "GET" || req.method === "HEAD") &&
				path.startsWith("/backstage/") &&
				!path.startsWith("/backstage/api/")
			) {
				return new Response(frontend.indexHtml, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			// 404
			return Response.json({ error: "Not found" }, { status: 404 });
		},

		websocket: {
			// Default is 16 MB — too small for a base64'd attachment near MAX_UPLOAD_BYTES,
			// which would otherwise drop the frame (close 1009) before staging. See above.
			maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
			open(ws) {
				// Sandbox transport sockets (run hosts / MCP proxies dialing back)
				// are not UI clients — run-ws.ts owns them entirely.
				if (sandboxWsOpen(ws)) return;
				allClients.add(ws);
				console.log("WebSocket client connected");
			},

			async message(ws, message) {
				if (sandboxWsMessage(ws, message as any)) return;
				let msg: any;
				try {
					msg = JSON.parse(String(message));
				} catch {
					ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
					return;
				}

				switch (msg.type) {
					case "ping": {
						// App-level liveness probe (browsers can't send WS protocol pings).
						// The client closes + reconnects a socket whose ping goes unanswered
						// — how a half-open iOS/Safari socket gets detected.
						ws.send('{"type":"pong"}');
						break;
					}

					case "watch": {
						const sessionId = msg.sessionId;
						const session = findSession(sessionId);
						if (!session) {
							ws.send(
								JSON.stringify({ type: "error", message: "Session not found" }),
							);
							return;
						}

						// Stop watching any previous session first
						stopAllWatchesForClient(ws);
						leaveSession(ws);

						const data = ws.data;
						data.watchingSessionId = sessionId;
						if (msg.user) data.user = msg.user;
						joinSession(ws, sessionId);

						// Send the tail of the transcript for a fast initial render. A large
						// (multi-MB) transcript would otherwise block the open for seconds;
						// `truncated` tells the client to offer "load earlier history", which
						// comes back as a `load_history` message below.
						const { entries, truncated, endOffset } = session.transcriptPath
							? parseTranscriptTail(session.transcriptPath)
							: { entries: [], truncated: false, endOffset: 0 };
						ws.send(
							JSON.stringify({
								type: "transcript_init",
								sessionId,
								entries,
								truncated,
							}),
						);

						// Start file watcher from where the tail parse left off — bytes
						// appended between the parse and the watch would otherwise be lost.
						if (session.transcriptPath) {
							startWatching(session.transcriptPath, ws, endOffset, sessionId);
						}

						// Pending interactive question, if any
						const pendingAsk = pendingAsks.get(sessionId);
						if (pendingAsk) {
							ws.send(
								JSON.stringify({
									type: "ask_question",
									sessionId,
									questionId: pendingAsk.questionId,
									questions: pendingAsk.questions,
								}),
							);
						}

						// Current message queue + steer receipts for this session. Older
						// in-memory rows may lack ids; assign and persist them before
						// sending so edit/delete/steer actions can address the same row.
						const queuedPrompts = queueWithIds(promptQueues.get(sessionId));
						const steeredPrompts = queueWithIds(steeredReceipts.get(sessionId));
						if (queuedPrompts.length > 0) promptQueues.set(sessionId, queuedPrompts);
						if (steeredPrompts.length > 0) steeredReceipts.set(sessionId, steeredPrompts);
						if (queuedPrompts.length > 0 || steeredPrompts.length > 0) persistQueues();
						ws.send(
							JSON.stringify({
								type: "queue_update",
								sessionId,
								queued: queuedPrompts,
								steered: steeredPrompts,
							}),
						);

						// Send running status
						ws.send(
							JSON.stringify({
								type: "session_status",
								sessionId,
								isRunning:
									session.isRunning ||
									isAgentSessionBusy(
										session.claudeSessionId,
										session.codexThreadId,
										session.id,
									),
							}),
						);
						break;
					}

					case "unwatch": {
						// Viewer navigated away from the session (not just to another one):
						// stop streaming transcript events and clear their ghost presence.
						// Mirrors the disconnect/close cleanup; leaveSession broadcasts
						// presence to the viewers who remain.
						stopAllWatchesForClient(ws);
						leaveSession(ws);
						break;
					}

					case "load_history": {
						// "Load earlier history" button: the initial watch only sent the tail,
						// so re-send the full transcript (cached by mtime in jsonl-parser).
						const session = findSession(msg.sessionId);
						if (!session?.transcriptPath) {
							ws.send(
								JSON.stringify({
									type: "transcript_init",
									sessionId: msg.sessionId,
									entries: [],
									truncated: false,
								}),
							);
							return;
						}
						const entries = parseTranscript(session.transcriptPath);
						ws.send(
							JSON.stringify({
								type: "transcript_init",
								sessionId: msg.sessionId,
								entries,
								truncated: false,
							}),
						);
						break;
					}

					case "prompt": {
						const { sessionId, content, user } = msg;
						const images = parseImageDataUrls(msg.images);
						const imageUrls = asDataUrlList(msg.images);
						const session = findSession(sessionId);
						if (!session) {
							ws.send(
								JSON.stringify({ type: "error", message: "Session not found" }),
							);
							return;
						}

						// The composer's effort pill rides every send; persist a change so
						// this and future runs (queue drains, resumes) honor it.
						maybePersistEffort(session, msg.effort);

						// Slash commands are handled by backstage itself
						const notice = handleSlashCommand(
							session,
							String(content || "").trim(),
							user,
						);
						if (notice !== null) {
							ws.send(JSON.stringify({ type: "notice", message: notice }));
							sessionsCache = null;
							break;
						}

						// Busy sends queue by default, so the user can still delete/edit or
						// manually steer the message. Settings can opt the composer into
						// steer-by-default (`busyMode: "steer"`), delivered at the next turn
						// boundary and falling back to queue when the run isn't steerable.
						if (
							isAgentSessionBusy(
								session.claudeSessionId,
								session.codexThreadId,
								session.id,
							)
						) {
							if (msg.busyMode === "queue") {
								enqueuePrompt(sessionId, {
									content,
									user,
									images: imageUrls,
									files: msg.files,
								});
								watchExternalRunAndDrain(sessionId);
								break;
							}
							const attributed = user ? `[${user}] ${content}` : content;
							// Images fold into the live run as content blocks; disk-staged
							// files can't ride the steer channel, so a send carrying files
							// falls through to the queue (its drain delivers images + files
							// together at the run's next idle point).
							const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
							if (
								msg.busyMode === "steer" &&
								!hasFiles &&
								steerAgentRun(
									[session.claudeSessionId, session.codexThreadId, session.id],
									attributed,
									images,
								)
							) {
								// The message lands in the transcript when its turn starts. Until
								// then a steer receipt is the durable visible record (survives
								// reload/leave); kept out of promptQueues so the drain never
								// re-delivers it, and cleared when the run finishes.
								recordSteer(sessionId, { content, user, images: imageUrls });
								broadcastToSession(sessionId, {
									type: "notice",
									message: `Message from ${user || "you"} folded into the run — Michael picks it up at the next stopping point.`,
								});
								break;
							}
							enqueuePrompt(sessionId, {
								content,
								user,
								images: imageUrls,
								files: msg.files,
							});
							watchExternalRunAndDrain(sessionId);
							break;
						}

						// Codex sessions start a fresh thread on first prompt. Backstage
						// chats with no engine id are *fresh* chats (a new sibling from the
						// tab strip's +): runSessionPrompt starts a new conversation. Only
						// non-backstage sources genuinely need an id to resume.
						if (
							providerFor(session.model) === "claude" &&
							!session.claudeSessionId &&
							session.source !== "backstage"
						) {
							ws.send(
								JSON.stringify({
									type: "error",
									message: "No Claude session to resume",
								}),
							);
							return;
						}

						// Sibling-chat transcripts attached via the fresh-chat chips.
						const contextChats = Array.isArray(msg.contextChats)
							? msg.contextChats.filter(
									(id: unknown): id is string => typeof id === "string",
								)
							: undefined;
						await runSessionPromptAndDrain(
							sessionId,
							content,
							user,
							images,
							msg.files,
							contextChats,
						);
						break;
					}

					case "interrupt_prompt": {
						// Esc-style redirect: stop the current turn, keep the session, and
						// continue right away with this message. Falls back to a normal
						// prompt (steer/queue/run) when there's nothing to interrupt.
						const { sessionId, content, user } = msg;
						const images = parseImageDataUrls(msg.images);
						const imageUrls = asDataUrlList(msg.images);
						const session = findSession(sessionId);
						if (!session) {
							ws.send(
								JSON.stringify({ type: "error", message: "Session not found" }),
							);
							return;
						}
						maybePersistEffort(session, msg.effort);
						const attributed = user ? `[${user}] ${content}` : content;
						// Files can't ride the interrupt/steer content-block channel — a send
						// carrying files falls through to the queue (drain delivers images +
						// files together), so it isn't interrupted here.
						const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
						if (
							!hasFiles &&
							isAgentSessionBusy(
								session.claudeSessionId,
								session.codexThreadId,
								session.id,
							) &&
							interruptAndSteerAgentRun(
								[session.claudeSessionId, session.codexThreadId, session.id],
								attributed,
								images,
							)
						) {
							// Interrupt aborts the current turn and continues immediately, so
							// the message lands in the transcript almost at once — no steer
							// receipt ("folded in" would be wrong for an interrupt) and no system
							// notice. The sender's optimistic bubble reconciles when its real
							// turn appears; the SDK's "[Request interrupted by user]" marker is
							// filtered out in jsonl-parser.
							break;
						}
						// Not interruptible (external run, codex, has files, or just
						// finished): treat like a normal send so nothing — text or
						// attachment — is lost.
						if (
							isAgentSessionBusy(
								session.claudeSessionId,
								session.codexThreadId,
								session.id,
							)
						) {
							enqueuePrompt(sessionId, {
								content,
								user,
								images: imageUrls,
								files: msg.files,
							});
							watchExternalRunAndDrain(sessionId);
							break;
						}
						await runSessionPromptAndDrain(
							sessionId,
							content,
							user,
							images,
							msg.files,
						);
						break;
					}

					case "delete_queued_prompt": {
						const { sessionId, queueId, queueIndex } = msg;
						deleteQueuedPrompt(sessionId, queueId, queueIndex);
						break;
					}

					case "update_queued_prompt": {
						const { sessionId, queueId, queueIndex, content } = msg;
						const next = String(content || "").trim();
						if (!next) {
							deleteQueuedPrompt(sessionId, queueId, queueIndex);
						} else {
							updateQueuedPrompt(sessionId, queueId, queueIndex, next);
						}
						break;
					}

					case "steer_queued_prompt": {
						const { sessionId, queueId, queueIndex } = msg;
						if (!steerQueuedPrompt(sessionId, queueId, queueIndex)) {
							ws.send(
								JSON.stringify({
									type: "notice",
									sessionId,
									message:
										"Could not steer that queued message right now. It is still queued.",
								}),
							);
						}
						break;
					}

					case "interrupt_queued_prompt": {
						const { sessionId, queueId, queueIndex } = msg;
						if (!interruptQueuedPrompt(sessionId, queueId, queueIndex)) {
							ws.send(
								JSON.stringify({
									type: "notice",
									sessionId,
									message:
										"Could not interrupt with that message right now. It is still queued.",
								}),
							);
						}
						break;
					}

					case "reorder_queued_prompt": {
						const { sessionId, order } = msg;
						if (Array.isArray(order) && order.every((x) => typeof x === "string")) {
							reorderQueuedPrompt(sessionId, order);
						}
						break;
					}

					case "cancel": {
						const data = ws.data;
						if (data.watchingSessionId) {
							const sessionId = data.watchingSessionId;
							const session = findSession(sessionId);
							// Park the queue until the user's next explicit action —
							// otherwise the drain would deliver the requeued steers into a
							// fresh run the moment the stopped one winds down.
							stoppedSessions.add(sessionId);
							if (session) {
								// Esc-style: gracefully interrupt the current turn (the run
								// winds down at the forced boundary with a clean transcript).
								// Hard cancel only for runs with no interrupt support (codex,
								// external processes); the full kill lives on session delete.
								const stopped = stopAgentRunTurn([
									session.claudeSessionId,
									session.codexThreadId,
									session.id,
								]);
								if (!stopped) {
									cancelAgentRun(
										session.claudeSessionId,
										session.codexThreadId,
										session.id,
									);
								}
							}
							const requeued = requeueSteerReceipts(sessionId);
							if (requeued > 0) {
								broadcastToSession(sessionId, {
									type: "notice",
									message: `Stopped — ${requeued} steered message${requeued === 1 ? "" : "s"} returned to the queue.`,
								});
							}
						}
						break;
					}

					case "answer_question": {
						const { sessionId, questionId, answers } = msg;
						const pending = pendingAsks.get(sessionId);
						if (pending && pending.questionId === questionId) {
							pending.resolve(
								answers && typeof answers === "object" ? answers : null,
							);
						}
						break;
					}

					// ── Interactive shell (Shell tab) — one PTY per socket ──
					case "term_start": {
						const session = findSession(msg.sessionId);
						const cwd =
							session?.worktreeDir && existsSync(session.worktreeDir)
								? session.worktreeDir
								: HOME;
						startTerminal(ws, {
							cwd,
							cols: Number(msg.cols) || undefined,
							rows: Number(msg.rows) || undefined,
							send: (m) => {
								try {
									ws.send(JSON.stringify(m));
								} catch {}
							},
						});
						break;
					}
					case "term_input": {
						if (typeof msg.data === "string") writeTerminal(ws, msg.data);
						break;
					}
					case "term_resize": {
						resizeTerminal(ws, Number(msg.cols), Number(msg.rows));
						break;
					}
					case "term_stop": {
						stopTerminal(ws);
						break;
					}

					case "create_session": {
						const { branch, prompt, user, mode } = msg;
						const images = parseImageDataUrls(msg.images);
						// Session opened from a PR row (sidebar): `branch` is the PR's
						// EXISTING head branch — check it out instead of creating a new
						// branch off origin/default.
						const fromPr =
							msg.fromPr === true && typeof branch === "string" && !!branch;

						// Fork: branch a new session off an existing one. Claude can clone the
						// real engine conversation via SDK forkSession; backends without clone
						// support get a transcript handoff in the opening prompt instead.
						const forkFrom = msg.forkFrom as
							| { sourceId?: string; messageId?: string }
							| undefined;
						const forkSource = forkFrom?.sourceId
							? findSession(forkFrom.sourceId)
							: undefined;
						if (forkFrom?.sourceId && !forkSource) {
							ws.send(
								JSON.stringify({
									type: "error",
									message: "Fork source session not found",
								}),
							);
							return;
						}
						const canFork =
							!!forkSource &&
							providerFor(forkSource.model) === "claude" &&
							!!forkSource.claudeSessionId;
						const needsForkHandoff = !!forkSource && !canFork;

						const isAsk = forkSource
							? forkSource.mode !== "code"
							: mode === "ask";
						// Optional model pick from the UI; invalid input falls back to default.
						// A fork inherits the source's model.
						const model = forkSource
							? forkSource.model
							: msg.model
								? resolveModel(String(msg.model))?.id
								: undefined;
						// Reasoning effort from the New-session palette (forks inherit).
						const createEffort = forkSource
							? forkSource.effort
							: typeof msg.effort === "string" &&
									SESSION_EFFORTS.has(msg.effort.trim().toLowerCase())
								? msg.effort.trim().toLowerCase()
								: undefined;
						const createMcpServers = Array.isArray(msg.mcpServers)
							? msg.mcpServers.map(String)
							: undefined;
						// Sandbox opt-in (docs/sandboxes-plan.md Phase 0): recorded on the
						// session file only — nothing acts on it until a real provider
						// ships, and the effective provider is "local" until configured.
						const createSandbox = msg.sandbox === true;
						// Which repo this session works in (tella-fusion by default).
						const repo = getRepo(
							typeof msg.repo === "string" ? msg.repo : undefined,
						);
						// Workspace linkage. The New modal creates a Workspace + first Chat
						// together (createWorkspace); the tab/sidebar + adds a Chat to an
						// existing workspace (workspaceId) that either shares the workspace's
						// worktree (default) or stacks a new one branched off it.
						const chatMode: "share" | "stack" | "ask" = isAsk
							? "ask"
							: msg.chatMode === "stack"
								? "stack"
								: "share";
						let workspace =
							typeof msg.workspaceId === "string" && msg.workspaceId
								? getWorkspace(msg.workspaceId)
								: null;
						// Whether this create made a brand-new workspace (vs. adding a chat
						// to an existing one) — echoed on session_created so the client can
						// word its brief pending state accordingly.
						let createdWorkspaceNow = false;
						if (!workspace && msg.createWorkspace) {
							// A code create landing on a branch whose worktree an existing
							// workspace already owns joins that workspace (the worktree
							// lookup below would silently reuse the worktree anyway —
							// re-submitted prompt slugs and existing branches picked in the
							// unscoped palette both hit this). Only then mint a fresh one.
							if (!isAsk && !forkSource && !fromPr && !repo.sharedCheckout && branch) {
								const existingWt = (await listWorktrees(repo.id)).find(
									(w) => w.branch === branch,
								)?.path;
								workspace = workspaceOwningWorktree(existingWt);
							}
							if (!workspace) {
								createdWorkspaceNow = true;
								workspace = createWorkspace({
									name:
										(typeof msg.createWorkspace.name === "string" &&
											msg.createWorkspace.name) ||
										prompt.trim().split("\n")[0].slice(0, 80) ||
										"Workspace",
									repo: repo.id,
									createdBy: user || "Anonymous",
								});
							}
						}
						// Set once the session has been announced to the client (early
						// session_created) — a later failure must then close out the
						// stream instead of leaving the just-opened viewer spinning.
						let announcedId: string | null = null;

						// One outlet for this run's stream events (usable only after the
						// announce sets announcedId). Everything is stamped with sessionId
						// so clients can filter, and the creator's direct send is GATED on
						// what their socket currently watches: it only covers the gap
						// between session_created and their watch landing. Once they watch
						// this session, the room broadcast reaches them; once they've
						// navigated to a DIFFERENT session, they get nothing — the old
						// unconditional ws.send kept streaming this run into whatever chat
						// that socket had open (until a refresh replaced the socket).
						const emit = (m: Record<string, unknown>) => {
							if (!announcedId) return;
							const scoped = { ...m, sessionId: announcedId };
							const watching = ws.data?.watchingSessionId;
							if (!watching) {
								try {
									ws.send(JSON.stringify(scoped));
								} catch {}
							}
							broadcastToSession(announcedId, scoped, watching ? undefined : ws);
						};
						try {
							let wtPath: string;
							// Deferred worktree setup: the git fetch + worktree add +
							// bun install can take tens of seconds, so the session is
							// announced on the deterministic path first and the worktree
							// is created after session_created goes out (below).
							let needsWorktree = false;
							// Volume-mode sandbox workspace (Phase 2): no host worktree at
							// all - the sandbox provider clones it in-container on the
							// opening run below.
							let volumeWorkspace = false;
							if (forkSource) {
								// Share the source's cwd so the fork sees the same code state.
								wtPath = forkSource.worktreeDir || repo.repo;
							} else if (fromPr) {
								// From a PR row: work on the PR's existing head branch in an
								// isolated worktree (even for shared-checkout repos and ask
								// mode — the PR's code is the subject, and a PR branch must
								// never check out in the live main checkout). Reuses a
								// worktree already on that branch.
								const worktrees = await listWorktrees(repo.id);
								wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
								if (!wtPath) {
									wtPath = worktreePathFor(branch, repo.id, { isolated: true });
									needsWorktree = true;
								}
							} else if (isAsk) {
								// Ask sessions run read-only on the main checkout — no worktree
								wtPath = repo.repo;
							} else if (repo.sharedCheckout) {
								// Backstage: code sessions edit the live main checkout on the
								// default branch (hot-reloads in the running server). No worktree.
								wtPath = repo.repo;
							} else if (workspace?.worktreeDir && chatMode === "share") {
								// Share the workspace's owned worktree (parallel chats, one branch).
								wtPath = workspace.worktreeDir;
							} else {
								// New/stacked worktree. Stack branches off the workspace's branch
								// so stacked PRs line up; otherwise branch off origin/default.
								const worktrees = await listWorktrees(repo.id);
								wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
								if (!wtPath) {
									wtPath = worktreePathFor(branch, repo.id);
									// Volume-mode sandbox (docs/sandboxes-plan.md Phase 2): the
									// workspace is cloned into a per-session volume INSIDE the
									// container — skip host createWorktree entirely. The session
									// keeps the canonical path; DockerProvider.ensure
									// materializes it on the opening run below.
									if (
										createSandbox &&
										sandboxesEnabled() &&
										effectiveSandboxProvider(repo.id) === "docker" &&
										sandboxConfig().workspace === "volume"
									) {
										volumeWorkspace = true;
									} else {
										needsWorktree = true;
									}
								}
							}
							// First code chat materializes the workspace's owned worktree so
							// later share-mode chats inherit it. Stacked chats keep their own —
							// except a "stack" in a workspace with no branch yet, which has no
							// base to stack on and is really the workspace's first worktree.
							if (
								workspace &&
								!workspace.worktreeDir &&
								!isAsk &&
								!repo.sharedCheckout &&
								(chatMode !== "stack" || !workspace.branch)
							) {
								updateWorkspace(workspace.id, {
									worktreeDir: wtPath,
									...(branch ? { branch } : {}),
								});
								workspace = { ...workspace, worktreeDir: wtPath, branch };
							}
							// The branch this session actually works on (also persisted below).
							const sessionBranch = forkSource
								? forkSource.branch || ""
								: fromPr
									? branch
									: isAsk
										? ""
										: repo.sharedCheckout
											? repo.defaultBranch
											: workspace?.worktreeDir === wtPath
												? workspace.branch || branch
												: branch;

							const bksId = `bks-${randomUUIDv7()}`;
							const title = prompt.trim().split("\n")[0].slice(0, 80);
							// Replace the raw first-line title with a short summary in the
							// background; next sessions poll (≤5s) picks it up. An
							// auto-created workspace is named ONCE from the same generated
							// summary (it provisionally wore the raw first line) and keeps
							// that name for life — later chats never rename it.
							// Only a workspace minted by THIS create gets auto-named — an
							// adopted pre-existing workspace keeps its own name.
							const wsAutoNamed =
								createdWorkspaceNow &&
								!!workspace &&
								!!msg.createWorkspace &&
								!msg.createWorkspace.name;
							const wsToName = workspace;
							void ensureGeneratedTitle(bksId, prompt, user, model).then((t) => {
								if (!t) return;
								sessionsCache = null;
								if (wsAutoNamed && wsToName) {
									const cur = getWorkspace(wsToName.id);
									// Only while it still wears the provisional name — a manual
									// rename in the meantime wins.
									if (cur && cur.name === wsToName.name)
										updateWorkspace(wsToName.id, { name: t });
								}
							});
							// Non-image attachments: stage to disk, hand the agent the paths.
							let openingPrompt = withUploadsNote(
								prompt,
								stageFileAttachments(bksId, msg.files),
							);
							// @session:<id> mentions from the New-session box get the same
							// resolving footer as prompts on existing chats (see
							// runSessionPromptInner) — this create path bypasses it.
							{
								const mentionsNote = sessionMentionsNote(openingPrompt);
								if (mentionsNote) openingPrompt += `\n\n${mentionsNote}`;
							}
							// Session opened from the Support view: link it to its Plain
							// thread (right-sidebar conversation tab + the sidebar's
							// ticket→session mapping) and hand the agent the ticket
							// conversation so the first message is self-contained.
							const plainThreadId =
								typeof msg.plainThreadId === "string" && msg.plainThreadId
									? msg.plainThreadId
									: undefined;
							if (plainThreadId) {
								try {
									const { getThreadWithMessages, formatThreadContext } =
										await import("./src/agents/plain/api");
									const thread = await getThreadWithMessages(plainThreadId);
									openingPrompt += `\n\n${wrapContext(
										`This chat was opened from a Plain support ticket. Ticket context:\n\n${formatThreadContext(thread, true)}`,
									)}`;
								} catch (e) {
									console.error(
										`[create_session] Plain thread lookup failed for ${plainThreadId}:`,
										e,
									);
									openingPrompt += `\n\n${wrapContext(
										`This chat was opened from Plain support ticket ${plainThreadId} (the context lookup failed — use the plain MCP tools to fetch the thread).`,
									)}`;
								}
							}
							if (needsForkHandoff && forkSource) {
								const entries = forkSource.transcriptPath
									? parseTranscript(forkSource.transcriptPath)
									: [];
								openingPrompt += `\n\n${wrapContext(
									buildForkHandoffNote({
										sourceId: forkSource.id,
										sourceTitle: forkSource.title,
										sourceModel: forkSource.model,
										messageId: forkFrom?.messageId,
										entries,
									}),
								)}`;
							}

							let engineSessionId = "";
							let effectiveModel = model;
							let effectiveProvider = providerFor(effectiveModel);
							const modelHistory: NonNullable<
								BackstageSessionFile["modelHistory"]
							> = [];
							let persisted = false;
							// Cumulative token/cost for this new session's opening run.
							let latestUsage: SessionUsage | undefined;
							// Terminal failure the opening run died on — recorded after the
							// loop so the fresh session surfaces as "Needs input".
							let runFailure: string | null = null;
							const persist = () => {
								const sessionData: BackstageSessionFile = {
									id: bksId,
									claudeSessionId: "",
									...(engineSessionId
										? engineSessionPatch(effectiveProvider, engineSessionId)
										: {}),
									// Record the engine that ran so the first later cross-provider
									// switch bridges context (see runSessionPromptInner handoff).
									...(engineSessionId
										? { lastEngineProvider: effectiveProvider }
										: {}),
									...(effectiveModel ? { model: effectiveModel } : {}),
									...(createEffort ? { effort: createEffort } : {}),
									...(modelHistory.length ? { modelHistory } : {}),
									branch: sessionBranch,
									worktreeDir: wtPath,
									repo: repoForPath(wtPath).id,
									...(workspace
										? { projectId: workspace.id }
										: forkSource?.projectId
											? // A fork lands next to its source in the same workspace.
												{ projectId: forkSource.projectId }
											: typeof msg.projectId === "string" && msg.projectId
												? { projectId: msg.projectId }
												: {}),
									createdBy: user || "Anonymous",
									createdAt: new Date().toISOString(),
									lastActivity: new Date().toISOString(),
									title,
									mode: isAsk ? "ask" : "code",
									...(plainThreadId ? { plainThreadId } : {}),
									...(createMcpServers && createMcpServers.length ? { mcpServers: createMcpServers } : {}),
									...(createSandbox
										? {
												sandbox: {
													provider: effectiveSandboxProvider(repo.id),
													// Volume intent is recorded up front so the prompt
													// paths know the workspace never exists host-side
													// (hasRemoteWorkspace) even before the first ensure.
													...(volumeWorkspace
														? { workspace: "volume" as const }
														: {}),
												},
											}
										: {}),
								};
								writeJsonAtomic(
									`${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`,
									sessionData,
								);
								sessionsCache = null;
								persisted = true;
							};

							// Persist + announce BEFORE the slow parts (worktree git work,
							// engine boot with its MCP connects) so the client drops into
							// the empty chat immediately — the title fills in from the
							// background summary and the opening turn streams in when the
							// engine is up. The starting mark keeps a prompt typed in that
							// window from double-starting a run (same race as
							// runSessionPrompt).
							markSessionStarting(bksId);
							if (needsWorktree) preparingWorkspaces.add(bksId);
							try {
								persist();
								ws.send(
									JSON.stringify({
										type: "session_created",
										id: bksId,
										...(workspace ? { workspaceId: workspace.id } : {}),
										...(createdWorkspaceNow ? { newWorkspace: true } : {}),
										...(needsWorktree ? { preparingWorkspace: true } : {}),
									}),
								);
								announcedId = bksId;
								emit({ type: "stream_start" });

								if (needsWorktree) {
									try {
										if (fromPr) {
											await createWorktreeForExistingBranch(branch, repo.id);
										} else {
											const base =
												chatMode === "stack" && workspace?.branch
													? workspace.branch
													: undefined;
											await createWorktree(
												branch,
												repo.id,
												base ? { base } : undefined,
											);
										}
									} finally {
										// Ready (or failed — the error surfaces separately): flip the
										// viewer out of "Waiting for workspace" and let the queue go.
										preparingWorkspaces.delete(bksId);
										emit({ type: "workspace_status", ready: true });
									}
								}

							// Volume-mode sandbox session: the workspace exists only inside
							// the container, so the opening turn MUST run there - route it
							// through the same sandbox launcher the prompt path uses (the
							// session file was persisted above, so it resolves). No host
							// fallback is possible for a workspace with no host dir: a
							// failed launch errors the stream (announcedId is set, so the
							// catch below closes it out). Bind-mode sandbox sessions keep
							// Phase 1 behavior - first turn on the host worktree, sandboxed
							// from the second prompt on.
							let volumeSandboxRun: AsyncGenerator<StreamEvent> | null = null;
							if (volumeWorkspace) {
								const created = findSession(bksId);
								volumeSandboxRun = created
									? await maybeLaunchSandboxedRun(created, {
											prompt: openingPrompt,
											cwd: wtPath,
											user,
											images,
											mcpServers: createMcpServers ?? [],
											isAutomationSession: false,
										})
									: null;
								if (!volumeSandboxRun) {
									throw new Error(
										"Sandbox unavailable for this volume-workspace session - the opening prompt was not run. Check sandbox config/kill-switch and retry.",
									);
								}
							}

							for await (const event of volumeSandboxRun ?? runAgent({
								prompt: openingPrompt,
								cwd: wtPath,
								mode: isAsk ? "ask" : "code",
								model,
								effort: createEffort,
								fallbackModel: interactiveFallbackModel(model),
								mcpServers: createMcpServers,
								reposNote: buildBranchNote({
									mode: isAsk ? "ask" : "code",
									branch: sessionBranch,
									worktreeDir: wtPath,
								}),
								images,
								// Fork: resume the source engine session into a new branch,
								// optionally from a specific past message.
								...(canFork
									? {
											sessionId: forkSource!.claudeSessionId!,
											forkSession: true,
											resumeSessionAt: forkFrom?.messageId,
										}
									: {}),
								inProcessMcp: interactiveMcpServers(user, bksId),
								confirmTools: STRIPE_CONFIRM_TOOLS,
								aws: true, // interactive sessions keep AWS read access (via injected creds)
								user, // gate per-user MCP servers (allowedUsers) to the creator
								journal: { bksSessionId: bksId, kind: "create" },
								onAskUser: makeAskHandler(bksId),
							})) {
								if (event.type === "init") {
									engineSessionId = event.sessionId || "";
									if (event.provider) effectiveProvider = event.provider;
									if (event.model) effectiveModel = event.model;
									// Session was persisted/announced before setup — just record
									// the engine id so the run is resumable while it streams.
									touchBackstageSession(
										bksId,
										{
											...engineSessionPatch(
												effectiveProvider,
												engineSessionId,
											),
											...(engineSessionId
												? { lastEngineProvider: effectiveProvider }
												: {}),
											...(effectiveModel ? { model: effectiveModel } : {}),
										},
									);
									// The transcript file didn't exist when viewers sent their
									// watch (fresh chat) — attach them now so this first turn
									// streams live instead of only appearing after a re-watch.
									if (engineSessionId) {
										attachSessionWatchersToEngineTranscript(
											bksId,
											effectiveProvider,
											wtPath,
											engineSessionId,
										);
									}
								}
								if (event.type === "model_switch") {
									const to = event.toModel || "";
									const reason = `auto-switch — ${modelLabel(event.fromModel)} out of credits`;
									if (to) {
										effectiveModel = to;
										effectiveProvider = providerFor(to);
										modelHistory.push({
											model: to,
											from: event.fromModel,
											at: new Date().toISOString(),
											by: reason,
										});
										touchBackstageSession(bksId, {
											model: to,
											modelHistory,
										});
										emit({
											type: "model_changed",
											model: to,
											from: event.fromModel,
											by: reason,
										});
									}
								}
								if (event.type === "text_chunk") {
									emit({ type: "stream_text", text: event.text });
								}
								if (event.type === "tool_use") {
									const entry = {
										id: event.toolUseId || crypto.randomUUID(),
										type: "tool_use" as const,
										content: `Using ${event.toolName}`,
										timestamp: new Date().toISOString(),
										toolName: event.toolName,
										toolInput: event.toolInput,
										toolUseId: event.toolUseId,
									};
									emit({ type: "stream_tool_use", entry });
								}
								if (event.type === "tool_result") {
									const entry = {
										id: event.toolUseId
											? `tr-${event.toolUseId}`
											: crypto.randomUUID(),
										type: "tool_result" as const,
										content: event.content || "",
										timestamp: new Date().toISOString(),
										toolUseId: event.toolUseId,
										...(event.images && event.images.length > 0
											? { images: event.images }
											: {}),
										...(event.videos && event.videos.length > 0
											? { videos: event.videos }
											: {}),
									};
									emit({ type: "stream_tool_result", entry });
								}
								if (event.type === "usage_snapshot" && event.usage) {
									// Live mid-run cost/context. Snapshots are run-cumulative and
									// this is the session's only run, so the fold base is empty —
									// each snapshot recomputes the total from scratch (folding
									// onto latestUsage would double-count).
									latestUsage = foldSessionUsage(
										undefined,
										event.usage,
										effectiveModel,
									);
									emit({ type: "usage_update", usage: latestUsage });
								}
								if (event.type === "done") {
									engineSessionId = event.sessionId || engineSessionId;
									if (event.provider) effectiveProvider = event.provider;
									if (event.model) effectiveModel = event.model;
									if (event.usageLimitExhausted)
										runFailure =
											event.result || "Usage limit reached on every account";
									if (event.usage) {
										latestUsage = foldSessionUsage(
											undefined,
											event.usage,
											event.model || effectiveModel,
										);
										// emit (not a bare broadcast) so it also reaches the
										// creator's socket in the window before they watch.
										emit({ type: "usage_update", usage: latestUsage });
									}
								}
								if (event.type === "error") {
									runFailure = event.content || "Run failed";
									emit({ type: "error", message: event.content });
								}
							}

							if (!persisted) persist();
							else
								touchBackstageSession(
									bksId,
									{
										...engineSessionPatch(
											effectiveProvider,
											engineSessionId,
										),
										...(engineSessionId
											? { lastEngineProvider: effectiveProvider }
											: {}),
										...(effectiveModel ? { model: effectiveModel } : {}),
										...(modelHistory.length ? { modelHistory } : {}),
									},
								);
								// Persist opening-run usage regardless of which branch ran
								// above (persist() writes the base file without it).
								if (latestUsage)
									touchBackstageSession(bksId, { usage: latestUsage });
							recordRunOutcome(bksId, runFailure);
							} finally {
								unmarkSessionStarting(bksId);
								// Safety net for throws before the worktree block's own finally
								// (persist/announce failures) — must never leak a session stuck
								// in "Waiting for workspace".
								preparingWorkspaces.delete(bksId);
							}

							emit({ type: "stream_done" });
							emit({ type: "session_status", isRunning: false });
							if (promptQueues.get(bksId)?.length)
								await drainQueue(bksId);
							else
								onHumanAsksSessionIdle(bksId);
						} catch (e: any) {
							// Failure after the early session_created: the client is already
							// in the session — close out the stream and surface the failure
							// there instead of leaving the viewer spinning. Before the
							// announce there's no session to scope to, so the raw error goes
							// straight back to the sender.
							if (announcedId) {
								emit({ type: "error", message: e.message || String(e) });
								emit({ type: "stream_done" });
								emit({
									type: "notice",
									message: `Session setup failed: ${e.message || String(e)}`,
								});
								emit({ type: "session_status", isRunning: false });
							} else {
								ws.send(
									JSON.stringify({
										type: "error",
										message: e.message || String(e),
									}),
								);
							}
						}
						break;
					}
					// ── Collaborative notes (Yjs over the shared socket) ──
					case "watch_note": {
						const noteId = msg.noteId;
						if (!isValidNoteId(noteId)) {
							ws.send(
								JSON.stringify({ type: "error", message: "Invalid note id" }),
							);
							return;
						}
						// Leave any previously-watched note first (one note per client).
						leaveNote(ws);
						if (msg.user) ws.data.user = msg.user;
						ws.data.watchingNoteId = noteId;
						joinNote(ws, noteId);
						// Send the full current doc state so the client syncs immediately.
						ws.send(
							JSON.stringify({
								type: "note_state",
								noteId,
								update: b64encode(getNoteState(noteId)),
							}),
						);
						break;
					}

					case "leave_note": {
						leaveNote(ws);
						break;
					}

					case "note_update": {
						const noteId = msg.noteId;
						if (!isValidNoteId(noteId) || typeof msg.update !== "string")
							return;
						try {
							applyNoteUpdate(noteId, b64decode(msg.update));
						} catch {}
						// Relay to the other editors of this note.
						broadcastToNote(
							noteId,
							{ type: "note_update", noteId, update: msg.update },
							ws,
						);
						break;
					}

					case "note_awareness": {
						const noteId = msg.noteId;
						if (!isValidNoteId(noteId) || typeof msg.update !== "string")
							return;
						// Cursors/presence are ephemeral — relay only, never persist.
						broadcastToNote(
							noteId,
							{ type: "note_awareness", noteId, update: msg.update },
							ws,
						);
						break;
					}

					// ── Team chat: typing indicator (ephemeral — relay only, never
					// persisted; mirrors note_awareness). Fanned out to every client
					// except the typist; only chat views on this channel render it. ──
					case "chat_typing": {
						const typer =
							typeof msg.user === "string" && msg.user.trim()
								? msg.user.trim()
								: ws.data?.user;
						const channel =
							typeof msg.channel === "string" ? msg.channel : "watercooler";
						if (!typer) return;
						const payload = JSON.stringify({
							type: "chat_typing",
							channel,
							user: typer,
						});
						for (const client of allClients) {
							if (client === ws) continue;
							try {
								client.send(payload);
							} catch {}
						}
						break;
					}
				}
			},

			close(ws) {
				if (sandboxWsClose(ws)) return;
				allClients.delete(ws);
				stopAllWatchesForClient(ws);
				leaveSession(ws);
				leaveNote(ws);
				stopTerminal(ws); // the Shell tab's PTY dies with its socket
				console.log("WebSocket client disconnected");
			},
		},

		// Dev mode (HMR + error overlay + browser-console streaming) only when
		// explicitly asked for — the systemd service is production, and the overlay
		// pops "Script error." boxes on iOS with no diagnostics behind them.
		development:
			process.env.BACKSTAGE_DEV === "1"
				? {
						hmr: true,
						console: true,
					}
				: false,
	}));

console.log(`Backstage running at http://${HOST}:${PORT}/backstage/`);

// --- Session control surface (powers the michael-sessions MCP) ---
// Wire the Slack-channel link index + the inbound-message bridge. Re-run on every
// hot reload (cheap) so the index stays fresh and the sink closure is current.
rebuildIndex(getAllSessions());
registerLinkedChannelSink((channelId, message) => {
	broadcastToAll({ type: "slack_message", channelId, message });
});

// Wires the MCP's tools into the same in-process state and helpers the
// WebSocket handlers use, so a management session steers/answers/creates the
// exact same way a human does in the web UI. See src/server/session-control.ts.
registerSessionControl({
	listSessions: () => getCachedSessions().map(buildSummary),

	getSession: (id) => {
		const s = findSession(id);
		return s ? buildSummary(s) : undefined;
	},

	transcriptTail: (id, n) => {
		const s = findSession(id);
		if (!s?.transcriptPath) return [];
		return parseTranscript(s.transcriptPath).slice(-Math.max(0, n));
	},

	answerQuestion: (id, answers) => {
		const pending = pendingAsks.get(id);
		if (!pending) return false;
		// resolve() clears the timeout, deletes the entry and unblocks makeAskHandler,
		// which broadcasts ask_resolved and lets the run continue with these answers.
		pending.resolve(answers && typeof answers === "object" ? answers : null);
		return true;
	},

	deliverToSession: async (id, content, user, opts) => {
		const session = findSession(id);
		if (!session)
			return { status: "error" as const, message: "No session with that id." };

		// Slash commands (/loop, /goal, /model, /help) are handled by backstage
		// itself, exactly like the WebSocket prompt path — checked BEFORE the
		// busy branch so "/loop stop" configures the session instead of being
		// steered into its running turn as literal prompt text. This is what
		// lets a monitor session manage loops (its own and others') via the
		// michael-sessions send_to_session tool.
		const notice = handleSlashCommand(session, String(content || "").trim(), user);
		if (notice !== null) {
			sessionsCache = null;
			return { status: "handled" as const, message: notice };
		}

		const attributed = user ? `[${user}] ${content}` : content;

		if (
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		) {
			// Busy + owned here → fold into the running turn (delivered at the next
			// stopping point). Otherwise queue and drain when the external run ends.
			// FYI events opt out of steering entirely (busy: "queue") — they wait
			// behind the run instead of interrupting it.
			if (
				opts?.busy !== "queue" &&
				steerAgentRun(
					[session.claudeSessionId, session.codexThreadId, session.id],
					attributed,
				)
			) {
				recordSteer(id, { content, user });
				broadcastToSession(id, {
					type: "notice",
					message: `Message from ${user || "Michael"} folded into the run — picked up at the next stopping point.`,
				});
				return {
					status: "steered" as const,
					message: "Folded into the running turn.",
				};
			}
			enqueuePrompt(id, { content, user });
			watchExternalRunAndDrain(id);
			return {
				status: "queued" as const,
				message: "Queued behind the current run.",
			};
		}

		// Backstage chats with no engine id are fresh chats — the first prompt
		// starts a new conversation (see runSessionPrompt).
		if (
			providerFor(session.model) === "claude" &&
			!session.claudeSessionId &&
			session.source !== "backstage"
		) {
			return {
				status: "error" as const,
				message: "Session has no Claude session to resume yet.",
			};
		}

		// Idle → start a fresh turn in the background; don't block the tool call on
		// the whole run finishing.
		void runSessionPromptAndDrain(id, content, user).catch((e) =>
			console.error(`[sessions-mcp] deliver to ${id} failed:`, e),
		);
		return {
			status: "started" as const,
			message: "Started a new turn on the session.",
		};
	},

	cancelSession: (id) => {
		const session = findSession(id);
		if (!session) return false;
		const cancelled = cancelAgentRun(
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		);
		requeueSteerReceipts(id);
		return cancelled;
	},

	createSession: async ({
		prompt,
		branch,
		repo: repoInput,
		mode,
		model: modelInput,
		mcpServers,
		parentSessionId,
		user,
		sandbox,
	}) => {
		const isAsk = mode !== "code";
		const model = modelInput ? resolveModel(String(modelInput))?.id : undefined;
		const parentSession = parentSessionId ? findSession(parentSessionId) : null;
		// A child session defaults to its parent's repo (not tella-fusion), so
		// same-workspace workers land in the same checkout family.
		const repo = getRepo(repoInput || parentSession?.repo);
		const parentWorkspace = parentSession?.projectId
			? getWorkspace(parentSession.projectId)
			: null;

		let wtPath: string;
		let sessionBranch = branch || "";
		if (isAsk) {
			wtPath = repo.repo;
		} else {
			// Same workspace ⇒ same worktree: a code child joining the parent's
			// workspace shares its worktree/branch instead of creating a fresh one.
			// Only when the repo matches — a child explicitly targeting another
			// repo still gets its own isolated worktree there.
			const shared =
				parentWorkspace?.worktreeDir &&
				repoForPath(parentWorkspace.worktreeDir).id === repo.id &&
				existsSync(parentWorkspace.worktreeDir)
					? { dir: parentWorkspace.worktreeDir, branch: parentWorkspace.branch }
					: parentSession?.worktreeDir &&
							parentSession.mode !== "ask" &&
							repoForPath(parentSession.worktreeDir).id === repo.id &&
							existsSync(parentSession.worktreeDir)
						? { dir: parentSession.worktreeDir, branch: parentSession.branch }
						: null;
			if (shared) {
				wtPath = shared.dir;
				sessionBranch = shared.branch || sessionBranch;
			} else {
				const worktrees = await listWorktrees(repo.id);
				wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
				if (!wtPath) wtPath = await createWorktree(branch!, repo.id);
			}
		}

		const bksId = `bks-${randomUUIDv7()}`;
		const title = prompt.trim().split("\n")[0].slice(0, 80);
		let projectId = parentSession?.projectId || null;
		if (!projectId) {
			// Adopt the workspace that already owns the (parent's or this child's)
			// worktree before minting a duplicate one over it; only a workspace-less
			// backstage parent on an unowned worktree gets wrapped in a fresh one.
			const owned =
				workspaceOwningWorktree(parentSession?.worktreeDir) ??
				workspaceOwningWorktree(wtPath);
			if (owned) projectId = owned.id;
			else if (parentSession?.source === "backstage") {
				const ws = createWorkspace({
					name: parentSession.title || parentSession.branch || "Workspace",
					repo: parentSession.repo,
					createdBy: user || parentSession.startedBy || "Anonymous",
					...(parentSession.branch ? { branch: parentSession.branch } : {}),
					...(parentSession.worktreeDir
						? { worktreeDir: parentSession.worktreeDir }
						: {}),
				});
				projectId = ws.id;
			}
			if (projectId && parentSession?.source === "backstage")
				touchBackstageSession(parentSession.id, { projectId });
		}
		// Replace the raw first-line title with a short summary in the background;
		// the next sessions poll (≤5s) picks it up.
		void ensureGeneratedTitle(bksId, prompt, user, model).then((t) => {
			if (t) sessionsCache = null;
		});

		let engineSessionId = "";
		let effectiveModel = model;
		let effectiveProvider = providerFor(effectiveModel);
		const modelHistory: NonNullable<BackstageSessionFile["modelHistory"]> = [];
		let persisted = false;
		let latestUsage: SessionUsage | undefined;
		// Terminal failure the opening run died on — recorded after the loop so
		// the fresh session surfaces as "Needs input".
		let runFailure: string | null = null;
		const persist = () => {
			const sessionData: BackstageSessionFile = {
				id: bksId,
				claudeSessionId: "",
				...(engineSessionId
					? engineSessionPatch(effectiveProvider, engineSessionId)
					: {}),
				...(effectiveModel ? { model: effectiveModel } : {}),
				...(modelHistory.length ? { modelHistory } : {}),
				branch: isAsk ? "" : sessionBranch,
				worktreeDir: wtPath,
				repo: repo.id,
				...(projectId ? { projectId } : {}),
				...(parentSessionId ? { parentSessionId } : {}),
				createdBy: user || "Michael",
				createdAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				title,
				mode: isAsk ? "ask" : "code",
				// Sandbox opt-in (docs/sandboxes-plan.md Phase 0): recorded only —
				// nothing acts on it until a real provider ships.
				...(sandbox
					? { sandbox: { provider: effectiveSandboxProvider(repo.id) } }
					: {}),
			};
			writeJsonAtomic(`${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`, sessionData);
			sessionsCache = null;
			persisted = true;
		};

		// @session:<id> mentions in a create_session prompt (e.g. a monitor
		// session spun up to watch others) get the same resolving footer as
		// prompts on existing chats — this create path bypasses
		// runSessionPromptInner.
		const createMentionsNote = sessionMentionsNote(prompt);
		const openingPrompt = createMentionsNote
			? `${prompt}\n\n${createMentionsNote}`
			: prompt;

		// Run in the background; watchers (web UI) see the live stream, the same as
		// a UI-created session. The tool returns the id immediately.
		void (async () => {
			try {
				for await (const event of runAgent({
					prompt: openingPrompt,
					cwd: wtPath,
					mode: isAsk ? "ask" : "code",
					model,
					fallbackModel: interactiveFallbackModel(model),
					mcpServers,
					reposNote: buildBranchNote({
						mode: isAsk ? "ask" : "code",
						branch: sessionBranch,
						worktreeDir: wtPath,
					}),
					inProcessMcp: interactiveMcpServers(user, bksId),
					confirmTools: STRIPE_CONFIRM_TOOLS,
					aws: true,
					user, // gate per-user MCP servers (allowedUsers) to the creator
					journal: { bksSessionId: bksId, kind: "create" },
					onAskUser: makeAskHandler(bksId),
				})) {
					if (event.type === "init") {
						engineSessionId = event.sessionId || "";
						if (event.provider) effectiveProvider = event.provider;
						if (event.model) effectiveModel = event.model;
						persist();
						// Attach anyone already viewing this fresh chat to its brand-new
						// transcript file so the first turn streams live (see
						// attachSessionWatchersToTranscript).
						if (engineSessionId) {
							attachSessionWatchersToEngineTranscript(
								bksId,
								effectiveProvider,
								wtPath,
								engineSessionId,
							);
						}
					}
					if (event.type === "model_switch") {
						const to = event.toModel || "";
						const reason = `auto-switch — ${modelLabel(event.fromModel)} out of credits`;
						if (to) {
							effectiveModel = to;
							effectiveProvider = providerFor(to);
							modelHistory.push({
								model: to,
								from: event.fromModel,
								at: new Date().toISOString(),
								by: reason,
							});
							touchBackstageSession(bksId, {
								model: to,
								modelHistory,
							});
							broadcastToSession(bksId, {
								type: "model_changed",
								sessionId: bksId,
								model: to,
								from: event.fromModel,
								by: reason,
							});
						}
					}
					if (event.type === "text_chunk") {
						broadcastToSession(bksId, {
							type: "stream_text",
							sessionId: bksId,
							text: event.text,
						});
					}
					if (event.type === "tool_use") {
						broadcastToSession(bksId, {
							type: "stream_tool_use",
							sessionId: bksId,
							entry: {
								id: event.toolUseId || crypto.randomUUID(),
								type: "tool_use",
								content: `Using ${event.toolName}`,
								timestamp: new Date().toISOString(),
								toolName: event.toolName,
								toolInput: event.toolInput,
								toolUseId: event.toolUseId,
							},
						});
					}
					if (event.type === "tool_result") {
						broadcastToSession(bksId, {
							type: "stream_tool_result",
							sessionId: bksId,
							entry: {
								id: event.toolUseId
									? `tr-${event.toolUseId}`
									: crypto.randomUUID(),
								type: "tool_result",
								content: event.content || "",
								timestamp: new Date().toISOString(),
								toolUseId: event.toolUseId,
								...(event.images && event.images.length > 0
									? { images: event.images }
									: {}),
								...(event.videos && event.videos.length > 0
									? { videos: event.videos }
									: {}),
							},
						});
					}
					if (event.type === "usage_snapshot" && event.usage) {
						// Live mid-run cost/context. Snapshots are run-cumulative and this
						// is the session's only run, so the fold base is empty — each
						// snapshot recomputes the total from scratch (folding onto
						// latestUsage would double-count).
						latestUsage = foldSessionUsage(
							undefined,
							event.usage,
							effectiveModel,
						);
						broadcastToSession(bksId, {
							type: "usage_update",
							sessionId: bksId,
							usage: latestUsage,
						});
					}
					if (event.type === "done") {
						engineSessionId = event.sessionId || engineSessionId;
						if (event.provider) effectiveProvider = event.provider;
						if (event.model) effectiveModel = event.model;
						if (event.usageLimitExhausted)
							runFailure =
								event.result || "Usage limit reached on every account";
						if (event.usage) {
							latestUsage = foldSessionUsage(
								undefined,
								event.usage,
								event.model || effectiveModel,
							);
							broadcastToSession(bksId, {
								type: "usage_update",
								sessionId: bksId,
								usage: latestUsage,
							});
						}
					}
					if (event.type === "error") {
						runFailure = event.content || "Run failed";
						broadcastToSession(bksId, {
							type: "error",
							message: event.content,
						});
					}
				}
				if (!persisted) persist();
				else
					touchBackstageSession(
						bksId,
						{
							...engineSessionPatch(effectiveProvider, engineSessionId),
							...(effectiveModel ? { model: effectiveModel } : {}),
							...(modelHistory.length ? { modelHistory } : {}),
						},
					);
				if (latestUsage)
					touchBackstageSession(bksId, { usage: latestUsage });
				recordRunOutcome(bksId, runFailure);
				broadcastToSession(bksId, { type: "stream_done", sessionId: bksId });
				broadcastToSession(bksId, {
					type: "session_status",
					sessionId: bksId,
					isRunning: false,
				});
				if (!promptQueues.get(bksId)?.length) onHumanAsksSessionIdle(bksId);
			} catch (e) {
				console.error(`[sessions-mcp] create session ${bksId} failed:`, e);
			}
		})();

		return { id: bksId };
	},
});

// --- Agent loading and webhook server ---

async function loadAgents(): Promise<AgentModule[]> {
	const agents: AgentModule[] = [];

	if (process.env.ENABLE_PLAIN_AGENT !== "false") {
		try {
			const { PlainAgent } = await import("./src/agents/plain/index");
			agents.push(new PlainAgent());
			console.log("[agents] Plain agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load plain agent:", e);
		}
	}

	if (process.env.ENABLE_LINEAR_AGENT !== "false") {
		try {
			const { LinearAgent } = await import("./src/agents/linear/index");
			agents.push(new LinearAgent());
			console.log("[agents] Linear agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load linear agent:", e);
		}
	}

	if (process.env.ENABLE_SLACK_AGENT !== "false") {
		try {
			const { SlackAgent } = await import("./src/agents/slack/index");
			agents.push(new SlackAgent());
			console.log("[agents] Slack agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load slack agent:", e);
		}
	}

	// Gated on the signing secret: without it every webhook fails verification, so
	// there's no point exposing the route. Set STRIPE_WEBHOOK_SECRET to activate.
	if (
		process.env.ENABLE_STRIPE_AGENT !== "false" &&
		process.env.STRIPE_WEBHOOK_SECRET
	) {
		try {
			const { StripeAgent } = await import("./src/agents/stripe/index");
			agents.push(new StripeAgent());
			console.log("[agents] Stripe agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load stripe agent:", e);
		}
	}

	// Generic Grafana poller: drives every automation that carries a `grafanaPoll`
	// config (export failures, upload-processing failures, and any future signal
	// added as data). Gated on Grafana creds (the agent no-ops without them).
	if (process.env.ENABLE_GRAFANA_POLLER !== "false") {
		try {
			const { GrafanaPollerAgent } = await import(
				"./src/agents/grafana-poller/index"
			);
			agents.push(
				new GrafanaPollerAgent({
					onSessionInvalidate: () => {
						sessionsCache = null;
					},
				}),
			);
			console.log("[agents] Grafana poller loaded");
		} catch (e) {
			console.error("[agents] Failed to load grafana poller:", e);
		}
	}

	// GitHub PR agent: review / auto-fix / simplify on tella-fusion PRs. Receives
	// PR events forwarded from the Slack agent's /github/webhook; owns lifecycle
	// (seeds the disabled review automation, recovers interrupted fix loops).
	if (process.env.ENABLE_GITHUB_AGENT !== "false") {
		try {
			const { GithubAgent } = await import("./src/agents/github/index");
			agents.push(
				new GithubAgent({
					onSessionInvalidate: () => {
						sessionsCache = null;
					},
				}),
			);
			console.log("[agents] GitHub agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load github agent:", e);
		}
	}

	return agents;
}

// One-time startup: agents, schedulers, recurring timers, and signal handlers.
// Guarded behind __backstageBooted so a `bun --hot` reload never double-starts
// any of it — the already-running agents/timers keep going untouched (only a
// real restart reloads their code, and that restart is now graceful, below).
if (!g.__backstageBooted) {
	// Start webhook server with enabled agents + automation webhook triggers
	agents = await loadAgents();
	g.__agents = agents;
	const webhookServer = startWebhookServer(
		agents,
		getWebhookRoutes(() => {
			sessionsCache = null;
		}),
	);
	void webhookServer;

	// Seed the make_*_editor.sh action family (create-if-absent, UI edits preserved).
	try {
		ensureSeedActions();
	} catch (e) {
		console.error("[actions] Failed to seed actions:", e);
	}

	// Seed cron-scheduled "sweep" loops (Production Error Sweep, …) as automations
	// before the scheduler starts. Create-if-absent, so UI edits are preserved.
	try {
		const { ensureSweepLoops } = await import("./src/agents/loops/sweep");
		ensureSweepLoops();
		const { ensureMonitors } = await import("./src/agents/loops/monitor");
		ensureMonitors();
		const { ensureSeoLoops } = await import("./src/agents/loops/seo");
		ensureSeoLoops();
		const { ensureStalePrMonitor } = await import(
			"./src/agents/loops/stale-prs"
		);
		ensureStalePrMonitor();
		const { ensureCronJobs } = await import("./src/agents/loops/cron-jobs");
		ensureCronJobs();
		// Autonomous session monitor (per-user, opt-in — Settings → Monitor)
		const { startSessionMonitor } = await import(
			"./src/agents/loops/session-monitor"
		);
		startSessionMonitor();
	} catch (e) {
		console.error(
			"[loops] Failed to seed sweep/monitor/seo/stale-pr/cron loops:",
			e,
		);
	}

	// Cron-scheduled automations + internal event bus (agents → automations)
	startScheduler(() => {
		sessionsCache = null;
	});
	setEventSessionCallback(() => {
		sessionsCache = null;
	});

	// Scheduled prompts ("send this to this session at 5pm") — deliver due ones
	// through the SessionControl registry, exactly like a typed message.
	setInterval(() => {
		void (async () => {
			const { takeDuePrompts } = await import(
				"./src/server/scheduled-prompts"
			);
			for (const p of takeDuePrompts()) {
				try {
					const result = await getSessionControl().deliverToSession(
						p.sessionId,
						p.prompt,
						p.user,
					);
					console.log(
						`[scheduled-prompts] ${p.id} → ${p.sessionId}: ${result.status}`,
					);
				} catch (e) {
					console.error(`[scheduled-prompts] ${p.id} delivery failed:`, e);
				}
			}
		})();
	}, 30_000);

	// Archive triage sessions when their Plain ticket is done
	startPlainArchiveSweep(() => {
		sessionsCache = null;
	});

	// Auto-archive sessions that look done (merged PR, or opt-in green checks) —
	// per-user, opt-in by repo (Settings → Auto-archive), on by default only for
	// the backstage repo itself.
	startAutoArchiveSweep(
		() =>
			getAllSessions().map((s) => ({
				...s,
				waitingForInput: pendingAsks.has(s.id),
				lastRunError: runErrors.get(s.id) || s.lastRunError,
			})),
		() => {
			sessionsCache = null;
		},
	);

	// Poll per-account Claude usage (drives account picking + the Connections UI)
	startUsagePoller();

	// Resume Claude runs a previous process left in-flight (restart/crash), then
	// wake any session that finished its turn during the shutdown drain (so the
	// journal no longer held it). Together these wake every session that was
	// active before the restart.
	setTimeout(() => {
		const resumedIds = resumeInterruptedRuns(
			() => {
				sessionsCache = null;
			},
			// Re-attach the AskUserQuestion handler so a run that was blocked on an
			// ask (web UI or Slack escalation) can ask again after the restart instead
			// of dead-ending headless. Automations stay headless by design.
			(bksSessionId) => {
				const session = findSession(bksSessionId);
				if (!session || session.source !== "backstage" || session.automation)
					return undefined;
				return makeAskHandler(bksSessionId);
			},
			(bksSessionId, user) => {
				const session = findSession(bksSessionId);
				if (!session || session.source !== "backstage" || session.automation)
					return undefined;
				return session.goalId
					? {
							...interactiveMcpServers(user, bksSessionId),
							"michael-goal-self": createGoalSelfMcpServer(session.goalId),
						}
					: interactiveMcpServers(user, bksSessionId);
			},
			(bksSessionId) => {
				const session = findSession(bksSessionId);
				if (!session || session.source !== "backstage" || session.automation)
					return undefined;
				return buildReposNote(session);
			},
			recordRecoveredRunEvent,
		);
		if (resumedIds.length > 0) {
			console.log(
				`[runner] Resumed ${resumedIds.length} interrupted run(s) from before restart`,
			);
			sessionsCache = null;
		}
		resumeDrainedSessions(new Set(resumedIds));
		// Re-deliver messages that were queued/steered when the process went down.
		restorePromptQueues();
		// Restore human-in-the-loop asks: re-arm scheduled timers, and degrade any
		// block asks that lost their held turn to async so late replies still land.
		initHumanAsks();
	}, 3000);

	// Ongoing hygiene (every 6h): archive sessions idle for more than a week,
	// then remove worktrees of archived sessions idle >14 days with no WIP.
	setInterval(
		async () => {
			const count = archiveOlderThan(getAllSessions(), 7);
			if (count > 0) {
				console.log(`[archive] Auto-archived ${count} session(s) idle >7 days`);
				sessionsCache = null;
			}
			try {
				const removed = await sweepArchivedWorktrees(getAllSessions(), 14);
				if (removed.length > 0) {
					console.log(
						`[worktree-sweep] Removed ${removed.length} clean worktree(s): ${removed.join(", ")}`,
					);
					sessionsCache = null;
				}
			} catch (e) {
				console.error("[worktree-sweep] Sweep failed:", e);
			}
			// Sandboxes of long-idle archived sessions, same cadence as the
			// worktree sweep: containers + engine-state volumes are provider-owned
			// and safe to drop (bind-mode worktrees belong to the sweep above and
			// are untouched). Volume-mode workspaces die with the sandbox — the
			// documented contract of that mode (push your work). A revived session
			// just re-ensures a fresh container on its next prompt.
			try {
				const cutoff = Date.now() - 14 * 86_400_000;
				for (const s of getAllSessions()) {
					if (!s.sandbox?.sandboxId || !s.archived || s.isRunning) continue;
					if (new Date(s.lastActivity).getTime() >= cutoff) continue;
					destroySessionSandbox(s, "archive-sweep", true);
				}
			} catch (e) {
				console.error("[sandbox-sweep] Sweep failed:", e);
			}
		},
		6 * 60 * 60 * 1000,
	);

	// Run agent startup hooks
	for (const agent of agents) {
		try {
			await agent.startup();
			console.log(`[agents] ${agent.name} agent started`);
		} catch (e) {
			console.error(`[agents] ${agent.name} agent startup failed:`, e);
		}
	}

	// Graceful shutdown: stop taking new work, let in-flight runs reach a natural
	// stopping point (bounded), then exit — instead of killing every run mid-turn.
	// Anything still running after the drain window is picked up by the run
	// journal on the next boot (resumeInterruptedRuns), so nothing is lost.
	// 2-min default so in-flight runner runs have a real chance to finish their
	// current turn before exit. Must stay below the unit's TimeoutStopSec (140s),
	// or systemd SIGKILLs the process mid-drain.
	const DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_MS || "120000");
	let shuttingDown = false;
	const gracefulShutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(
			`[shutdown] ${signal} — stopping intake and draining in-flight runs…`,
		);
		// Snapshot active sessions BEFORE the drain — the drain lets runs finish
		// their turn and clear themselves from the journal, so this is the only
		// record of sessions that should be woken on the next boot.
		snapshotActiveSessions();
		// Tell connected UIs we're going down so they can show a "restarting" modal
		// and auto-refresh once the new instance is up (instead of silently queuing
		// messages that would be lost). Brief pause to let the frames flush.
		broadcastToAll({ type: "server_restarting" });
		await new Promise((r) => setTimeout(r, 150));
		// Stop agents from accepting new work (Slack socket, webhook intake, …).
		for (const agent of agents) {
			try {
				await agent.shutdown();
			} catch (e) {
				console.error(`[shutdown] ${agent.name} shutdown error:`, e);
			}
		}
		// Stop accepting new HTTP/WS connections; existing ones can finish.
		try {
			server.stop();
		} catch {}
		// Wait for runner-driven runs (web UI / automations / loops) to settle.
		const deadline = Date.now() + DRAIN_TIMEOUT_MS;
		let n = activeAgentRunCount();
		while (n > 0 && Date.now() < deadline) {
			console.log(`[shutdown] waiting on ${n} in-flight run(s)…`);
			await new Promise((r) => setTimeout(r, 500));
			n = activeAgentRunCount();
		}
		if (n > 0) {
			console.log(
				`[shutdown] ${n} run(s) still active after ${DRAIN_TIMEOUT_MS}ms — the journal will resume them on restart`,
			);
		} else {
			console.log("[shutdown] all in-flight runs drained cleanly");
		}
		process.exit(0);
	};
	process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
	process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

	// Frontend live-reload: rebuild the SPA bundle in-process when its source
	// changes, so a CSS/frontend tweak no longer needs a `systemctl restart` that
	// interrupts every running session. `kill -USR2 <pid>` forces it too (drop-in
	// for restart in a deploy script). Guarded by __backstageBooted so a hot
	// reload doesn't stack watchers/handlers. recursive watch needs Linux ≥ 6.x
	// (we're on 6.17) — fine here.
	if (!IS_DEV && frontend) {
		try {
			const watcher = watch(FRONTEND_SRC, { recursive: true }, (_evt, file) => {
				if (file && /\.(tsx?|css|html)$/.test(file.toString())) {
					scheduleFrontendRebuild(`watch:${file}`);
				}
			});
			process.on("exit", () => watcher.close());
			console.log(`[frontend] Watching ${FRONTEND_SRC} for live rebuilds`);
		} catch (e) {
			console.error(
				"[frontend] Could not start file-watch (use SIGUSR2/endpoint to rebuild):",
				e,
			);
		}
		process.on("SIGUSR2", () => scheduleFrontendRebuild("SIGUSR2", 0));
	}

	g.__backstageBooted = true;
}
