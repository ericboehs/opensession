#!/usr/bin/env bun

import { randomUUIDv7 } from "bun";
import { OPENSESSION_CHATS_DIR } from "./src/server/paths";
import { envAlias } from "./src/server/rename-compat";
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
	readEngineTranscript,
	mergedSessionTranscript,
	engineSessionPatch,
} from "./src/server/sessions";
import { isOpencodeSessionId } from "./src/server/opencode-transcript";
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
import { defaultRepo, productName } from "./src/server/config";
import {
	sandboxesEnabled,
	sandboxConfig,
	sandboxCapabilityStatus,
	sandboxProviderConfigured,
	resolveRequestedSandbox,
	isRunnableSandboxProvider,
	isRemoteSandboxProvider,
} from "./src/server/sandbox/config";
import {
	getSandboxProvider,
	workspaceExecFor,
	hasRemoteWorkspace,
	type Sandbox,
	type SandboxProviderId,
} from "./src/server/sandbox";
import { dockerContainerStatus } from "./src/server/sandbox/docker";
import type { RunHostSpec } from "./src/runner-host/protocol";
import { STRIPE_CONFIRM_TOOLS } from "./src/server/runner-shared";
import { activeRunRecords } from "./src/server/run-journal";
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
import type { ImageInput } from "./src/server/run-events";
import type { ActiveRunRecord } from "./src/server/run-journal";
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
	interactiveDefaultModel,
	getModelFallbackAuto,
	setModelFallbackAuto,
	refreshOpencodePickerModels,
} from "./src/server/models";
import {
	readOpencodeBridgeConfig,
	opencodeProviders,
	setOpencodeProvider,
	removeOpencodeProvider,
	addPickerModel,
	removePickerModel,
	maskProviderKey,
	PROVIDER_ID_RE,
	BRIDGE_PROVIDER_IDS,
} from "./src/server/opencode-config";
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
import { startPublicIngress } from "./src/server/public-ingress";
import {
	startSessionTerminal,
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
import { createMemoryMcpServer } from "./src/agents/slack/memory-tools";
import {
	addSessionMemory,
	describeScope,
	forgetSessionMemory,
	listAllMemory,
	renderSessionMemoryNote,
	sessionMemoryScopes,
	updateMemoryEntry,
} from "./src/server/session-memory";
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
import {
	refreshWarmTemplate,
	setWarmTemplateConfig,
	warmTemplateStatus,
} from "./src/server/warm-template";
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
	getAccountById,
	type ClaudeAccountPublic,
} from "./src/server/claude-accounts";
import { startWebhookServer } from "./src/server/webhook-server";
import type { AgentModule } from "./src/agents/types";
import type {
	UnifiedSession,
	BackstageSessionFile,
	AttachedRepo,
	SessionUsage,
	TranscriptEntry,
} from "./src/server/types";
import type { TurnUsage } from "./src/server/run-events";

