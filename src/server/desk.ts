/**
 * Desk — the per-user standing concierge session behind the summonable Desk
 * overlay (⌘J / the floating button). One durable ask-mode session per user
 * (session file flag `desk: true`, fixed title, hidden from the normal
 * session lists like side chats) that the user can open on top of whatever
 * they're doing: manage their todo list (todos.ts), ask quick questions, and
 * delegate real work to worker sessions via the opensession-sessions tools
 * every interactive run carries.
 *
 * Deliberately NOT an event feed — the deleted HQ feature (84f8bbfa) showed
 * that a passive event digest gets skipped. The Desk only ever speaks when
 * spoken to; the pull is the persistent todo list.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUIDv7 } from "bun";
import { stateDir } from "./rename-compat";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
	SESSIONS_DIR,
	findSession,
	invalidateSessionsCache,
} from "./session-cache";
import type { BackstageSessionFile } from "./types";

interface DeskStore {
	users: Record<string, { sessionId?: string }>;
}

const CONFIG_DIR = stateDir("desk");
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

function readStore(): DeskStore {
	try {
		if (existsSync(CONFIG_PATH))
			return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as DeskStore;
	} catch (e) {
		console.error("[desk] failed to read config:", e);
	}
	return { users: {} };
}

/** Get-or-create the user's Desk session (same direct-mint shape as side
 *  chats: ask mode, no worktree; repo backstage so it reads the OpenSession
 *  checkout when it needs context). */
export function ensureDeskSession(user: string): { sessionId: string } {
	const store = readStore();
	const st = store.users[user] ?? (store.users[user] = {});
	if (st.sessionId && findSession(st.sessionId)) return { sessionId: st.sessionId };
	const bksId = `bks-${randomUUIDv7()}`;
	const now = new Date().toISOString();
	const data: BackstageSessionFile = {
		id: bksId,
		claudeSessionId: "",
		branch: "",
		worktreeDir: "",
		mode: "ask",
		desk: true,
		repo: "backstage",
		createdBy: user,
		createdAt: now,
		lastActivity: now,
		title: "Desk",
	};
	writeJsonAtomic(`${SESSIONS_DIR}/${bksId}.json`, data);
	invalidateSessionsCache();
	st.sessionId = bksId;
	writeJsonAtomic(CONFIG_PATH, store);
	console.log(`[desk] created Desk session ${bksId} for ${user}`);
	return { sessionId: bksId };
}

/** The role charter prepended to every Desk-session prompt (run-session.ts). */
export const DESK_NOTE = `## Your role: the Desk

This session is the user's Desk — their standing concierge, summoned as a quick overlay on top of whatever they're doing. Discipline:

- Keep answers short and immediate; the user is mid-task and will close this overlay in seconds.
- Manage their todo list with the opensession-todos tools: capture items the moment they mention wanting/needing to do something ("I want to finish X today" → add_todo), mark things done when they say so, and use list_todos before answering "what's on my plate?".
- You are an orchestrator, not the worker: for anything beyond a quick answer or a list edit, spawn a scoped worker session via opensession-sessions create_session and tell the user you did — never start long implementation work inside this session.
- Never drop a todo without the user asking; when in doubt, ask.`;
