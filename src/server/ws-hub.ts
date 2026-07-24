/**
 * WebSocket fan-out hub: which sockets are watching which session/note, and
 * every broadcast primitive built on that. Pure client/presence state — no
 * run or queue logic lives here (see queue-state.ts / run-session.ts).
 *
 * All live state is parked on globalThis (same keys as always) so a
 * `bun --hot` reload keeps every connected client and watcher set intact.
 */

import { appendSessionFeed, isFeedEvent } from "./session-feed";

const g = globalThis as any;

// Unique per OS process (survives hot reloads, changes on a real restart) so
// clients can tell a fresh instance from a draining one and reload at the right
// moment. Every connected WebSocket is also tracked so we can warn them all
// before the process goes down for a deploy.
export const BOOT_ID: string = (g.__bootId ??= crypto.randomUUID());
export const allClients: Set<any> = (g.__allClients ??= new Set());

/** Close retained UI sockets that no longer belong to the verified local user. */
export function revalidateLocalClients(
	identity: { login: string; name: string } | null,
): number {
	let closed = 0;
	for (const ws of allClients) {
		if (identity && ws.data?.authLogin === identity.login) {
			ws.data.authUser = identity.name;
			ws.data.user = identity.name;
			continue;
		}
		closed++;
		try {
			ws.close(4001, "Hosted GitHub session expired");
		} catch {}
	}
	return closed;
}

export function broadcastToAll(msg: object) {
	const payload = JSON.stringify(msg);
	for (const ws of allClients) {
		try {
			ws.send(payload);
		} catch {}
	}
}

// WebSocket client state
export interface WSClientData {
	watchingSessionId: string | null;
	/** Hosted session watched through the local profile's shared cloud lane. */
	cloudWatchingSessionId?: string | null;
	/** Stable virtual-client lane on the one hosted WebSocket connection. */
	cloudLaneId?: string | null;
	/** termIds of shell tabs currently proxied to the cloud upstream. */
	cloudTermIds?: Set<string> | null;
	/** Hosted-side authorization for the virtual-client multiplex protocol. */
	cloudProxy?: boolean;
	cloudProxyLanes?: Map<string, any>;
	watchingNoteId: string | null;
	user: string | null;
	/** Verified sign-in identity stamped at upgrade (web-auth.ts). When set,
	 *  it overrides any client-claimed `user` in messages (ws-handlers.ts). */
	authUser?: string | null;
	/** Verified GitHub login of the signed-in user (createdByLogin stamping). */
	authLogin?: string | null;
	/** This viewer understands ordered session_feed envelopes. */
	supportsFeed?: boolean;
	sinceFeedSeq?: number;
	feedEpoch?: string;
}

// sessionId → sockets currently viewing that session (collaboration fan-out)
export const sessionWatchers: Map<string, Set<any>> = (g.__sessionWatchers ??=
	new Map());

// Sessions whose workspace (worktree) is still being prepared by their create
// run — the create announces session_created BEFORE the slow git work, and this
// set is what tells clients to show the "Waiting for workspace" state and hold
// the first message in the queue. Cleared (and broadcast via workspace_status)
// the moment the worktree lands or the create fails.
export const preparingWorkspaces: Set<string> = (g.__preparingWorkspaces ??=
	new Set());

export function joinSession(ws: any, sessionId: string) {
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

export function leaveSession(ws: any) {
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

export function broadcastToSession(
	sessionId: string,
	msg: object,
	except?: any,
) {
	const set = sessionWatchers.get(sessionId);
	// Advance feed state even with no viewers, so a backgrounded client can
	// recover an active run on reconnect.
	const feed = isFeedEvent(msg)
		? appendSessionFeed(sessionId, msg as Record<string, unknown>)
		: null;
	if (!set) return;
	const payload = JSON.stringify(msg);
	const feedPayload = feed ? JSON.stringify(feed) : null;
	for (const ws of set) {
		if (ws === except) continue;
		try {
			ws.send(ws.data?.supportsFeed && feedPayload ? feedPayload : payload);
		} catch {}
	}
}

export function broadcastPresence(sessionId: string) {
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
export function broadcastGlobalPresence() {
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
export const noteWatchers: Map<string, Set<any>> = (g.__noteWatchers ??=
	new Map());

export function joinNote(ws: any, noteId: string) {
	let set = noteWatchers.get(noteId);
	if (!set) {
		set = new Set();
		noteWatchers.set(noteId, set);
	}
	set.add(ws);
	broadcastNotePresence(noteId);
}

export function leaveNote(ws: any) {
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

export function broadcastToNote(noteId: string, msg: object, except?: any) {
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

export function broadcastNotePresence(noteId: string) {
	const set = noteWatchers.get(noteId);
	const viewers = set
		? Array.from(set, (ws: any) => ws.data?.user || "Anonymous")
		: [];
	broadcastToNote(noteId, { type: "note_presence", noteId, viewers });
}

export const b64encode = (u: Uint8Array) => Buffer.from(u).toString("base64");
export const b64decode = (s: string) =>
	new Uint8Array(Buffer.from(s, "base64"));