// ── Extracted app modules (see src/server/…) ───────────────────────────────
import {
	BOOT_ID,
	allClients,
	broadcastToAll,
	sessionWatchers,
	preparingWorkspaces,
	joinSession,
	leaveSession,
	broadcastToSession,
	broadcastPresence,
	broadcastGlobalPresence,
	joinNote,
	leaveNote,
	broadcastToNote,
	broadcastNotePresence,
	noteWatchers,
	b64encode,
	b64decode,
	type WSClientData,
} from "./src/server/ws-hub";
import {
	invalidateSessionsCache,
	getCachedSessions,
	findSession,
	touchBackstageSession,
	maybePersistEffort,
	SESSION_EFFORTS,
	runErrors,
	recordRunOutcome,
} from "./src/server/session-cache";
import {
	type QueueItem,
	promptQueues,
	steeredReceipts,
	stoppedSessions,
	QUEUE_STORE,
	isGitHubQueueItem,
	queueItem,
	queueWithIds,
	persistQueues,
	broadcastQueue,
	recordSteer,
	clearSteerReceipts,
	requeueSteerReceipts,
	queuedPromptIndex,
	deleteQueuedPrompt,
	updateQueuedPrompt,
	reorderQueuedPrompt,
} from "./src/server/queue-state";
import {
	pendingAsks,
	makeAskHandler,
	type AskQuestionInput,
} from "./src/server/asks";
import {
	asDataUrlList,
	parseImageDataUrls,
	stageHttpUpload,
	stageFileAttachments,
	withUploadsNote,
	isWithinUploads,
	UPLOADS_DIR,
	MAX_UPLOAD_BYTES,
	WS_MAX_PAYLOAD_BYTES,
} from "./src/server/uploads";
import {
	buildBranchNote,
	buildReposNote,
	sessionRepoIds,
	buildSessionNote,
	memoryNoteFor,
	resolvePrTarget,
	workspaceOwningWorktree,
	attachRepo,
	switchPrimaryRepo,
} from "./src/server/session-repos";
import { interactiveMcpServers } from "./src/server/interactive-mcp";
import {
	enqueuePrompt,
	steerQueuedPrompt,
	interruptQueuedPrompt,
	drainQueue,
	runSessionPrompt,
	runSessionPromptAndDrain,
	restorePromptQueues,
	snapshotActiveSessions,
	resumeDrainedSessions,
	recordRecoveredRunEvent,
	attachSessionWatchersToTranscript,
	attachSessionWatchersToEngineTranscript,
	watchExternalRunAndDrain,
	abortTurnAndDrain,
	foldSessionUsage,
	autoPushSessionBranches,
	maybeLaunchSandboxedRun,
	sessionMentionsNote,
} from "./src/server/run-session";
import {
	destroySessionSandbox,
	activeSandboxFor,
} from "./src/server/session-sandbox";
import { handleSlashCommand } from "./src/server/slash-commands";
import { runGoal, runningGoals } from "./src/server/goal-runner";
import {
	routeHandlers,
	type RouteContext,
} from "./src/server/routes";

import {
	IS_DEV,
	FRONTEND_SRC,
	FRONTEND_DIST,
	frontend,
	spaEntry,
	buildFrontend,
	scheduleFrontendRebuild,
} from "./src/server/frontend-build";


const PORT = parseInt(process.env.PORT || "3850");
const HOST = process.env.HOST || "127.0.0.1";
const HOME = process.env.HOME || "/home/ubuntu";
const SESSIONS_DIR = OPENSESSION_CHATS_DIR;

mkdirSync(SESSIONS_DIR, { recursive: true });

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


// Loaded agents (Plain/Linear/Slack/Stripe/…). Module-scoped because request
// handlers (health routes) read it, and globalThis-backed so the set survives a
// hot reload (loadAgents runs only on a real boot, inside the guard below).
let agents: AgentModule[] = (g.__agents as AgentModule[] | undefined) ?? [];







console.log(`Starting Backstage server on ${HOST}:${PORT}...`);

