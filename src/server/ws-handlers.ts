/**
 * The UI WebSocket: watch/unwatch sessions, live prompts and queue control,
 * question answers, terminals, collaborative notes, chat typing — plus the
 * create_session flow. Extracted verbatim from opensession.ts; sandbox
 * transport sockets are delegated to run-ws.ts before any of this runs.
 */

import type { WebSocketHandler } from "bun";
import type { WSClientData } from "./ws-hub";
import { type StreamEvent, cancelAgentRun, interruptAndSteerAgentRun, isAgentSessionBusy, markSessionStarting, runAgent, steerAgentRun, stopAgentRunTurn, unmarkSessionStarting } from "./agent-runner";
import { audit } from "./audit";
import { makeAskHandler, pendingAsks } from "./asks";
import { getAccountById } from "./claude-accounts";
import { startWatching, stopAllWatchesForClient } from "./file-watcher";
import { buildForkHandoffNote } from "./fork-handoff";
import { ensureGeneratedTitle } from "./generated-titles";
import { onSessionIdle as onHumanAsksSessionIdle } from "./human-asks";
import { interactiveMcpServers } from "./interactive-mcp";
import { INIT_WIRE_CLAMP_BYTES, clampEntriesForWire, parseTranscript, parseTranscriptTail, parseTranscriptWindow } from "./jsonl-parser";
import { interactiveDefaultModel, interactiveFallbackModel, modelLabel, modelPreset, providerFor, resolveModel } from "./models";
import { applyNoteUpdate, getNoteState, isValidNoteId } from "./notes";
import { appendOpencodeTranscript, transcriptLineRunnerNotice } from "./opencode-transcript";
import { wrapContext } from "./prompt-context";
import { deleteQueuedPrompt, persistQueues, promptQueues, queueWithIds, recordSteer, reorderQueuedPrompt, requeueSteerReceipts, steeredReceipts, stoppedSessions, updateQueuedPrompt } from "./queue-state";
import { transitionRunState } from "./run-state";
import { abortTurnAndDrain, attachSessionWatchersToEngineTranscript, drainQueue, enqueuePrompt, foldSessionUsage, interruptQueuedPrompt, maybeLaunchSandboxedRun, runSessionPrompt, runSessionPromptAndDrain, sessionMentionsNote, steerQueuedPrompt, watchExternalRunAndDrain } from "./run-session";
import { sandboxWsClose, sandboxWsMessage, sandboxWsOpen } from "./run-ws";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { type Sandbox, hasRemoteWorkspace } from "./sandbox";
import { isRemoteSandboxProvider, resolveRequestedSandbox, sandboxConfig, sandboxesEnabled } from "./sandbox/config";
import { SESSIONS_DIR, SESSION_EFFORTS, findSession, invalidateSessionsCache, maybePersistEffort, recordRunOutcome, touchBackstageSession } from "./session-cache";
import { buildBranchNote, memoryNoteFor, workspaceOwningWorktree } from "./session-repos";
import { engineSessionPatch, engineUserTexts, mergedSessionTranscript } from "./sessions";
import { writeJsonAtomic } from "./shared/atomic-write";
import { handleSlashCommand } from "./slash-commands";
import { resizeTerminal, startSessionTerminal, stopTerminal, writeTerminal } from "./terminals";
import { type BackstageSessionFile, type SessionUsage } from "./types";
import { MAX_UPLOAD_BYTES, WS_MAX_PAYLOAD_BYTES, asDataUrlList, parseImageDataUrls, stageFileAttachments, withUploadsNote } from "./uploads";
import { type Workspace, createWorkspace, getWorkspace, updateWorkspace } from "./workspaces";
import { createWorktree, createWorktreeForExistingBranch, getRepo, listWorktrees, repoForPath, resolveUniqueBranch, worktreeHeadBranch, worktreePathFor } from "./worktree";
import { BOOT_ID, allClients, b64decode, b64encode, broadcastToNote, broadcastToSession, joinNote, joinSession, leaveNote, leaveSession, preparingWorkspaces } from "./ws-hub";
import { randomUUIDv7 } from "bun";
import { readFileSync, watch } from "fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	cloudWebSocketClientClosed,
	routeCloudWebSocketMessage,
} from "./cloud-proxy";
import {
	closeCloudProxyProtocol,
	handleCloudProxyProtocolMessage,
} from "./cloud-proxy-protocol";

// Who likely triggered the restart that booted THIS process — read once from
// the marker the previous process wrote in gracefulShutdown, and only trusted
// when the shutdown was recent (a stale marker from days ago means this boot
// wasn't that restart). Parked on globalThis so hot reloads keep the value.
function lastRestartBy(): string {
	const g = globalThis as any;
	if (g.__lastRestartBy === undefined) {
		g.__lastRestartBy = "";
		try {
			const d = JSON.parse(
				readFileSync(join(homedir(), ".opensession-last-restart.json"), "utf8"),
			);
			if (d?.by && Date.now() - Date.parse(d.at) < 10 * 60_000)
				g.__lastRestartBy = String(d.by);
		} catch {}
	}
	return g.__lastRestartBy;
}

