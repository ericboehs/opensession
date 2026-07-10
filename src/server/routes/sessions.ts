/**
 * Session listing, transcripts, transcript search/images, archive/title/status/review overrides, delete.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { cancelAgentRun, isAgentSessionBusy, stopAgentRunTurn } from "../agent-runner";
import { archiveOlderThan, setArchived, unpinArchivedSessions } from "../archive";
import { audit } from "../audit";
import { pendingAsks } from "../asks";
import { transcriptMatchSnippet } from "../jsonl-parser";
import { clearSessionFileArchive } from "../plain-archive";
import { editPrReviewers } from "../pr-info";
import { promptQueues, requeueSteerReceipts, stoppedSessions } from "../queue-state";
import { getReviewRequest, setReviewAccepted, setReviewRequest } from "../review-requests";
import { findSession, getCachedSessions, invalidateSessionsCache, runErrors } from "../session-cache";
import { resolvePrTarget } from "../session-repos";
import { destroySessionSandbox } from "../session-sandbox";
import { deleteSession, getAllSessions, mergedSessionTranscript } from "../sessions";
import { githubLoginFor } from "../shared/user-mappings";
import { isManualStatus, setStatusOverride } from "../status-overrides";
import { getSubagentTranscript } from "../subagents";
import { setTitleOverride } from "../title-overrides";
import { buildWorkspaceOverview, resolveTranscriptImage } from "../workspace-overview";
import { type Workspace, deleteWorkspace, getWorkspace } from "../workspaces";
import { removeWorktree, repoForPath } from "../worktree";
import { preparingWorkspaces } from "../ws-hub";
import { existsSync } from "fs";

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

export async function handleSessionsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

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
			audit({
				msg: "run_cancelled",
				bks_session_id: session.id,
				source: "archive",
				graceful: stopped,
			});
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
						const { sendPushToUser } = await import("../../server/push");
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
					const { sendPushToUser } = await import("../../server/push");
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

	return undefined;
}