// Reuse the listening server across hot reloads so existing WebSocket clients
// and in-flight runs survive a tweak; a fresh `bun run` just creates it once.
// On every hot re-evaluation the freshly evaluated handlers (routes/fetch/
// websocket) are swapped into the LIVE server via server.reload() — a bare
// `??=` binding would keep the first evaluation's closures serving forever,
// which is exactly how route edits silently stopped hot-applying.
function hotServe(
	options: Parameters<typeof Bun.serve<WSClientData>>[0],
): import("bun").Server<WSClientData> {
	const live = g.__backstageServer as
		| import("bun").Server<WSClientData>
		| undefined;
	if (!live) return (g.__backstageServer = Bun.serve<WSClientData>(options));
	try {
		// reload's declared type is narrower than the full serve options, but it
		// accepts (and swaps) routes/fetch/websocket at runtime.
		live.reload(options as any);
	} catch (e) {
		console.error(
			"[hot-reload] server.reload failed — old handlers keep serving:",
			e,
		);
	}
	return live;
}
const server: import("bun").Server<WSClientData> = hotServe({
		port: PORT,
		hostname: HOST,
		// The plain-triage route waits for worktree+session boot (~15-60s);
		// Bun's default 10s idleTimeout would drop the connection mid-wait
		idleTimeout: 240,

		// The SPA shell is served under BOTH the primary /opensession prefix and
		// the legacy /backstage alias (rename, docs/rename-opensession-plan.md).
		routes: Object.fromEntries(
			["/opensession", "/backstage"].flatMap((prefix) =>
				[
					"",
					"/",
					"/index.html",
					// Client-side routes must serve the SPA shell, not the raw file
					"/new",
					"/session/*",
					"/automations",
					"/security",
					"/goals",
					"/wiki",
					"/wiki/*",
					"/notes",
					"/notes/*",
					"/docs",
					"/docs/*",
					"/connections",
					"/settings",
					"/actions",
					"/archived",
					"/catchup",
					"/reviews",
					"/reviews/*",
					"/support/*",
				].map((p) => [prefix + p, spaEntry]),
			),
		),

		async fetch(req) {
			const url = new URL(req.url);
			// Rename alias (docs/rename-opensession-plan.md): /opensession/* is the
			// primary public prefix; every handler below matches the historical
			// /backstage/* literal, so the new prefix is normalized onto the old one
			// here — SAME handlers, no redirects (API/WS clients, PWA installs and
			// baked sandbox dial-back URLs on either prefix must keep working).
			// `publicPrefix` is the prefix THIS request used — responses that embed
			// it (sw.js scope, manifest start_url/icons, page redirects) answer in
			// kind so each install/bookmark stays self-consistent.
			let path = url.pathname;
			const publicPrefix =
				path === "/opensession" || path.startsWith("/opensession/")
					? "/opensession"
					: "/backstage";
			if (publicPrefix === "/opensession") {
				path = "/backstage" + path.slice("/opensession".length);
			}

			// Every API/asset route lives in src/server/routes/* — ordered domain
			// handlers that return undefined to fall through. Only the WebSocket
			// upgrades, the SPA fallback and the 404 stay here (they need `server`
			// or must run last).
			const ctx: RouteContext = { req, url, path, publicPrefix };
			for (const handler of routeHandlers) {
				const res = await handler(ctx);
				if (res) return res;
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
			// sandboxes dial back here instead of sharing unix sockets. BOTH
			// routes are gated BEFORE the upgrade on the run's per-launch
			// wsToken (hostId-keyed, registered only by ws-transport launches —
			// docker-ws / remote adapters), constant-time compared; rpc-ws
			// additionally needs ?host=<hostId>. Plain run-rpc tokens are NOT
			// network credentials: on a sandbox-less deployment the registry is
			// empty and every upgrade here is a 403. See src/server/run-ws.ts.
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
				// Hello frame: hands the client this process's bootId so a reconnect
				// can tell a real restart (bootId changed → "restarted" toast) from a
				// transient socket blip (unchanged → clear the reconnecting pill
				// silently). Clients on servers without this frame fall back to
				// polling /api/health, which also carries bootId.
				try {
					ws.send(JSON.stringify({ type: "hello", bootId: BOOT_ID }));
				} catch {}
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
							invalidateSessionsCache();
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
						// No in-band interrupt-and-steer (opencode runs, or a send carrying
						// files): queue the message durably, then abort the current turn so
						// the drain delivers it as the immediate next turn — esc+enter
						// semantics. If nothing is abortable either (external CLI/tmux run),
						// it stays queued for the natural stopping point, so nothing — text
						// or attachment — is lost.
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
							if (!abortTurnAndDrain(sessionId, session)) {
								watchExternalRunAndDrain(sessionId);
							}
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
						// Sandbox-aware: docker/daytona sessions get the shell INSIDE
						// their sandbox; host worktree shell otherwise (terminals.ts).
						void startSessionTerminal(ws, findSession(msg.sessionId), {
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
						// Pinned Claude subscription from the palette (forks inherit).
						// Soft pin: the runner prefers it and falls back to the pool when
						// it's exhausted. Unknown ids are dropped rather than erroring.
						const createAccountId = forkSource
							? forkSource.accountId
							: typeof msg.accountId === "string" &&
									msg.accountId &&
									getAccountById(msg.accountId)
								? msg.accountId
								: undefined;
						const createMcpServers = Array.isArray(msg.mcpServers)
							? msg.mcpServers.map(String)
							: undefined;
						// Which repo this session works in (tella-fusion by default).
						const repo = getRepo(
							typeof msg.repo === "string" ? msg.repo : undefined,
						);
						// Sandbox opt-in (docs/sandboxes-plan.md): boolean true = the
						// config's default provider (legacy toggle behavior); a string
						// names an explicit provider ("docker" | "daytona" | "e2b"),
						// validated against the current config. Forks never sandbox —
						// they share/fork the source session's engine state and cwd.
						const sandboxResolved = resolveRequestedSandbox(
							forkSource ? undefined : (msg.sandbox as boolean | string | undefined),
							repo.id,
							model,
						);
						if (!sandboxResolved.ok) {
							ws.send(
								JSON.stringify({ type: "error", message: sandboxResolved.error }),
							);
							return;
						}
						// null = host (no sandbox recorded on the session).
						const createSandboxProvider = sandboxResolved.provider;
						// Remote providers have no host mounts — always volume-style.
						const remoteSandbox = isRemoteSandboxProvider(createSandboxProvider);
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
									// sandbox — skip host createWorktree entirely. The session
									// keeps the canonical path; the provider's ensure()
									// materializes it on the opening run below. Docker only in
									// volume config; remote providers (daytona/e2b) always.
									if (
										createSandboxProvider &&
										sandboxesEnabled() &&
										(remoteSandbox ||
											(createSandboxProvider === "docker" &&
												sandboxConfig().workspace === "volume"))
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
								invalidateSessionsCache();
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
									...(createAccountId ? { accountId: createAccountId } : {}),
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
									...(createSandboxProvider
										? {
												sandbox: {
													provider: createSandboxProvider,
													// Volume intent is recorded up front so the prompt
													// paths know the workspace never exists host-side
													// (hasRemoteWorkspace) even before the first ensure.
													// Remote providers are ALWAYS volume — no host mounts.
													...(volumeWorkspace || remoteSandbox
														? { workspace: "volume" as const }
														: {}),
												},
											}
										: {}),
								};
								writeJsonAtomic(
									`${SESSIONS_DIR}/${bksId}.json`,
									sessionData,
								);
								invalidateSessionsCache();
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
										// Deps install runs in the background (worktree.ts) — say
										// so, since builds/tests may not be ready for a beat.
										emit({
											type: "notice",
											message:
												"Workspace ready — installing dependencies in the background.",
										});
									} finally {
										// Ready (or failed — the error surfaces separately): flip the
										// viewer out of "Waiting for workspace" and let the queue go.
										preparingWorkspaces.delete(bksId);
										emit({ type: "workspace_status", ready: true });
									}
								}

							// Sandbox session: route the OPENING turn through the same
							// launcher the prompt path uses (the session file was persisted
							// above, so it resolves) — bind mode included, so the first turn
							// runs in the sandbox like every later one (the worktree was
							// created above, so the bind mounts are ready; ensure() is
							// idempotent + per-session locked, and later prompts are held
							// behind markSessionStarting, so there's no double-ensure race).
							// Volume workspaces (docker volume mode / remote providers) have
							// no host dir: a failed launch errors the stream (announcedId is
							// set, so the catch below closes it out). Bind mode keeps the
							// host fallback — a failed launch runs this turn on the worktree.
							let sandboxOpeningRun: AsyncGenerator<StreamEvent> | null = null;
							if (createSandboxProvider) {
								const created = findSession(bksId);
								sandboxOpeningRun = created
									? await maybeLaunchSandboxedRun(created, {
											prompt: openingPrompt,
											cwd: wtPath,
											user,
											images,
											mcpServers: createMcpServers ?? [],
											isAutomationSession: false,
										})
									: null;
								if (!sandboxOpeningRun && (volumeWorkspace || remoteSandbox)) {
									throw new Error(
										"Sandbox unavailable for this volume-workspace session - the opening prompt was not run. Check sandbox config/kill-switch and retry.",
									);
								}
							}

							for await (const event of sandboxOpeningRun ?? runAgent({
								prompt: openingPrompt,
								cwd: wtPath,
								mode: isAsk ? "ask" : "code",
								model,
								effort: createEffort,
								accountId: createAccountId,
								fallbackModel: interactiveFallbackModel(model),
								mcpServers: createMcpServers,
								reposNote:
									[
										buildBranchNote({
											mode: isAsk ? "ask" : "code",
											branch: sessionBranch,
											worktreeDir: wtPath,
										}),
										await memoryNoteFor(user, [repo.id]),
									]
										.filter(Boolean)
										.join("\n\n") || undefined,
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
								// Persist the failure on the session file too — the live
								// events above are gone on reload, and a setup-failed session
								// (e.g. `git worktree add` refusing a branch name that
								// collides with an existing `name/...` ref) otherwise shows
								// as an inexplicably empty chat (bks-019f472f, 2026-07-09).
								recordRunOutcome(
									announcedId,
									`Session setup failed: ${e.message || String(e)}`,
								);
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
			envAlias("OPENSESSION_DEV", "BACKSTAGE_DEV") === "1"
				? {
						hmr: true,
						console: true,
					}
				: false,
});

console.log(`Backstage running at http://${HOST}:${PORT}/backstage/`);

// --- Session control surface (powers the opensession-sessions MCP) ---
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
		if (!s) return [];
		// Engine-spanning read (file + opencode store) — same as the transcript
		// route, so get_session works on opencode/migrated sessions too.
		return mergedSessionTranscript(s).slice(-Math.max(0, n));
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
		// opensession-sessions send_to_session tool.
		const notice = handleSlashCommand(session, String(content || "").trim(), user);
		if (notice !== null) {
			invalidateSessionsCache();
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
		// Sandbox opt-in: true = config default provider, or an explicit
		// provider id validated against the config — an unconfigured pick fails
		// the create loudly instead of silently running on the host.
		const sandboxResolved = resolveRequestedSandbox(sandbox, repo.id, model);
		if (!sandboxResolved.ok) throw new Error(sandboxResolved.error);
		const sandboxProvider = sandboxResolved.provider;
		const remoteSandbox = isRemoteSandboxProvider(sandboxProvider);
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
			if (t) invalidateSessionsCache();
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
				// Sandbox opt-in: the opening run below and every later prompt
				// route through maybeLaunchSandboxedRun for this provider.
				...(sandboxProvider
					? {
							sandbox: {
								provider: sandboxProvider,
								// Remote providers are always volume-style (no host mounts).
								...(remoteSandbox ? { workspace: "volume" as const } : {}),
							},
						}
					: {}),
			};
			writeJsonAtomic(`${SESSIONS_DIR}/${bksId}.json`, sessionData);
			invalidateSessionsCache();
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
				// Sandbox session: the OPENING turn routes through the same launcher
				// the prompt path uses (persist first so the session file resolves;
				// the worktree already exists — created above — so bind mounts are
				// ready). Bind mode falls back to a host run on launch failure;
				// remote providers (always volume) have no host fallback — fail the
				// opening turn with a clear error instead.
				let sandboxOpeningRun: AsyncGenerator<StreamEvent> | null = null;
				if (sandboxProvider) {
					if (!persisted) persist();
					const created = findSession(bksId);
					sandboxOpeningRun = created
						? await maybeLaunchSandboxedRun(created, {
								prompt: openingPrompt,
								cwd: wtPath,
								user,
								mcpServers,
								isAutomationSession: false,
							})
						: null;
					if (!sandboxOpeningRun && remoteSandbox) {
						runFailure =
							"Sandbox unavailable for this remote-sandbox session — the opening prompt was not run. Check sandbox config/kill-switch and retry.";
						broadcastToSession(bksId, {
							type: "error",
							sessionId: bksId,
							message: runFailure,
						});
						recordRunOutcome(bksId, runFailure);
						broadcastToSession(bksId, { type: "stream_done", sessionId: bksId });
						broadcastToSession(bksId, {
							type: "session_status",
							sessionId: bksId,
							isRunning: false,
						});
						return;
					}
				}
				for await (const event of sandboxOpeningRun ?? runAgent({
					prompt: openingPrompt,
					cwd: wtPath,
					mode: isAsk ? "ask" : "code",
					model,
					fallbackModel: interactiveFallbackModel(model),
					mcpServers,
					reposNote:
						[
							buildBranchNote({
								mode: isAsk ? "ask" : "code",
								branch: sessionBranch,
								worktreeDir: wtPath,
							}),
							await memoryNoteFor(user, [repo.id]),
						]
							.filter(Boolean)
							.join("\n\n") || undefined,
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
						// A sandbox session was persisted before launch and its file has
						// since been touched with the materialized sandboxId — a full
						// persist() here would rebuild from closure vars and wipe that.
						if (persisted)
							touchBackstageSession(bksId, {
								...engineSessionPatch(effectiveProvider, engineSessionId),
								...(effectiveModel ? { model: effectiveModel } : {}),
							});
						else persist();
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
						invalidateSessionsCache();
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
						invalidateSessionsCache();
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
	// Public dial-back ingress for remote sandboxes (src/server/public-ingress.ts):
	// a second, isolated listener serving ONLY the run-ws/rpc-ws upgrades +
	// /ingress-health. No-op unless ~/.opensession-sandbox.json enables
	// publicIngress; starting/stopping it or changing its port needs a real
	// restart (the config's other values stay read-fresh-per-run).
	try {
		startPublicIngress();
	} catch (e) {
		console.error("[public-ingress] failed to start:", e);
	}

	// Start webhook server with enabled agents + automation webhook triggers
	agents = await loadAgents();
	g.__agents = agents;
	const webhookServer = startWebhookServer(
		agents,
		getWebhookRoutes(() => {
			invalidateSessionsCache();
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
		invalidateSessionsCache();
	});
	setEventSessionCallback(() => {
		invalidateSessionsCache();
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
		invalidateSessionsCache();
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
			invalidateSessionsCache();
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
				invalidateSessionsCache();
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
							"opensession-goal-self": createGoalSelfMcpServer(session.goalId),
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
			invalidateSessionsCache();
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
				invalidateSessionsCache();
			}
			try {
				const removed = await sweepArchivedWorktrees(getAllSessions(), 14);
				if (removed.length > 0) {
					console.log(
						`[worktree-sweep] Removed ${removed.length} clean worktree(s): ${removed.join(", ")}`,
					);
					invalidateSessionsCache();
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
		// BOUNDED: an agent shutdown that awaits a flaky network call (e.g. the
		// Slack socket close during a Slack outage) used to hang here for the
		// whole TimeoutStopSec — the drain loop below never even started and
		// systemd SIGKILLed everything at 140s (observed 2026-07-09 10:15).
		for (const agent of agents) {
			const t0 = Date.now();
			try {
				const r = await Promise.race([
					Promise.resolve(agent.shutdown()).then(() => "ok" as const),
					new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
				]);
				if (r === "timeout") {
					console.warn(
						`[shutdown] ${agent.name} shutdown still pending after 10s — moving on`,
					);
				} else {
					console.log(`[shutdown] ${agent.name} stopped (${Date.now() - t0}ms)`);
				}
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
