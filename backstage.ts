#!/usr/bin/env bun

import { randomUUIDv7 } from "bun";
import { BACKSTAGE_CHATS_DIR } from "./src/server/paths";
import {
	mkdirSync,
	existsSync,
	writeFileSync,
	readFileSync,
	copyFileSync,
	watch,
} from "fs";
import homepage from "./src/frontend/index.html";
import {
	getAllSessions,
	deleteSession,
	getTranscriptPath,
} from "./src/server/sessions";
import {
	parseTranscript,
	parseTranscriptTail,
	transcriptMatchSnippet,
} from "./src/server/jsonl-parser";
import { getSubagentTranscript } from "./src/server/subagents";
import {
	startWatching,
	stopAllWatchesForClient,
} from "./src/server/file-watcher";
import {
	listWorktrees,
	createWorktree,
	removeWorktree,
	reviveWorktree,
	sweepArchivedWorktrees,
	getRepo,
	repoForPath,
	prepareAttachedWorktree,
	worktreeHasWork,
	REPOS,
} from "./src/server/worktree";
import {
	STRIPE_CONFIRM_TOOLS,
	activeRunRecords,
} from "./src/server/claude-runner";
import {
	runAgent,
	isAgentSessionBusy,
	cancelAgentRun,
	steerAgentRun,
	interruptAndSteerAgentRun,
	resumeInterruptedRuns,
	RESUME_CONTINUATION_PROMPT,
	activeAgentRunCount,
} from "./src/server/agent-runner";
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
	formatModelList,
	DEFAULT_FALLBACK_MODEL,
} from "./src/server/models";
import {
	listCodexAccountsPublic,
	addCodexAccount,
	removeCodexAccount,
} from "./src/server/codex-accounts";
import { getSessionDiff, type SessionDiff } from "./src/server/git-diff";
import { searchRepoFiles } from "./src/server/file-index";
import { suggestBranchName } from "./src/server/suggest-branch";
import { getPreviewStatus, startPreview, stopPreview } from "./src/server/preview";
import {
	registerSessionControl,
	type SessionState,
	type SessionSummary,
} from "./src/server/session-control";
import {
	gitIdentityFor,
	resolveTeammate,
} from "./src/server/shared/user-mappings";
import { createSessionsMcpServer } from "./src/agents/slack/sessions-tools";
import { createAdminMcpServer } from "./src/agents/slack/admin-tools";
import { createHumansMcpServer } from "./src/agents/slack/humans-tools";
import { createReposMcpServer } from "./src/agents/slack/repos-tools";
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
} from "./src/server/pr-info";
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
import { setArchived, archiveOlderThan } from "./src/server/archive";
import { setTitleOverride } from "./src/server/title-overrides";
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
	refreshAllUsage,
	startUsagePoller,
} from "./src/server/claude-accounts";
import { startWebhookServer } from "./src/server/webhook-server";
import type { AgentModule } from "./src/agents/types";
import type {
	UnifiedSession,
	BackstageSessionFile,
	AttachedRepo,
} from "./src/server/types";

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
	// Sessions driven from the web UI run in-process; surface those too
	for (const s of data) {
		if (
			!s.isRunning &&
			isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id)
		) {
			s.isRunning = true;
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
		"michael-sessions": createSessionsMcpServer({ createdBy, isAdmin: true }),
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
				}
			: {}),
	};
}

/**
 * System-prompt note describing a session's repos when it spans more than one.
 * Lists the primary worktree + every attached repo with its path/branch and how
 * `@<project>:path` mentions resolve. Returns undefined for single-repo sessions
 * so the prompt stays clean.
 */
