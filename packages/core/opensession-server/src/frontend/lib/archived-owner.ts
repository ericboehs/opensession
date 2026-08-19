/**
 * Who archived what — the Owner lens on the Archived page.
 *
 * `startedBy` is a free-text display name, and the archive holds far more than
 * teammates: spawned workers ("worker os-019fe…"), the agent persona, and
 * integration senders all land in that field. So the person options are drawn
 * against the team directory (GET /api/people, lib/people) rather than against
 * every distinct string — an unfiltered list is mostly session ids.
 *
 * The directory is also what merges one person's spellings: chat integrations
 * write a full name where the web writes a first name, and both must answer to
 * the same option.
 */

import type { Person } from "./people";
import type { UnifiedSession } from "./types";

/** Lowercased first name *and* full name → the roster's display name. */
export function canonicalNames(roster: Person[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const p of roster) {
		if (!p.name) continue;
		map.set(p.name.toLowerCase(), p.name);
		if (p.fullName) map.set(p.fullName.toLowerCase(), p.name);
	}
	return map;
}

/**
 * The owner key a session filters under: its canonical roster name when the
 * directory recognizes the starter, otherwise the raw name lowercased — so the
 * lens still works before /api/people lands, and for people not in it.
 */
export function ownerKeyOf(
	session: UnifiedSession,
	canonical: Map<string, string>,
): string {
	const raw = (session.startedBy || "").toLowerCase();
	return canonical.get(raw)?.toLowerCase() || raw;
}

export function sessionHasOwner(
	session: UnifiedSession,
	owner: string,
	canonical: Map<string, string>,
): boolean {
	return !session.automation && !!session.startedBy && ownerKeyOf(session, canonical) === owner;
}

/**
 * Teammates with something in this archive, most-archived first, excluding the
 * signed-in user (whose row is "My archived" and comes first in the menu).
 */
export function archivedOwners(
	sessions: UnifiedSession[],
	canonical: Map<string, string>,
	meKey: string,
): Array<{ key: string; label: string }> {
	const entries = new Map<string, { label: string; count: number }>();
	for (const s of sessions) {
		if (s.automation || !s.startedBy) continue;
		const label = canonical.get(s.startedBy.toLowerCase());
		if (!label) continue;
		const key = label.toLowerCase();
		if (key === meKey) continue;
		const entry = entries.get(key) || { label, count: 0 };
		entry.count++;
		entries.set(key, entry);
	}
	return Array.from(entries.entries())
		.sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
		.map(([key, { label }]) => ({ key, label }));
}