export const websocketHandlers: WebSocketHandler<WSClientData> = {
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
		// polling /api/health, which also carries bootId. `restartBy` names the
		// session that likely triggered the restart (marker written by the OLD
		// process's shutdown — see gracefulShutdown) so the toast can say who.
		try {
			ws.send(
				JSON.stringify({
					type: "hello",
					bootId: BOOT_ID,
					...(lastRestartBy() ? { restartBy: lastRestartBy() } : {}),
				}),
			);
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

		// GitHub web sign-in active (web-auth.ts): the upgrade stamped this
		// socket with the cookie's verified identity — it overrides whatever
		// name the client claims in any message, so attribution and per-user
		// gating stop trusting self-declared users.
		if (ws.data?.authUser) msg.user = ws.data.authUser;
		if (
			await handleCloudProxyProtocolMessage(
				ws,
				msg,
				(lane, payload) => websocketHandlers.message?.(lane, payload),
				(lane) => websocketHandlers.close?.(lane, 1000, "cloud proxy lane closed"),
			)
		) {
			return;
		}
		if (routeCloudWebSocketMessage(ws, msg)) return;

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
				//
				// Two-stage init: ship the last screenful immediately (the spinner
				// ends as soon as the viewport can fill), then the rest of the tail a
				// beat later as a `transcript_history` prepend — two small JSON.parses
				// and a ~12-bubble first render instead of one 40-90 bubble wall.
				// Both use the tighter INIT wire clamp: the UI eagerly renders only
				// ~6KB of markdown per bubble and fetches the full entry on demand,
				// so the fat 32KB clamp only bought transfer time (a heavy tail hit
				// 1.7MB on the wire). `startOffset` is the pagination cursor for
				// "load earlier".
				let { entries, truncated, endOffset, startOffset } = session.transcriptPath
					? parseTranscriptTail(session.transcriptPath)
					: { entries: [], truncated: false, endOffset: 0, startOffset: 0 };
				if (!entries.length) {
					// No mirror file yet — a fresh session, or an engine-id rotation
					// whose next run hasn't seeded the new id's file. Without this the
					// thread renders blank until the next send (which seeds the file);
					// serve history via the cross-engine fallback (old transcript file
					// merged with OpenCode's SQLite store) instead. No byte cursor into
					// a file here, so no "load earlier" paging — the next run's seeded
					// file restores it.
					const merged = mergedSessionTranscript(session);
					if (merged.length) {
						truncated = merged.length > 120;
						entries = truncated ? merged.slice(-120) : merged;
						startOffset = 0;
					}
				}
				const FIRST_PAINT_ENTRIES = 12;
				const staged = entries.length > FIRST_PAINT_ENTRIES;
				const head = staged ? entries.slice(-FIRST_PAINT_ENTRIES) : entries;
				const rest = staged ? entries.slice(0, -FIRST_PAINT_ENTRIES) : [];
				ws.send(
					JSON.stringify({
						type: "transcript_init",
						sessionId,
						entries: clampEntriesForWire(head, INIT_WIRE_CLAMP_BYTES),
						truncated,
						startOffset,
					}),
				);
				if (rest.length) {
					// Small delay so the client paints the first screenful before the
					// bulk arrives; ids dedupe on the client, so overlap is harmless.
					const restPayload = JSON.stringify({
						type: "transcript_history",
						sessionId,
						entries: clampEntriesForWire(rest, INIT_WIRE_CLAMP_BYTES),
						truncated,
						startOffset,
					});
					setTimeout(() => {
						try {
							if (ws.data?.watchingSessionId === sessionId) ws.send(restPayload);
						} catch {}
					}, 80);
				}

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
				// "Load earlier history": one PAGE of history — the byte window just
				// before the client's earliest offset (`beforeOffset`, threaded from
				// transcript_init/transcript_history startOffset). The old behavior
				// (re-send the ENTIRE transcript) hit ~15MB wire payloads and a
				// 600-bubble render on big transcripts; it survives only as the
				// fallback for clients that don't send an offset.
				const session = findSession(msg.sessionId);
				if (!session?.transcriptPath) {
					// Same no-mirror-file state as the watch fallback: serve the merged
					// cross-engine history rather than blanking the client's view.
					ws.send(
						JSON.stringify({
							type: "transcript_init",
							sessionId: msg.sessionId,
							entries: session
								? clampEntriesForWire(mergedSessionTranscript(session))
								: [],
							truncated: false,
						}),
					);
					return;
				}
				const before =
					typeof msg.beforeOffset === "number" && msg.beforeOffset > 0
						? msg.beforeOffset
						: null;
				if (before !== null) {
					// ~40 entries per page; the 1MB soft window cap bounds the server
					// read through fat tool-result regions, but the parser still
					// guarantees ≥10 entries per page (see parseTranscriptWindow) —
					// 2-entry pages made "load earlier" feel broken and kept the
					// infinite-scroll sentinel in range, chaining loads every ~1.6s.
					const page = parseTranscriptWindow(
						session.transcriptPath,
						before,
						undefined,
						40,
						1024 * 1024,
					);
					ws.send(
						JSON.stringify({
							type: "transcript_history",
							sessionId: msg.sessionId,
							entries: clampEntriesForWire(page.entries, INIT_WIRE_CLAMP_BYTES),
							truncated: page.truncated,
							startOffset: page.startOffset,
						}),
					);
					break;
				}
				const entries = parseTranscript(session.transcriptPath);
				ws.send(
					JSON.stringify({
						type: "transcript_init",
						sessionId: msg.sessionId,
						entries: clampEntriesForWire(entries),
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
						// A stopped run's only trace is the runner's anonymous
						// "cancelled" turn event — record who pulled the plug (stop
						// button / Esc), or diagnosing "why did it go silent?" means
						// inferring the gesture by elimination.
						console.log(
							`[ws] run stopped on ${sessionId} by ${data.user || "unknown"} (${stopped ? "graceful" : "hard-cancel"})`,
						);
						audit({
							msg: "run_cancelled",
							bks_session_id: sessionId,
							source: "ui_stop",
							user: data.user,
							graceful: stopped,
						});
						transitionRunState(sessionId, "cancel", {
							source: "ui_stop",
							user: data.user,
						});
						// Durable trace in the transcript too: a stopped turn otherwise
						// just goes silent mid-tool-call, and readers can't tell a
						// deliberate stop from a crash (the audit line answers it for
						// Michael, this chip answers it for everyone reading the UI).
						if (session.claudeSessionId) {
							try {
								appendOpencodeTranscript(session.claudeSessionId, [
									transcriptLineRunnerNotice(
										`Turn stopped by ${data.user || "someone"} (stop button / Esc).`,
									),
								]);
							} catch {}
						}
					}
					const requeued = requeueSteerReceipts(
						sessionId,
						session ? engineUserTexts(session) : undefined,
					);
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
				const { prompt, user, mode } = msg;
				// Mutable: a brand-new code branch is made collision-free below (a
				// name clashing with an existing `name/...` ref — or vice versa —
				// makes `git worktree add -b` fail, killing the session).
				let branch = msg.branch;
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
				// A fork inherits the source's model. No pick = stamp the interactive
				// default NOW: leaving it empty would let the init event persist the
				// engine's resolved model — which for a dial default would silently
				// disengage the dial (the preset id must be what the session stores).
				const model = forkSource
					? forkSource.model
					: (msg.model ? resolveModel(String(msg.model))?.id : undefined) ||
						interactiveDefaultModel();
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
				// names an explicit provider (including "modal" / "lambda-microvm"),
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
							// A genuinely new branch: dodge ref-hierarchy collisions
							// (e.g. requested `test` while `test/foo` already exists)
							// before we bake the name into the path + session file.
							if (branch)
								branch = await resolveUniqueBranch(branch, repo.id);
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
								await import("../agents/plain/api");
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
					// Actual worktree HEAD when it drifted from the recorded branch
					// (the agent switched/renamed branches during the opening turn).
					const headBranchPatch = () => {
						const head = sessionBranch ? worktreeHeadBranch(wtPath) : null;
						return head && head !== sessionBranch ? { branch: head } : {};
					};
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
							...headBranchPatch(),
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
							...(ws.data?.authLogin
								? { createdByLogin: ws.data.authLogin }
								: {}),
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
							// Dial sessions keep `dial/<tier>` stored — init/done report the
							// preset's resolved MAIN model; adopting it would disengage the
							// dial next turn. model_switch still adopts (real fallback).
							if (event.model && !modelPreset(model)) effectiveModel = event.model;
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
							const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
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
							if (event.model && !modelPreset(model)) effectiveModel = event.model;
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
							if (event.cacheMissWarning)
								emit({ type: "cache_warning", sessionId: bksId });
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
								// The opening turn may have switched branches in the
								// worktree (same sync as runSessionPromptInner's run-end
								// patch) — keep the record on the actual HEAD.
								...headBranchPatch(),
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
		closeCloudProxyProtocol(ws, (lane) =>
			websocketHandlers.close?.(lane, 1000, "cloud proxy disconnected"),
		);
		cloudWebSocketClientClosed(ws);
		allClients.delete(ws);
		stopAllWatchesForClient(ws);
		leaveSession(ws);
		leaveNote(ws);
		stopTerminal(ws); // the Shell tab's PTY dies with its socket
		console.log("WebSocket client disconnected");
	},
};
