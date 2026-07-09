/**
 * The short-TTL unified-session cache and the small helpers that read/write a
 * session's file through it. Everything that used to flip `sessionsCache = null`
 * in opensession.ts now calls invalidateSessionsCache().
 */

import { existsSync, readFileSync } from "fs";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { getAllSessions } from "./sessions";
import { activeRunRecords } from "./run-journal";
import { isAgentSessionBusy } from "./agent-runner";
import { writeJsonAtomic } from "./shared/atomic-write";
import type { UnifiedSession, BackstageSessionFile } from "./types";

export const SESSIONS_DIR = OPENSESSION_CHATS_DIR;

const g = globalThis as any;

// Cache sessions with short TTL
let sessionsCache: { data: UnifiedSession[]; ts: number } | null = null;
const CACHE_TTL = 2000;

/** Drop the cached list so the next getCachedSessions() re-reads from disk. */
export function invalidateSessionsCache(): void {
	sessionsCache = null;
}

export function getCachedSessions(): UnifiedSession[] {
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

export function findSession(sessionId: string): UnifiedSession | undefined {
	return getCachedSessions().find((s) => s.id === sessionId);
}

export function touchBackstageSession(
	bksId: string,
	patch: Partial<BackstageSessionFile>,
): void {
	const path = `${SESSIONS_DIR}/${bksId}.json`;
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
export const SESSION_EFFORTS = new Set(["low", "medium", "high"]);

/** Persist a composer-sent effort change on a backstage session (no-op otherwise). */
export function maybePersistEffort(
	session: UnifiedSession | undefined,
	effort?: string,
): void {
	if (!session || session.source !== "backstage" || !effort) return;
	const e = effort.trim().toLowerCase();
	if (!SESSION_EFFORTS.has(e) || session.effort === e) return;
	touchBackstageSession(session.id, { effort: e });
	session.effort = e; // keep the in-hand snapshot current for this turn
}

// Sessions whose LAST run died on a terminal failure (usage limits exhausted on
// every account, credit/API errors). Those need a human to act — the sidebar
// surfaces them as "Needs input" instead of letting them sink into the Backlog.
// Keyed by canonical session id; parked on globalThis for hot reloads.
// Backstage-owned sessions also persist the error on their session file (via
// recordRunOutcome) so the flag survives a real restart.
export const runErrors: Map<string, { message: string; at: string }> =
	(g.__runErrors ??= new Map());

/**
 * Record how a session's run ended: an error message when it died on a terminal
 * failure, or null for a clean finish (which clears any earlier failure). The
 * enriched /api/sessions list exposes this as `lastRunError`.
 */
export function recordRunOutcome(
	sessionId: string,
	errorMessage: string | null,
): void {
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
