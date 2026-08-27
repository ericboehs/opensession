import type { Person } from "./people";
import {
	canonicalNames,
	ownerKey,
	ownerKeyOf,
	rosterNameFor,
} from "./session-owner";
import type { UnifiedSession } from "./types";

export const PERSON_RECENT_ACTIVITY_MS = 15 * 60 * 1000;

export interface SidebarPersonSessions {
	key: string;
	label: string;
	activeSessions: UnifiedSession[];
	allSessions: UnifiedSession[];
}

/**
 * A session stays in the compact People list while it is running and for the
 * first fifteen minutes after its latest run activity. `ran` keeps a newly
 * created, never-started session from looking active just because it is new.
 */
export function sessionIsRecentlyActive(
	session: UnifiedSession,
	nowMs: number,
): boolean {
	if (session.isRunning) return true;
	if (!session.ran) return false;
	const lastActivityMs = Date.parse(session.lastActivity || "");
	return (
		Number.isFinite(lastActivityMs) &&
		lastActivityMs >= nowMs - PERSON_RECENT_ACTIVITY_MS
	);
}

/**
 * Other teammates with active work, directory-gated so worker labels, goals,
 * integrations and arbitrary `startedBy` strings never become people.
 * Sessions retain the incoming order, which lets the sidebar's selected sort
 * apply to both the compact and expanded lists.
 */
export function sidebarPersonSessions(
	sessions: UnifiedSession[],
	roster: Person[],
	currentUser: string,
	nowMs: number,
): SidebarPersonSessions[] {
	const canonical = canonicalNames(roster);
	const currentUserKey = ownerKey(currentUser, canonical);
	const groups = new Map<string, SidebarPersonSessions>();

	for (const session of sessions) {
		if (
			session.archived ||
			session.automation ||
			session.desk ||
			!session.startedBy
		)
			continue;
		const label = rosterNameFor(session.startedBy, canonical);
		if (!label) continue;
		const key = ownerKeyOf(session, canonical);
		if (key === currentUserKey) continue;

		let group = groups.get(key);
		if (!group) {
			group = { key, label, activeSessions: [], allSessions: [] };
			groups.set(key, group);
		}
		group.allSessions.push(session);
		if (sessionIsRecentlyActive(session, nowMs))
			group.activeSessions.push(session);
	}

	return Array.from(groups.values()).filter(
		(group) => group.activeSessions.length > 0,
	);
}
