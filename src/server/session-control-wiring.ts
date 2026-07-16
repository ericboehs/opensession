/**
 * Wires the SessionControl registry (src/server/session-control.ts) — the
 * surface behind the opensession-sessions MCP — into the same in-process state and
 * helpers the WebSocket handlers use, so a management session lists/steers/
 * answers/creates exactly like a human in the web UI. Also keeps the linked
 * Slack-channel index + inbound-message bridge fresh. Module-scope side
 * effects: re-run on every hot reload (cheap, and keeps closures current).
 */

import { type StreamEvent, cancelAgentRun, isAgentSessionBusy, runAgent, steerAgentRun } from "./agent-runner";
import { makeAskHandler, pendingAsks } from "./asks";
import { ensureGeneratedTitle } from "./generated-titles";
import { onSessionIdle as onHumanAsksSessionIdle } from "./human-asks";
import { interactiveMcpServers } from "./interactive-mcp";
import { dialPreset, interactiveFallbackModel, modelLabel, providerFor, resolveModel } from "./models";
import { promptQueues, recordSteer, requeueSteerReceipts } from "./queue-state";
import { attachSessionWatchersToEngineTranscript, attachSessionWatchersToTranscript, enqueuePrompt, foldSessionUsage, maybeLaunchSandboxedRun, runSessionPrompt, runSessionPromptAndDrain, sessionMentionsNote, watchExternalRunAndDrain } from "./run-session";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { type Sandbox } from "./sandbox";
import { isRemoteSandboxProvider, resolveRequestedSandbox } from "./sandbox/config";
import { SESSIONS_DIR, findSession, getCachedSessions, invalidateSessionsCache, recordRunOutcome, touchBackstageSession } from "./session-cache";
import { type SessionState, type SessionSummary, registerSessionControl } from "./session-control";
import { buildBranchNote, memoryNoteFor, workspaceOwningWorktree } from "./session-repos";
import { engineSessionPatch, engineUserTexts, getAllSessions, mergedSessionTranscript } from "./sessions";
import { writeJsonAtomic } from "./shared/atomic-write";
import { rebuildIndex } from "./slack-links";
import { handleSlashCommand } from "./slash-commands";
import { type BackstageSessionFile, type SessionUsage, type UnifiedSession } from "./types";
import { type Workspace, createWorkspace, getWorkspace } from "./workspaces";
import { createWorktree, getRepo, listWorktrees, repoForPath } from "./worktree";
import { broadcastToAll, broadcastToSession } from "./ws-hub";
import { randomUUIDv7 } from "bun";
import { existsSync, watch } from "fs";

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

// --- Session control surface (powers the opensession-sessions MCP) ---
// Wire the Slack thread index (thread replies → owning session). Re-run on
// every hot reload (cheap) so the index stays fresh.
rebuildIndex(getAllSessions());

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
			// behind the run instead of interrupting it. Slack-thread replies also
			// never steer: the in-thread answer mirror only fires on a turn that
			// carries the slackReplyTo, and a steered message can't (it folds into
			// a turn that's already running).
			if (
				opts?.busy !== "queue" &&
				!opts?.slackReplyTo &&
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
			enqueuePrompt(id, { content, user, slackReplyTo: opts?.slackReplyTo });
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
		void runSessionPromptAndDrain(
			id,
			content,
			user,
			undefined,
			undefined,
			undefined,
			opts?.slackReplyTo,
		).catch((e) => console.error(`[sessions-mcp] deliver to ${id} failed:`, e));
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
		requeueSteerReceipts(id, engineUserTexts(session));
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
		const parentWorkspace =
			parentSession?.projectId
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
						// Dial-preset sessions keep `dial/<tier>` as their stored model —
						// init reports the preset's resolved MAIN model, and adopting it
						// would disengage the dial (oracle + effort) on the next turn.
						// model_switch below still adopts: a real fallback ends the dial.
						if (event.model && !dialPreset(model)) effectiveModel = event.model;
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
						// Same dial guard as the init handler above.
						if (event.model && !dialPreset(model)) effectiveModel = event.model;
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
						if (event.cacheMissWarning) {
							broadcastToSession(bksId, {
								type: "cache_warning",
								sessionId: bksId,
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
				if (!promptQueues.get(bksId)?.length) {
					onHumanAsksSessionIdle(bksId);
				}
			} catch (e) {
				console.error(`[sessions-mcp] create session ${bksId} failed:`, e);
			}
		})();

		return { id: bksId };
	},
});