function buildReposNote(session: UnifiedSession): string | undefined {
	const attached = session.attachedRepos || [];
	if (!attached.length) return undefined;
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
	return lines.join("\n");
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
		writeFileSync(
			path,
			JSON.stringify(
				{ ...data, ...patch, lastActivity: new Date().toISOString() },
				null,
				2,
			),
		);
		sessionsCache = null;
	} catch (e) {
		console.error(`Failed to update backstage session ${bksId}:`, e);
	}
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
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");
	if (session.mode === "ask")
		throw new Error("Ask sessions read the main checkout — nothing to switch");
	if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
	if (session.repo === repoId)
		throw new Error(`${repoId} is already this session's primary repo`);
	if (
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

function joinSession(ws: any, sessionId: string) {
	let set = sessionWatchers.get(sessionId);
	if (!set) {
		set = new Set();
		sessionWatchers.set(sessionId, set);
	}
	set.add(ws);
	broadcastPresence(sessionId);
}

function leaveSession(ws: any) {
	const sessionId = ws.data?.watchingSessionId;
	if (!sessionId) return;
	const set = sessionWatchers.get(sessionId);
	if (set) {
		set.delete(ws);
		if (set.size === 0) sessionWatchers.delete(sessionId);
		else broadcastPresence(sessionId);
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
// the same way Claude Code handles interruptions.
type QueueItem = { content: string; user?: string };
const promptQueues: Map<string, QueueItem[]> = (g.__promptQueues ??= new Map());

// Steered messages (folded into a live run, delivered at the run's next turn
// boundary) aren't in promptQueues — the drain would re-deliver them. But until
// their turn lands they're invisible on reload, so we keep a display-only
// receipt here: shown as "folded in" in the UI and reconciled away once the real
// transcript entry appears. Cleared when the run finishes (or is cancelled).
const steeredReceipts: Map<string, QueueItem[]> = (g.__steeredReceipts ??=
	new Map());

// Both maps are persisted to disk so a real restart/crash (not just a hot
// reload, which keeps the globalThis maps) doesn't silently drop queued or
// just-steered messages. Restored + re-drained on boot (restorePromptQueues).
const QUEUE_STORE = `${BACKSTAGE_SESSIONS_DIR}/prompt-queues.json`;
function persistQueues(): void {
	try {
		const entries = (m: Map<string, QueueItem[]>) =>
			Object.fromEntries([...m].filter(([, v]) => v.length > 0));
		writeFileSync(
			QUEUE_STORE,
			JSON.stringify({
				queued: entries(promptQueues),
				steered: entries(steeredReceipts),
			}),
		);
	} catch (e) {
		console.error("[queue] Failed to persist prompt queues:", e);
	}
}

/** Append a message to a session's drainable queue and persist + broadcast. */
function enqueuePrompt(sessionId: string, item: QueueItem): void {
	const queue = promptQueues.get(sessionId) || [];
	queue.push(item);
	promptQueues.set(sessionId, queue);
	persistQueues();
	broadcastQueue(sessionId);
}

/** Record a steered message as a visible receipt until its run finishes. */
function recordSteer(sessionId: string, item: QueueItem): void {
	const list = steeredReceipts.get(sessionId) || [];
	list.push(item);
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
		console.error("[queue] Failed to read persisted queues:", e);
		return;
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
				writeFileSync(RESUME_SNAPSHOT_PATH, "[]");
			return;
		}
		writeFileSync(RESUME_SNAPSHOT_PATH, JSON.stringify(records));
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
		writeFileSync(RESUME_SNAPSHOT_PATH, "[]");
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

// Loaded agents (Plain/Linear/Slack/Stripe/…). Module-scoped because request
// handlers (health routes) read it, and globalThis-backed so the set survives a
// hot reload (loadAgents runs only on a real boot, inside the guard below).
let agents: AgentModule[] = (g.__agents as AgentModule[] | undefined) ?? [];

function broadcastQueue(sessionId: string) {
	broadcastToSession(sessionId, {
		type: "queue_update",
		sessionId,
		queued: promptQueues.get(sessionId) || [],
		steered: steeredReceipts.get(sessionId) || [],
	});
}

async function drainQueue(sessionId: string): Promise<void> {
	let queue;
	while ((queue = promptQueues.get(sessionId)) && queue.length > 0) {
		const batch = queue.splice(0, queue.length);
		if (queue.length === 0) promptQueues.delete(sessionId);
		persistQueues();
		broadcastQueue(sessionId);
		const combined = batch
			.map((m) =>
				batch.length > 1 && m.user ? `[${m.user}] ${m.content}` : m.content,
			)
			.join("\n\n");
		await runSessionPrompt(sessionId, combined, batch[0].user);
	}
}

async function runSessionPromptAndDrain(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
): Promise<void> {
	await runSessionPrompt(sessionId, content, user, images, rawFiles);
	await drainQueue(sessionId);
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
const UPLOADS_DIR = `${BACKSTAGE_SESSIONS_DIR}/uploads`;
// Base64-over-WebSocket is fine for modest files; cap so a huge upload can't OOM
// the process or blow the message frame. Oversized files are dropped with a note.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface FileUpload {
	name: string;
	data: string; // base64 (no data: prefix)
}

/** Decode composer `{name, dataUrl}` attachments into name + base64 payloads. */
function parseFileUploads(raw?: unknown): FileUpload[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: FileUpload[] = [];
	for (const f of raw) {
		if (!f || typeof f !== "object") continue;
		const name = typeof (f as any).name === "string" ? (f as any).name : "";
		const url = typeof (f as any).dataUrl === "string" ? (f as any).dataUrl : "";
		const m = url.match(/^data:[^;]*;base64,(.+)$/s);
		if (!m) continue;
		out.push({ name, data: m[1] });
	}
	return out.length ? out : undefined;
}

/** Keep a user-supplied filename to a safe basename (no traversal, no exotic chars). */
function sanitizeFilename(name: string): string {
	const base = (name.split(/[\\/]/).pop() || "file").replace(/^\.+/, "");
	const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").trim().slice(0, 120);
	return cleaned || "file";
}

/**
 * Write uploaded files to a per-session staging dir (outside any repo, so they
 * never pollute git) and return the absolute paths. Collisions are de-duped and
 * oversized files skipped.
 */
function stageUploads(
	sessionId: string,
	uploads: FileUpload[],
): { name: string; path: string }[] {
	const dir = `${UPLOADS_DIR}/${sessionId}`;
	mkdirSync(dir, { recursive: true });
	const staged: { name: string; path: string }[] = [];
	const used = new Set<string>();
	for (const up of uploads) {
		const buf = Buffer.from(up.data, "base64");
		if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
			console.warn(
				`[uploads] Skipping ${up.name || "(unnamed)"} for ${sessionId} — ${buf.length} bytes`,
			);
			continue;
		}
		const wanted = sanitizeFilename(up.name);
		let fname = wanted;
		let i = 1;
		while (used.has(fname) || existsSync(`${dir}/${fname}`)) {
			const dot = wanted.lastIndexOf(".");
			fname =
				dot > 0
					? `${wanted.slice(0, dot)}-${i}${wanted.slice(dot)}`
					: `${wanted}-${i}`;
			i++;
		}
		used.add(fname);
		const p = `${dir}/${fname}`;
		writeFileSync(p, buf);
		staged.push({ name: up.name || fname, path: p });
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

/** Run a prompt against an existing session, broadcasting to all watchers. */
async function runSessionPrompt(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
): Promise<void> {
	const session = findSession(sessionId);
	if (!session) return;

	// The engine session id depends on the session's model: codex models resume
	// the codex thread, claude models the claude session. A missing engine id
	// just means "first run on this provider" — a fresh thread/session starts.
	const provider = providerFor(session.model);
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

	// A cleaned-up worktree makes the SDK spawn fail with a misleading "binary
	// not found" (ENOENT on the missing cwd) — revive it first. Same path as
	// before, so resuming the claude session keeps its history.
	let cwd = session.worktreeDir || `${HOME}/projects/tella-fusion`;
	if (session.worktreeDir && !existsSync(session.worktreeDir)) {
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
		: undefined;
	const deniedTools = isAutomationSession ? automationDeniedTools() : undefined;

	// Everyone viewing this session sees the prompt and the live run
	broadcastToSession(sessionId, {
		type: "stream_start",
		sessionId,
		by: user || "Anonymous",
	});
	broadcastToSession(sessionId, { type: "session_status", isRunning: true });

	let finalSessionId = engineSessionId || "";
	let endedWithError = false;
	// Accumulate the assistant reply so we can mirror it to a linked Slack channel
	// (this path — queue drain / deliverToSession / loops — is where a channel
	// @mention lands; web-typed prompts stream through the WS handler instead, so
	// they don't spam the channel).
	let assistantText = "";

	for await (const event of runAgent({
		prompt,
		sessionId: engineSessionId || undefined,
		cwd,
		mode: session.mode,
		model: session.model,
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
				finalSessionId = event.sessionId || finalSessionId;
				break;
			case "text_chunk":
				assistantText += event.text;
				broadcastToSession(sessionId, {
					type: "stream_text",
					text: event.text,
				});
				break;
			case "tool_use":
				broadcastToSession(sessionId, {
					type: "stream_tool_use",
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
			case "done":
				finalSessionId = event.sessionId || finalSessionId;
				sessionsCache = null;
				break;
			case "error":
				endedWithError = true;
				broadcastToSession(sessionId, {
					type: "error",
					message: event.content,
				});
				break;
		}
	}

	// Persist activity on our own session store (slack/linear stores are read-only)
	if (session.source === "backstage") {
		touchBackstageSession(
			session.id,
			provider === "codex"
				? { codexThreadId: finalSessionId || undefined }
				: { claudeSessionId: finalSessionId || undefined },
		);
	}

	// On a clean finish any steered messages already landed in the transcript, so
	// drop their display-only receipts. But if the run ended in error/abort (e.g.
	// a restart killed the SDK stream mid-turn), a steered message may NOT have
	// been delivered yet — keep the receipt so persistQueues/restorePromptQueues
	// can re-deliver it on the next boot instead of silently dropping it.
	if (!endedWithError) clearSteerReceipts(sessionId);

	broadcastToSession(sessionId, { type: "stream_done" });
	broadcastToSession(sessionId, { type: "session_status", isRunning: false });

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
	if (!promptQueues.get(sessionId)?.length) onHumanAsksSessionIdle(sessionId);
}

/**
 * Backstage-native slash commands. Returns a notice string when the message
 * was consumed as a command, or null to send it to Claude as a normal prompt.
 */
function handleSlashCommand(
	session: UnifiedSession,
	text: string,
	user?: string,
): string | null {
	if (
		!text.startsWith("/goal") &&
		!text.startsWith("/loop") &&
		!text.startsWith("/model") &&
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
		const prevProvider = providerFor(session.model);
		touchBackstageSession(session.id, {
			model: resolved.id,
			modelHistory: [
				...(session.modelHistory || []),
				{ model: resolved.id, at: new Date().toISOString(), by: user },
			],
		});
		// Everyone watching sees the switch (pill + inline divider) immediately
		broadcastToSession(session.id, {
			type: "model_changed",
			sessionId: session.id,
			model: resolved.id,
			by: user,
		});
		const switchedProvider = prevProvider !== resolved.provider;
		return (
			`Model set to ${resolved.id} (${modelLabel(resolved.id)}). Applies from the next prompt.` +
			(switchedProvider
				? resolved.provider === "codex"
					? " Heads up: this switches the engine to Codex — the Claude conversation history doesn't carry over, so the next prompt starts a fresh Codex thread (switching back to a Claude model resumes the old history)."
					: " Heads up: this switches the engine back to Claude — the Codex thread's history doesn't carry over, but the earlier Claude history (if any) resumes."
				: "")
		);
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
		const persistSession = (engineSessionId: string) => {
			const isCodex = providerFor(effectiveModel) === "codex";
			const data: BackstageSessionFile = {
				id: bksId,
				claudeSessionId: isCodex ? "" : engineSessionId,
				...(isCodex && engineSessionId ? { codexThreadId: engineSessionId } : {}),
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
			writeFileSync(
				`${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`,
				JSON.stringify(data, null, 2),
			);
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
				if (event.model) effectiveModel = event.model;
				persistSession(engineSessionId);
			}
			if (event.type === "done") {
				engineSessionId = event.sessionId || engineSessionId;
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
	const cssSrc = await Bun.file(`${FRONTEND_SRC}/styles/global.css`).text();
	const cssHash = Bun.hash(cssSrc).toString(36);
	const cssName = `global-${cssHash}.css`;
	await Bun.write(`${FRONTEND_DIST}/${cssName}`, cssSrc);

	let indexHtml = await Bun.file(`${FRONTEND_SRC}/index.html`).text();
	indexHtml = indexHtml.replace(
		'<script type="module" src="./App.tsx"></script>',
		`<script type="module" crossorigin src="/backstage/${entryName}"></script>`,
	);
	indexHtml = indexHtml.replace(
		"</head>",
		`  <link rel="stylesheet" href="/backstage/${cssName}">\n</head>`,
	);
	const version = `${entryName}|${cssName}`;

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
			"/backstage/reviews": spaEntry,
			"/backstage/reviews/*": spaEntry,
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
						name: "Michael",
						short_name: "Michael",
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

				const redirect = (to: string) =>
					new Response(null, { status: 302, headers: { Location: to } });

				// Reuse the most recent live (non-archived) session for this thread so
				// the card links to ongoing work instead of spawning a duplicate run.
				const existing = getCachedSessions()
					.filter((s) => s.plainThreadId === threadId && !s.archived)
					.sort(
						(a, b) =>
							new Date(b.lastActivity).getTime() -
							new Date(a.lastActivity).getTime(),
					)[0];
				if (existing) return redirect(`/backstage/session/${existing.id}`);

				const automation = listAutomations().find(
					(a) => a.eventKey === "plain:thread_created",
				);
				if (!automation) return redirect("/backstage/");

				// Build the same payload shape the webhook event carries
				let payload: Record<string, unknown> = { threadId };
				try {
					const { getThreadWithMessages } = await import(
						"./src/agents/plain/api"
					);
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
					console.error(
						`[plain-triage] Thread lookup failed for ${threadId}:`,
						e,
					);
				}

				const sessionId = await new Promise<string | null>((resolve) => {
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

				return redirect(
					sessionId ? `/backstage/session/${sessionId}` : "/backstage/",
				);
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
				}));
				return Response.json(enriched);
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
						if (t.dir && existsSync(t.dir)) {
							try {
								diff = await getSessionDiff(
									t.dir,
									getRepo(t.repo).defaultBranch,
								);
							} catch {}
						}
						return { repo: t.repo, dir: t.dir, primary: t.primary, diff };
					}),
				);

				return Response.json({ repos });
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
				setArchived(sessionId, archived);
				// Plain done-tickets are archived via a file-level flag, not the
				// registry; clearing only the registry would leave them archived. On
				// unarchive, also clear the file flag so the session returns to "My
				// sessions".
				if (!archived) clearSessionFileArchive(sessionId);
				sessionsCache = null;
				return Response.json({ ok: true });
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
				if (session?.worktreeDir && existsSync(session.worktreeDir)) {
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
				const multi = repos.length > 1;
				const perRepo = multi ? Math.max(6, Math.floor(20 / repos.length)) : 20;
				const out: Array<{ display: string; insert: string; repo?: string }> =
					[];
				for (const r of repos) {
					try {
						for (const f of await searchRepoFiles(r.dir, q, perRepo)) {
							out.push({
								display: f,
								insert: r.primary ? f : `${r.repo}:${f}`,
								repo: multi ? r.repo : undefined,
							});
						}
					} catch {}
				}
				return Response.json({ files: out.slice(0, 24) });
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
				};
				// share (default): reuse the workspace's worktree/branch (parallel chats,
				// one branch). stack: a new worktree branched off it (stacked PRs). ask:
				// no worktree, read-only on main. Empty chat — first prompt starts the run.
				const chatMode = body.mode || "share";
				const bksId = `bks-${randomUUIDv7()}`;
				let branch = src.branch || "";
				let worktreeDir = src.worktreeDir || "";
				let mode: "ask" | "code" = src.mode || "code";
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
				}
				const data: BackstageSessionFile = {
					id: bksId,
					claudeSessionId: "",
					branch,
					worktreeDir,
					...(src.repo ? { repo: src.repo } : {}),
					...(src.projectId ? { projectId: src.projectId } : {}),
					createdBy: body.user || "Anonymous",
					createdAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					title: "New chat",
					mode,
				};
				writeFileSync(
					`${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`,
					JSON.stringify(data, null, 2),
				);
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
				const switchable =
					session.mode !== "ask" &&
					!(
						session.worktreeDir &&
						session.branch &&
						(await worktreeHasWork(
							session.worktreeDir,
							session.branch,
							session.repo,
						))
					);
				return Response.json({ switchable });
			}

			// Switch the session's PRIMARY repo (wrong repo picked at creation).
			// Clean-only — rejects with 400 if the session already has work.
			const switchMatch = path.match(
				/^\/backstage\/api\/sessions\/(.+)\/switch-primary-repo$/,
			);
			if (switchMatch && req.method === "POST") {
				const sessionId = decodeURIComponent(switchMatch[1]);
				const body = (await req.json().catch(() => ({}))) as { repo?: string };
				if (!body.repo)
					return Response.json({ error: "repo required" }, { status: 400 });
				try {
					const result = await switchPrimaryRepo(sessionId, body.repo);
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

			// ── Automations ──
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
				const result = await addAccount(body.name, body.token);
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

			// ── Models available to sessions ──
			if (path === "/backstage/api/models" && req.method === "GET") {
				return Response.json({
					models: KNOWN_MODELS,
					default: getDefaultModel(),
				});
			}

			// Suggest a branch name from a task prompt (one no-tools Haiku call).
			// Used to auto-fill the New Session "Branch name" field as you type.
			if (path === "/backstage/api/suggest-branch" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				const prompt = typeof body?.prompt === "string" ? body.prompt : "";
				const branch = await suggestBranchName(prompt);
				return Response.json({ branch });
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

			const noteMatch = path.match(/^\/backstage\/api\/notes\/([^/]+)$/);
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
			open(ws) {
				allClients.add(ws);
				console.log("WebSocket client connected");
			},

			async message(ws, message) {
				let msg: any;
				try {
					msg = JSON.parse(String(message));
				} catch {
					ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
					return;
				}

				switch (msg.type) {
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
						const { entries, truncated } = session.transcriptPath
							? parseTranscriptTail(session.transcriptPath)
							: { entries: [], truncated: false };
						ws.send(
							JSON.stringify({ type: "transcript_init", entries, truncated }),
						);

						// Start file watcher
						if (session.transcriptPath) {
							startWatching(session.transcriptPath, ws);
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

						// Current message queue + steer receipts for this session
						ws.send(
							JSON.stringify({
								type: "queue_update",
								sessionId,
								queued: promptQueues.get(sessionId) || [],
								steered: steeredReceipts.get(sessionId) || [],
							}),
						);

						// Send running status
						ws.send(
							JSON.stringify({
								type: "session_status",
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

					case "load_history": {
						// "Load earlier history" button: the initial watch only sent the tail,
						// so re-send the full transcript (cached by mtime in jsonl-parser).
						const session = findSession(msg.sessionId);
						if (!session?.transcriptPath) {
							ws.send(
								JSON.stringify({
									type: "transcript_init",
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
								entries,
								truncated: false,
							}),
						);
						break;
					}

					case "prompt": {
						const { sessionId, content, user } = msg;
						const images = parseImageDataUrls(msg.images);
						const session = findSession(sessionId);
						if (!session) {
							ws.send(
								JSON.stringify({ type: "error", message: "Session not found" }),
							);
							return;
						}

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

						// Busy → steer it into the running query (delivered at the next
						// turn boundary, Claude-Code style). Falls back to the queue when
						// the run isn't steerable: codex runs, runs owned by another
						// process (Slack handler, CLI in tmux), or a run that's finishing.
						if (
							isAgentSessionBusy(
								session.claudeSessionId,
								session.codexThreadId,
								session.id,
							)
						) {
							const attributed = user ? `[${user}] ${content}` : content;
							if (
								steerAgentRun(
									[session.claudeSessionId, session.codexThreadId, session.id],
									attributed,
								)
							) {
								// The message lands in the transcript when its turn starts. Until
								// then a steer receipt is the durable visible record (survives
								// reload/leave); kept out of promptQueues so the drain never
								// re-delivers it, and cleared when the run finishes.
								recordSteer(sessionId, { content, user });
								broadcastToSession(sessionId, {
									type: "notice",
									message: `Message from ${user || "you"} folded into the run — Michael picks it up at the next stopping point.`,
								});
								break;
							}
							enqueuePrompt(sessionId, { content, user });
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

						await runSessionPromptAndDrain(sessionId, content, user, images, msg.files);
						break;
					}

					case "interrupt_prompt": {
						// Esc-style redirect: stop the current turn, keep the session, and
						// continue right away with this message. Falls back to a normal
						// prompt (steer/queue/run) when there's nothing to interrupt.
						const { sessionId, content, user } = msg;
						const session = findSession(sessionId);
						if (!session) {
							ws.send(
								JSON.stringify({ type: "error", message: "Session not found" }),
							);
							return;
						}
						const attributed = user ? `[${user}] ${content}` : content;
						if (
							isAgentSessionBusy(
								session.claudeSessionId,
								session.codexThreadId,
								session.id,
							) &&
							interruptAndSteerAgentRun(
								[session.claudeSessionId, session.codexThreadId, session.id],
								attributed,
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
						// Not interruptible (external run, codex, or just finished): treat
						// like a normal send so the message is never lost.
						if (
							isAgentSessionBusy(
								session.claudeSessionId,
								session.codexThreadId,
								session.id,
							)
						) {
							enqueuePrompt(sessionId, { content, user });
							watchExternalRunAndDrain(sessionId);
							break;
						}
						await runSessionPromptAndDrain(sessionId, content, user);
						break;
					}

					case "cancel": {
						const data = ws.data;
						if (data.watchingSessionId) {
							const session = findSession(data.watchingSessionId);
							if (session) {
								cancelAgentRun(
									session.claudeSessionId,
									session.codexThreadId,
									session.id,
								);
							}
							clearSteerReceipts(data.watchingSessionId);
							const dropped =
								promptQueues.get(data.watchingSessionId)?.length || 0;
							if (dropped > 0) {
								promptQueues.delete(data.watchingSessionId);
								persistQueues();
								broadcastQueue(data.watchingSessionId);
								broadcastToSession(data.watchingSessionId, {
									type: "notice",
									message: `Cancelled — ${dropped} queued message${dropped === 1 ? "" : "s"} dropped.`,
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

					case "create_session": {
						const { branch, prompt, user, mode } = msg;
						const images = parseImageDataUrls(msg.images);

						// Fork: branch a new session off an existing one, keeping the REAL
						// engine conversation (via SDK forkSession), optionally from a chosen
						// message. Inherits the source's mode/model/cwd. Claude-only.
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
						if (forkSource && !canFork) {
							ws.send(
								JSON.stringify({
									type: "error",
									message: "Fork is only supported for Claude sessions",
								}),
							);
							return;
						}

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
						const isCodex = providerFor(model) === "codex";
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
						if (!workspace && msg.createWorkspace) {
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
						try {
							let wtPath: string;
							if (forkSource) {
								// Share the source's cwd so the fork sees the same code state.
								wtPath = forkSource.worktreeDir || repo.repo;
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
									const base =
										chatMode === "stack" && workspace?.branch
											? workspace.branch
											: undefined;
									wtPath = await createWorktree(
										branch,
										repo.id,
										base ? { base } : undefined,
									);
								}
							}
							// First code chat materializes the workspace's owned worktree so
							// later share-mode chats inherit it. Stacked chats keep their own.
							if (
								workspace &&
								!workspace.worktreeDir &&
								!isAsk &&
								!repo.sharedCheckout &&
								chatMode !== "stack"
							) {
								updateWorkspace(workspace.id, {
									worktreeDir: wtPath,
									...(branch ? { branch } : {}),
								});
								workspace = { ...workspace, worktreeDir: wtPath, branch };
							}

							const bksId = `bks-${randomUUIDv7()}`;
							const title = prompt.trim().split("\n")[0].slice(0, 80);
							// Replace the raw first-line title with a short summary in the
							// background; next sessions poll (≤5s) picks it up. An
							// auto-created workspace is named ONCE from the same generated
							// summary (it provisionally wore the raw first line) and keeps
							// that name for life — later chats never rename it.
							const wsAutoNamed =
								!!workspace &&
								!!msg.createWorkspace &&
								!msg.createWorkspace.name;
							const wsToName = workspace;
							void ensureGeneratedTitle(bksId, prompt).then((t) => {
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
							const openingPrompt = withUploadsNote(
								prompt,
								stageFileAttachments(bksId, msg.files),
							);

							ws.send(
								JSON.stringify({ type: "stream_start", sessionId: bksId }),
							);

							let engineSessionId = "";
							let persisted = false;
							const persist = () => {
								const sessionData: BackstageSessionFile = {
									id: bksId,
									claudeSessionId: isCodex ? "" : engineSessionId,
									...(isCodex && engineSessionId
										? { codexThreadId: engineSessionId }
										: {}),
									...(model ? { model } : {}),
									branch: forkSource
										? forkSource.branch || ""
										: isAsk
											? ""
											: repo.sharedCheckout
												? repo.defaultBranch
												: workspace?.worktreeDir === wtPath
													? workspace.branch || branch
													: branch,
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
								};
								writeFileSync(
									`${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`,
									JSON.stringify(sessionData, null, 2),
								);
								sessionsCache = null;
								persisted = true;
							};

							for await (const event of runAgent({
								prompt: openingPrompt,
								cwd: wtPath,
								mode: isAsk ? "ask" : "code",
								model,
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
									// Persist immediately so the session is visible/shareable while running
									persist();
									ws.send(
										JSON.stringify({ type: "session_created", id: bksId }),
									);
								}
								if (event.type === "text_chunk") {
									// Direct send for the creator (not in the room until they watch),
									// room broadcast for everyone else — never both to the same socket
									ws.send(
										JSON.stringify({ type: "stream_text", text: event.text }),
									);
									broadcastToSession(
										bksId,
										{ type: "stream_text", text: event.text },
										ws,
									);
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
									ws.send(JSON.stringify({ type: "stream_tool_use", entry }));
									broadcastToSession(
										bksId,
										{ type: "stream_tool_use", entry },
										ws,
									);
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
									ws.send(
										JSON.stringify({ type: "stream_tool_result", entry }),
									);
									broadcastToSession(
										bksId,
										{ type: "stream_tool_result", entry },
										ws,
									);
								}
								if (event.type === "done") {
									engineSessionId = event.sessionId || engineSessionId;
								}
								if (event.type === "error") {
									ws.send(
										JSON.stringify({ type: "error", message: event.content }),
									);
								}
							}

							if (!persisted) persist();
							else
								touchBackstageSession(
									bksId,
									isCodex
										? { codexThreadId: engineSessionId }
										: { claudeSessionId: engineSessionId },
								);

							ws.send(JSON.stringify({ type: "stream_done" }));
							broadcastToSession(bksId, { type: "stream_done" }, ws);
							broadcastToSession(bksId, {
								type: "session_status",
								isRunning: false,
							});
							if (!promptQueues.get(bksId)?.length)
								onHumanAsksSessionIdle(bksId);
						} catch (e: any) {
							ws.send(
								JSON.stringify({
									type: "error",
									message: e.message || String(e),
								}),
							);
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
				}
			},

			close(ws) {
				allClients.delete(ws);
				stopAllWatchesForClient(ws);
				leaveSession(ws);
				leaveNote(ws);
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

	deliverToSession: async (id, content, user) => {
		const session = findSession(id);
		if (!session)
			return { status: "error" as const, message: "No session with that id." };
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
			if (
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
		clearSteerReceipts(id);
		const dropped = promptQueues.get(id)?.length || 0;
		if (dropped > 0) {
			promptQueues.delete(id);
			persistQueues();
			broadcastQueue(id);
		}
		return cancelled;
	},

	createSession: async ({ prompt, branch, mode, model: modelInput, user }) => {
		const isAsk = mode !== "code";
		const model = modelInput ? resolveModel(String(modelInput))?.id : undefined;
		const isCodex = providerFor(model) === "codex";

		let wtPath: string;
		if (isAsk) {
			wtPath = `${HOME}/projects/tella-fusion`;
		} else {
			const worktrees = await listWorktrees();
			wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
			if (!wtPath) wtPath = await createWorktree(branch!);
		}

		const bksId = `bks-${randomUUIDv7()}`;
		const title = prompt.trim().split("\n")[0].slice(0, 80);
		// Replace the raw first-line title with a short summary in the background;
		// the next sessions poll (≤5s) picks it up.
		void ensureGeneratedTitle(bksId, prompt).then((t) => {
			if (t) sessionsCache = null;
		});

		let engineSessionId = "";
		let persisted = false;
		const persist = () => {
			const sessionData: BackstageSessionFile = {
				id: bksId,
				claudeSessionId: isCodex ? "" : engineSessionId,
				...(isCodex && engineSessionId
					? { codexThreadId: engineSessionId }
					: {}),
				...(model ? { model } : {}),
				branch: isAsk ? "" : branch || "",
				worktreeDir: wtPath,
				createdBy: user || "Michael",
				createdAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				title,
				mode: isAsk ? "ask" : "code",
			};
			writeFileSync(
				`${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`,
				JSON.stringify(sessionData, null, 2),
			);
			sessionsCache = null;
			persisted = true;
		};

		// Run in the background; watchers (web UI) see the live stream, the same as
		// a UI-created session. The tool returns the id immediately.
		void (async () => {
			try {
				for await (const event of runAgent({
					prompt,
					cwd: wtPath,
					mode: isAsk ? "ask" : "code",
					model,
					inProcessMcp: interactiveMcpServers(user, bksId),
					confirmTools: STRIPE_CONFIRM_TOOLS,
					aws: true,
					user, // gate per-user MCP servers (allowedUsers) to the creator
					journal: { bksSessionId: bksId, kind: "create" },
					onAskUser: makeAskHandler(bksId),
				})) {
					if (event.type === "init") {
						engineSessionId = event.sessionId || "";
						persist();
					}
					if (event.type === "text_chunk") {
						broadcastToSession(bksId, {
							type: "stream_text",
							text: event.text,
						});
					}
					if (event.type === "tool_use") {
						broadcastToSession(bksId, {
							type: "stream_tool_use",
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
					if (event.type === "done") {
						engineSessionId = event.sessionId || engineSessionId;
					}
					if (event.type === "error") {
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
						isCodex
							? { codexThreadId: engineSessionId }
							: { claudeSessionId: engineSessionId },
					);
				broadcastToSession(bksId, { type: "stream_done" });
				broadcastToSession(bksId, { type: "session_status", isRunning: false });
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

	// Archive triage sessions when their Plain ticket is done
	startPlainArchiveSweep(() => {
		sessionsCache = null;
	});

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
