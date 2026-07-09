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


// Loaded agents (Plain/Linear/Slack/Stripe/…). Module-scoped because request
// handlers (health routes) read it, and globalThis-backed so the set survives a
// hot reload (loadAgents runs only on a real boot, inside the guard below).
let agents: AgentModule[] = (g.__agents as AgentModule[] | undefined) ?? [];





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
				invalidateSessionsCache();
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
// Workspace users + label types for the Support UI's Assign/Labels menus —
// near-static, so cached long and shared by every open browser.
let plainUsersCache: { data: unknown[]; ts: number } | null = null;
let plainLabelTypesCache: { data: unknown[]; ts: number } | null = null;
const PLAIN_META_TTL = 5 * 60_000;

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
				// Non-media extensions are servable ONLY from the composer-uploads dir
				// (as a download) — anything wider would make this a read-any-file-on-
				// the-box endpoint (tokens live in dotfiles and json configs).
				const isUploadDownload = !mediaTypes[ext] && isWithinUploads(mediaPath);
				if (
					!mediaPath.startsWith("/") ||
					mediaPath.includes("..") ||
					!scoped ||
					(!mediaTypes[ext] && !isUploadDownload)
				) {
					return new Response("forbidden", { status: 403 });
				}
				const file = Bun.file(mediaPath);
				if (!(await file.exists()))
					return new Response("not found", { status: 404 });

				const type = mediaTypes[ext] || "application/octet-stream";
				const size = file.size;
				const range = req.headers.get("range");
				const baseHeaders: Record<string, string> = {
					"Content-Type": type,
					"Accept-Ranges": "bytes",
					"Cache-Control": "private, max-age=60",
					...(isUploadDownload
						? {
								"Content-Disposition": `attachment; filename="${mediaPath
									.split("/")
									.pop()
									?.replace(/[^\w. -]/g, "_")}"`,
							}
						: {}),
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

			// App icons (red yin-yang, gen by scripts/gen-icons.py) — real PNGs so iOS home-screen and PWA installs
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
						// Scope follows the prefix this registration lives under.
						"Service-Worker-Allowed": `${publicPrefix}/`,
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
			if (assetMatch && frontend) {
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
						name: productName(),
						short_name: productName(),
						// Per-prefix PWA identity: installs from the legacy /backstage
						// pages keep their identity; /opensession installs get the new
						// start_url. One re-install event max, never a broken one.
						start_url: `${publicPrefix}/`,
						display: "standalone",
						// On desktop, take over the OS titlebar: the window controls
						// overlay our own chrome instead of a separate OS bar with a
						// centered title. Falls back to plain standalone where WCO
						// isn't supported (iOS, older browsers). CSS handles the
						// controls inset + drag region under (display-mode:
						// window-controls-overlay).
						display_override: ["window-controls-overlay"],
						background_color: "#0b0809",
						theme_color: "#0b0809",
						icons: [
							{
								src: `${publicPrefix}/icon-192.png?v=4`,
								sizes: "192x192",
								type: "image/png",
								purpose: "any",
							},
							{
								src: `${publicPrefix}/icon.png?v=4`,
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
							? `${publicPrefix}/session/${sessionId}`
							: `${publicPrefix}/`,
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
				// Engine-spanning read: the transcript file plus, for sessions with
				// opencode history, the opencode store (covers legacy opencode
				// sessions from before transcript persistence, and migrated
				// sessions whose history spans engines).
				return Response.json(mergedSessionTranscript(session));
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
				invalidateSessionsCache(); // a review can change reviewDecision in the list
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
					invalidateSessionsCache(); // refresh prState in the sessions list
					return Response.json(result);
				} catch (e: any) {
					return Response.json(
						{ error: e.message || String(e) },
						{ status: 500 },
					);
				}
			}

			// Fire a GitHub PR agent behavior straight from the info panel — the same
			// actions the opensession-* PR labels / Slack @mentions kick off (review,
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
				invalidateSessionsCache();
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
				invalidateSessionsCache();
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
				invalidateSessionsCache();
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
				invalidateSessionsCache();
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
					invalidateSessionsCache();
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
				invalidateSessionsCache();
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
					invalidateSessionsCache();
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
					/** Sandbox opt-in: true = config default provider, or an explicit
					 *  provider id ("docker" | "daytona" | "e2b" — must be configured).
					 *  Recorded on the session file; the first prompt launches it. */
					sandbox?: boolean | string;
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
				// Sandbox opt-in: boolean true = config default provider; a string
				// must name a configured provider. A sibling chat's first prompt
				// launches the sandbox through the normal prompt path.
				const sandboxResolved = resolveRequestedSandbox(body.sandbox, repoId);
				if (!sandboxResolved.ok)
					return Response.json({ error: sandboxResolved.error }, { status: 400 });
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
					...(sandboxResolved.provider
						? {
								sandbox: {
									provider: sandboxResolved.provider,
									// Remote providers are always volume-style (no host mounts).
									...(isRemoteSandboxProvider(sandboxResolved.provider)
										? { workspace: "volume" as const }
										: {}),
								},
							}
						: {}),
				};
				writeJsonAtomic(`${SESSIONS_DIR}/${bksId}.json`, data);
				invalidateSessionsCache();
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

			// Quick status change on a Plain thread from the Support UI: Done
			// closes it, Todo (re)opens/unsnoozes it, Snoozed parks it. Human-gated
			// like the reply route — agent runs never see these paths as tools.
			const plainStatusMatch = path.match(
				/^\/backstage\/api\/plain\/threads\/([^/]+)\/status$/,
			);
			if (plainStatusMatch && req.method === "POST") {
				const threadId = decodeURIComponent(plainStatusMatch[1]);
				const body = (await req.json().catch(() => null)) as {
					status?: string;
					durationSeconds?: number;
					user?: string;
				} | null;
				const status = body?.status;
				if (status !== "todo" && status !== "done" && status !== "snoozed")
					return Response.json(
						{ error: "status must be todo, done or snoozed" },
						{ status: 400 },
					);
				try {
					const { setThreadStatus } = await import("./src/agents/plain/api");
					await setThreadStatus(
						threadId,
						status,
						typeof body?.durationSeconds === "number"
							? body.durationSeconds
							: undefined,
					);
					plainTodoCache = null; // the queue changed — next poll refetches
					console.log(
						`[plain-status] ${body?.user || "someone"} marked ${threadId} ${status}`,
					);
					return Response.json({ ok: true, status });
				} catch (e: any) {
					console.error(`[plain-status] ${status} on ${threadId} failed:`, e);
					return Response.json(
						{ error: e?.message || "Plain write failed" },
						{ status: 502 },
					);
				}
			}

			// Change a thread's priority (0 = Urgent … 3 = Low).
			const plainPriorityMatch = path.match(
				/^\/backstage\/api\/plain\/threads\/([^/]+)\/priority$/,
			);
			if (plainPriorityMatch && req.method === "POST") {
				const threadId = decodeURIComponent(plainPriorityMatch[1]);
				const body = (await req.json().catch(() => null)) as {
					priority?: number;
					user?: string;
				} | null;
				const priority = body?.priority;
				if (
					typeof priority !== "number" ||
					![0, 1, 2, 3].includes(priority)
				)
					return Response.json(
						{ error: "priority must be 0 (Urgent) … 3 (Low)" },
						{ status: 400 },
					);
				try {
					const { setThreadPriority } = await import(
						"./src/agents/plain/api"
					);
					await setThreadPriority(threadId, priority);
					plainTodoCache = null;
					console.log(
						`[plain-priority] ${body?.user || "someone"} set ${threadId} priority ${priority}`,
					);
					return Response.json({ ok: true, priority });
				} catch (e: any) {
					console.error(`[plain-priority] on ${threadId} failed:`, e);
					return Response.json(
						{ error: e?.message || "Plain write failed" },
						{ status: 502 },
					);
				}
			}

			// Mark the customer behind a thread as spam (or undo). Spam lives on
			// the customer in Plain — all their threads get filtered — so marking
			// also closes this thread to get it out of the Todo queue right away.
			const plainSpamMatch = path.match(
				/^\/backstage\/api\/plain\/threads\/([^/]+)\/spam$/,
			);
			if (plainSpamMatch && req.method === "POST") {
				const threadId = decodeURIComponent(plainSpamMatch[1]);
				const body = (await req.json().catch(() => null)) as {
					spam?: boolean;
					user?: string;
				} | null;
				const spam = body?.spam !== false;
				try {
					const { getThreadWithMessages, setCustomerSpam, setThreadStatus } =
						await import("./src/agents/plain/api");
					const thread = await getThreadWithMessages(threadId);
					const customerId = thread?.customer?.id;
					if (!customerId)
						return Response.json(
							{ error: "Thread has no customer" },
							{ status: 404 },
						);
					await setCustomerSpam(customerId, spam);
					// Plain closes the customer's threads itself on spam-mark (and
					// reopens on unmark) — this explicit close is a best-effort
					// belt-and-braces, so "already in the requested status" is fine.
					let closedThread = false;
					if (spam && thread?.status !== "DONE") {
						closedThread = await setThreadStatus(threadId, "done")
							.then(() => true)
							.catch((e) => {
								if (!/already in the requested status/i.test(e?.message || ""))
									console.error(
										`[plain-spam] Close after spam-mark failed for ${threadId}:`,
										e,
									);
								return false;
							});
					}
					plainTodoCache = null;
					console.log(
						`[plain-spam] ${body?.user || "someone"} ${spam ? "marked" : "unmarked"} customer ${customerId} (thread ${threadId}) as spam`,
					);
					return Response.json({ ok: true, spam, closedThread });
				} catch (e: any) {
					console.error(`[plain-spam] on ${threadId} failed:`, e);
					return Response.json(
						{ error: e?.message || "Plain write failed" },
						{ status: 502 },
					);
				}
			}

			// Workspace users for the Assign menu (alias accounts filtered out).
			if (path === "/backstage/api/plain/users" && req.method === "GET") {
				if (plainUsersCache && Date.now() - plainUsersCache.ts < PLAIN_META_TTL)
					return Response.json({ users: plainUsersCache.data });
				try {
					const { listWorkspaceUsers } = await import(
						"./src/agents/plain/api"
					);
					const users = await listWorkspaceUsers();
					plainUsersCache = { data: users, ts: Date.now() };
					return Response.json({ users });
				} catch (e: any) {
					console.error("[plain-users] List failed:", e);
					return Response.json(
						{ error: e?.message || "Plain lookup failed" },
						{ status: 502 },
					);
				}
			}

			// Active label types for the Labels menu.
			if (path === "/backstage/api/plain/label-types" && req.method === "GET") {
				if (
					plainLabelTypesCache &&
					Date.now() - plainLabelTypesCache.ts < PLAIN_META_TTL
				)
					return Response.json({ labelTypes: plainLabelTypesCache.data });
				try {
					const { listLabelTypes } = await import("./src/agents/plain/api");
					const labelTypes = await listLabelTypes();
					plainLabelTypesCache = { data: labelTypes, ts: Date.now() };
					return Response.json({ labelTypes });
				} catch (e: any) {
					console.error("[plain-label-types] List failed:", e);
					return Response.json(
						{ error: e?.message || "Plain lookup failed" },
						{ status: 502 },
					);
				}
			}

			// Assign a thread to a teammate (or unassign with userId: null).
			const plainAssignMatch = path.match(
				/^\/backstage\/api\/plain\/threads\/([^/]+)\/assign$/,
			);
			if (plainAssignMatch && req.method === "POST") {
				const threadId = decodeURIComponent(plainAssignMatch[1]);
				const body = (await req.json().catch(() => null)) as {
					userId?: string | null;
					user?: string;
				} | null;
				const userId =
					typeof body?.userId === "string" && body.userId ? body.userId : null;
				try {
					const { assignThreadToUser } = await import(
						"./src/agents/plain/api"
					);
					await assignThreadToUser(threadId, userId);
					console.log(
						`[plain-assign] ${body?.user || "someone"} ${
							userId ? `assigned ${threadId} to ${userId}` : `unassigned ${threadId}`
						}`,
					);
					return Response.json({ ok: true, userId });
				} catch (e: any) {
					console.error(`[plain-assign] on ${threadId} failed:`, e);
					return Response.json(
						{ error: e?.message || "Plain write failed" },
						{ status: 502 },
					);
				}
			}

			// Toggle labels on a thread: adds take label-type ids, removes take the
			// thread's label instance ids.
			const plainLabelsMatch = path.match(
				/^\/backstage\/api\/plain\/threads\/([^/]+)\/labels$/,
			);
			if (plainLabelsMatch && req.method === "POST") {
				const threadId = decodeURIComponent(plainLabelsMatch[1]);
				const body = (await req.json().catch(() => null)) as {
					addLabelTypeIds?: string[];
					removeLabelIds?: string[];
					user?: string;
				} | null;
				const add = Array.isArray(body?.addLabelTypeIds)
					? body.addLabelTypeIds.filter((x) => typeof x === "string" && x)
					: [];
				const remove = Array.isArray(body?.removeLabelIds)
					? body.removeLabelIds.filter((x) => typeof x === "string" && x)
					: [];
				if (!add.length && !remove.length)
					return Response.json(
						{ error: "Nothing to change" },
						{ status: 400 },
					);
				try {
					const { changeThreadLabels } = await import(
						"./src/agents/plain/api"
					);
					await changeThreadLabels(threadId, add, remove);
					console.log(
						`[plain-labels] ${body?.user || "someone"} changed labels on ${threadId} (+${add.length} −${remove.length})`,
					);
					return Response.json({ ok: true });
				} catch (e: any) {
					console.error(`[plain-labels] on ${threadId} failed:`, e);
					return Response.json(
						{ error: e?.message || "Plain write failed" },
						{ status: 502 },
					);
				}
			}

			// Rename a thread.
			const plainTitleMatch = path.match(
				/^\/backstage\/api\/plain\/threads\/([^/]+)\/title$/,
			);
			if (plainTitleMatch && req.method === "POST") {
				const threadId = decodeURIComponent(plainTitleMatch[1]);
				const body = (await req.json().catch(() => null)) as {
					title?: string;
					user?: string;
				} | null;
				const title = typeof body?.title === "string" ? body.title.trim() : "";
				if (!title)
					return Response.json({ error: "Empty title" }, { status: 400 });
				try {
					const { setThreadTitle } = await import("./src/agents/plain/api");
					await setThreadTitle(threadId, title.slice(0, 200));
					plainTodoCache = null; // titles show in the queue
					console.log(
						`[plain-title] ${body?.user || "someone"} renamed ${threadId}`,
					);
					return Response.json({ ok: true });
				} catch (e: any) {
					console.error(`[plain-title] on ${threadId} failed:`, e);
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
					invalidateSessionsCache();
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
				const message = addChatMessage(channel, user, text, images, {
					threadId: body?.threadId,
					replyTo: body?.replyTo,
				});
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
				const chatUrl = inSession
					? `/backstage/session/${encodeURIComponent(channel.slice("session:".length))}`
					: "/backstage/watercooler";
				const preview = text.length > 140 ? `${text.slice(0, 139)}…` : text;
				const mentioned = mentionedUsers(text, user);
				for (const name of mentioned) {
					void sendPushToUser(name, {
						title: inSession
							? `${user} mentioned you in a session chat`
							: `${user} mentioned you in the Watercooler`,
						body: preview,
						url: chatUrl,
						tag: `backstage-chat-${channel}`,
					});
				}
				// A thread reply also pings earlier thread participants (parent
				// author + repliers) — Slack semantics; explicit mentions above
				// already covered anyone tagged, so skip those.
				if (message.threadId) {
					const { threadUsers } = await import("./src/server/chat");
					const already = new Set(mentioned.map((n) => n.toLowerCase()));
					for (const name of threadUsers(channel, message.threadId)) {
						if (name.toLowerCase() === user.trim().toLowerCase()) continue;
						if (already.has(name.toLowerCase())) continue;
						void sendPushToUser(name, {
							title: inSession
								? `${user} replied in a session chat thread`
								: `${user} replied in a Watercooler thread`,
							body: preview || "🖼️ image",
							url: chatUrl,
							tag: `backstage-chat-${channel}`,
						});
					}
				}
				return Response.json({ message });
			}

			// Toggle an emoji reaction on a chat message. The updated message fans
			// out to every client (same broadcast pattern as new messages).
			if (path === "/backstage/api/chat/react" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				const user = typeof body?.user === "string" ? body.user.trim() : "";
				const messageId =
					typeof body?.messageId === "string" ? body.messageId : "";
				const emoji = typeof body?.emoji === "string" ? body.emoji : "";
				const channel =
					typeof body?.channel === "string" ? body.channel : "watercooler";
				const { toggleChatReaction, isValidChatChannel } = await import(
					"./src/server/chat"
				);
				if (!isValidChatChannel(channel) || !user || !messageId || !emoji)
					return Response.json({ error: "invalid reaction" }, { status: 400 });
				const message = toggleChatReaction(channel, messageId, emoji, user);
				if (!message)
					return Response.json({ error: "message not found" }, { status: 404 });
				broadcastToAll({ type: "chat_message_updated", channel, message });
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

			// ── Warm preview templates (per-repo prebuilt worktrees, scheduled) ──
			if (path === "/backstage/api/warm-templates" && req.method === "GET") {
				return Response.json({ repos: warmTemplateStatus() });
			}

			{
				const m = path.match(
					/^\/backstage\/api\/warm-templates\/([^/]+)(\/refresh)?$/,
				);
				if (m) {
					const repoId = decodeURIComponent(m[1]);
					if (!(repoId in REPOS))
						return Response.json(
							{ error: `unknown repo "${repoId}"` },
							{ status: 404 },
						);
					if (!m[2] && req.method === "PUT") {
						const body = await req.json().catch(() => null);
						if (!body)
							return Response.json({ error: "Invalid JSON" }, { status: 400 });
						const patch: Record<string, unknown> = {};
						if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
						if (
							typeof body.intervalHours === "number" &&
							body.intervalHours >= 1
						)
							patch.intervalHours = Math.floor(body.intervalHours);
						if (Array.isArray(body.warmRoutes))
							patch.warmRoutes = body.warmRoutes.filter(
								(r: unknown): r is string => typeof r === "string",
							);
						setWarmTemplateConfig(repoId, patch);
						return Response.json({ repos: warmTemplateStatus() });
					}
					if (m[2] && req.method === "POST") {
						// Fire-and-forget: a refresh boots a real dev server (minutes);
						// the UI polls GET for progress via `refreshing`.
						void refreshWarmTemplate(repoId, { force: true }).catch(() => {});
						return Response.json({ repos: warmTemplateStatus() });
					}
				}
			}

			// ── Memory (Settings → Memory: the same repo/user/team/channel stores
			// the opensession-memory tools + Slack channel memory read/write) ──
			if (path === "/backstage/api/memory") {
				if (req.method === "GET") {
					return Response.json({
						scopes: await listAllMemory(Object.keys(REPOS)),
					});
				}
				const body = await req.json().catch(() => null);
				const scope = body?.scopeKey ? describeScope(String(body.scopeKey)) : null;
				if (!scope)
					return Response.json(
						{ error: "unknown or invalid scopeKey" },
						{ status: 400 },
					);
				if (req.method === "POST") {
					const text = String(body?.text || "").trim();
					if (!text)
						return Response.json({ error: "text required" }, { status: 400 });
					const entry = await addSessionMemory(
						scope,
						text,
						String(body?.by || "settings"),
					);
					return Response.json({ entry });
				}
				if (req.method === "PUT") {
					const text = String(body?.text || "").trim();
					if (!text || !body?.id)
						return Response.json(
							{ error: "id and text required" },
							{ status: 400 },
						);
					const entry = await updateMemoryEntry(scope.key, String(body.id), text);
					if (!entry)
						return Response.json({ error: "entry not found" }, { status: 404 });
					return Response.json({ entry });
				}
				if (req.method === "DELETE") {
					if (!body?.id)
						return Response.json({ error: "id required" }, { status: 400 });
					const res = await forgetSessionMemory([scope], String(body.id));
					if (!res.ok)
						return Response.json({ error: res.error }, { status: 404 });
					return Response.json({ ok: true });
				}
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
						invalidateSessionsCache();
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
					invalidateSessionsCache();
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

			// ── Model providers (Settings → Model providers) ──
			// Third-party OpenCode providers (xai, openrouter, groq, …): API key +
			// optional baseURL in ~/.opensession-opencode.json (0600, keys only ever
			// returned masked), plus their picker model ids. anthropic/openai are
			// rejected — they run on the subscription bridges, not raw keys.
			if (
				path === "/backstage/api/settings/model-providers" &&
				req.method === "GET"
			) {
				const pickerModels = readOpencodeBridgeConfig()?.pickerModels || [];
				return Response.json({
					providers: Object.entries(opencodeProviders()).map(([id, p]) => ({
						id,
						apiKeyMasked: maskProviderKey(p.apiKey),
						...(p.baseURL ? { baseURL: p.baseURL } : {}),
						models: pickerModels.filter((m) =>
							m.startsWith(`opencode/${id}/`),
						),
					})),
					pickerModels,
				});
			}

			const modelProviderMatch = path.match(
				/^\/backstage\/api\/settings\/model-providers\/([^/]+)$/,
			);
			if (modelProviderMatch && req.method === "PUT") {
				const id = decodeURIComponent(modelProviderMatch[1]);
				if (!PROVIDER_ID_RE.test(id)) {
					return Response.json(
						{
							error:
								"Provider id must be lowercase letters, digits and dashes (e.g. xai, openrouter)",
						},
						{ status: 400 },
					);
				}
				if (BRIDGE_PROVIDER_IDS.has(id)) {
					return Response.json(
						{
							error: `"${id}" runs on the subscription bridges (Settings → Models), not a raw API key`,
						},
						{ status: 400 },
					);
				}
				const body = await req.json().catch(() => null);
				if (!body || typeof body !== "object") {
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				}
				const apiKey =
					typeof body.apiKey === "string"
						? // Strip all whitespace — pasted keys often carry line-wrap newlines.
							body.apiKey.replace(/\s+/g, "")
						: undefined;
				const baseURL =
					typeof body.baseURL === "string" ? body.baseURL.trim() : undefined;
				const models = Array.isArray(body.models)
					? body.models.filter(
							(m: unknown): m is string => typeof m === "string",
						)
					: undefined;
				try {
					setOpencodeProvider(id, { apiKey, baseURL });
					if (models) {
						// `models` replaces this provider's picker entries wholesale.
						const prefix = `opencode/${id}/`;
						for (const m of readOpencodeBridgeConfig()?.pickerModels || []) {
							if (m.startsWith(prefix)) removePickerModel(m);
						}
						for (const m of models) {
							// Accept "grok-4", "xai/grok-4" or "opencode/xai/grok-4".
							let tail = m.trim();
							if (tail.startsWith("opencode/"))
								tail = tail.slice("opencode/".length);
							if (tail.startsWith(`${id}/`)) tail = tail.slice(id.length + 1);
							if (tail) addPickerModel(`${prefix}${tail}`);
						}
					}
					refreshOpencodePickerModels();
					const stored = opencodeProviders()[id] || {};
					const pickerModels = readOpencodeBridgeConfig()?.pickerModels || [];
					return Response.json({
						provider: {
							id,
							apiKeyMasked: maskProviderKey(stored.apiKey),
							...(stored.baseURL ? { baseURL: stored.baseURL } : {}),
							models: pickerModels.filter((m) =>
								m.startsWith(`opencode/${id}/`),
							),
						},
					});
				} catch (e: any) {
					return Response.json(
						{ error: e?.message || "Failed to save provider" },
						{ status: 400 },
					);
				}
			}

			if (modelProviderMatch && req.method === "DELETE") {
				const id = decodeURIComponent(modelProviderMatch[1]);
				try {
					const removed = removeOpencodeProvider(id);
					const prefix = `opencode/${id}/`;
					let cleared = 0;
					for (const m of readOpencodeBridgeConfig()?.pickerModels || []) {
						if (m.startsWith(prefix)) {
							removePickerModel(m);
							cleared++;
						}
					}
					refreshOpencodePickerModels();
					if (!removed && !cleared) {
						return Response.json({ error: "Not found" }, { status: 404 });
					}
					return Response.json({ ok: true });
				} catch (e: any) {
					return Response.json(
						{ error: e?.message || "Failed to remove provider" },
						{ status: 500 },
					);
				}
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
				// Single-engine core: the picker surfaces ONLY opencode models.
				// Native claude/codex ids stay resolvable + executable (the direct
				// Slack/Linear/Plain agent loops still run them on the SDK), just
				// not selectable here. Guard: with opencode not configured, fall
				// back to the full registry so the picker is never empty.
				const opencodeOnly = KNOWN_MODELS.filter((m) => m.provider === "opencode");
				const opencodeConfigured = opencodeOnly.length > 0;
				return Response.json({
					models: opencodeConfigured ? opencodeOnly : KNOWN_MODELS,
					default: opencodeConfigured ? interactiveDefaultModel() : getDefaultModel(),
					autoFallback: getModelFallbackAuto(),
				});
			}

			// Sandbox capability status for the session-create provider picker:
			// {enabled, defaultProvider, providers: [{id, configured, note?}],
			// killSwitch}. Read fresh from ~/.opensession-sandbox.json + the
			// kill-switch file on every call, so a config flip shows up on the
			// next fetch. Behavior is unit-tested via sandboxCapabilityStatus()
			// (src/server/sandbox/capability-status.test.ts).
			if (path === "/backstage/api/sandbox/status" && req.method === "GET") {
				return Response.json(sandboxCapabilityStatus());
			}

			// Warm-on-typing sandbox prewarm (src/server/sandbox/prewarm.ts):
			// the New-session palette POSTs {provider, repo, user} on the first
			// keystroke (and ~every 60s while typing) with a REMOTE provider
			// selected, so the 30-45s runner bootstrap runs while the prompt is
			// being written; the create's ensure() then ADOPTS the warmed
			// sandbox. Cheap + idempotent (a live prewarm is just TTL-touched),
			// rate-limited per user, and validation lives in requestPrewarm —
			// unknown provider/repo answer {state:"unsupported"}, no-remote
			// setups {state:"disabled"}. Frontend swallows every failure.
			if (path === "/backstage/api/sandbox/prewarm" && req.method === "POST") {
				const body = await req.json().catch(() => null);
				const provider = typeof body?.provider === "string" ? body.provider : "";
				const repoId = typeof body?.repo === "string" ? body.repo : "";
				const user = typeof body?.user === "string" && body.user ? body.user : "anon";
				const { requestPrewarm, prewarmRateLimited } = await import(
					"./src/server/sandbox/prewarm"
				);
				if (prewarmRateLimited(user)) {
					return Response.json({ state: "rate-limited" }, { status: 429 });
				}
				return Response.json(await requestPrewarm(provider, repoId, user));
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
							: `${envAlias("OPENSESSION_UI_BASE", "MICHAEL_UI_BASE") || "https://michael.taila5d766.ts.net/backstage"}/session/<this-session>`,
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
