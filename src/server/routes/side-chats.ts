/**
 * Side chats: durable ask-mode side-conversations attached to a main session,
 * spawned from the session's right panel and @-mentionable back into the main
 * composer (recall is handled server-side in run-session.ts).
 *
 * A side chat IS a real OpenSession chat (its own session file + transcript),
 * created in ask mode (no worktree) sharing the parent's repo/projectId/model
 * and tagged `sideChatOf: <parentId>` so the sidebar suppresses it and recall
 * can scope @-mentions to the current session's own side chats.
 *
 * Two endpoints, mirroring routes/workspace.ts's new-chat shape for the mint.
 * Every handler returns a Response for a matched route or undefined to fall
 * through (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { SESSIONS_DIR, findSession, getCachedSessions, invalidateSessionsCache } from "../session-cache";
import { writeJsonAtomic } from "../shared/atomic-write";
import { type BackstageSessionFile } from "../types";
import { randomUUIDv7 } from "bun";

export async function handleSideChatsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;

	// Mint an ask-mode side chat of a parent session. Shares the parent's
	// repo/projectId/model; no worktree (ask mode). The first prompt starts the
	// transcript — nothing runs here.
	const createMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/side-chat$/,
	);
	if (createMatch && req.method === "POST") {
		const parentId = decodeURIComponent(createMatch[1]);
		const parent = findSession(parentId);
		if (!parent)
			return Response.json({ error: "Parent session not found" }, { status: 400 });
		const body = (await req.json().catch(() => ({}))) as {
			user?: string;
			title?: string;
		};
		const bksId = `bks-${randomUUIDv7()}`;
		const now = new Date().toISOString();
		// Deliberately NO projectId: a side chat must not join the parent's
		// workspace, or it double-surfaces everywhere that groups by workspace
		// (tab strip, archived history, "Add chat transcripts" chips, workspace
		// overview media) and blocks the auto-1:1 workspace's member-count
		// cleanup. It's listed solely by `sideChatOf` in its parent's panel. It
		// keeps the parent's `repo` so its ask-mode run reads the right repo.
		const data: BackstageSessionFile = {
			id: bksId,
			claudeSessionId: "",
			branch: "",
			worktreeDir: "",
			mode: "ask",
			sideChatOf: parentId,
			...(parent.repo ? { repo: parent.repo } : {}),
			...(parent.model ? { model: parent.model } : {}),
			createdBy: requestUser(ctx, body.user) || "Anonymous",
			createdAt: now,
			lastActivity: now,
			title: body.title || "Side chat",
		};
		writeJsonAtomic(`${SESSIONS_DIR}/${bksId}.json`, data);
		invalidateSessionsCache();
		// Return the full unified session so the client can render the new side
		// chat instantly (same contract as new-chat).
		return Response.json({ id: bksId, session: findSession(bksId) ?? null });
	}

	// List a session's side chats, newest first.
	const listMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/side-chats$/,
	);
	if (listMatch && req.method === "GET") {
		const parentId = decodeURIComponent(listMatch[1]);
		const chats = getCachedSessions()
			.filter((s) => s.sideChatOf === parentId)
			.sort(
				(a, b) =>
					new Date(b.lastActivity || b.createdAt).getTime() -
					new Date(a.lastActivity || a.createdAt).getTime(),
			);
		return Response.json({ chats });
	}

	return undefined;
}
