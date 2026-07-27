// The right-panel tab last selected in each session, so returning to a
// session lands on the tab it was left on. A per-device working preference,
// like the per-workspace view tab in active-view-tab.ts — the global
// "opensession-panel-tab" key stays as the fallback for sessions never
// visited on this device.
const KEY = "opensession-session-panel-tabs";

// Only tabs worth restoring on a later visit are recorded. Shell is excluded
// (restoring it would spawn a PTY on every load), evidence is transient (it
// needs a tool call selected), and reports would immediately reset to Info
// until the async report fetch lands.
const RESTORABLE = ["info", "changes", "workflows"] as const;
export type RestorablePanelTab = (typeof RESTORABLE)[number];

// Sessions accumulate forever (unlike workspaces), so cap the map. Entries
// are kept in insertion order; a save re-appends its session, so trimming
// from the front evicts the least recently saved.
const MAX_ENTRIES = 200;

function read(): Record<string, RestorablePanelTab> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, RestorablePanelTab] =>
					typeof entry[1] === "string" &&
					(RESTORABLE as readonly string[]).includes(entry[1]),
			),
		);
	} catch {
		return {};
	}
}

/** `undefined` means the session has never had a restorable selection. */
export function getSessionPanelTab(
	sessionId: string,
): RestorablePanelTab | undefined {
	return read()[sessionId];
}

/** Selections of non-restorable tabs are ignored, keeping the session's last
 *  restorable pick in place. */
export function saveSessionPanelTab(sessionId: string, tab: string): void {
	if (!sessionId || !(RESTORABLE as readonly string[]).includes(tab)) return;
	const map = read();
	delete map[sessionId];
	map[sessionId] = tab as RestorablePanelTab;
	const ids = Object.keys(map);
	for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES)))
		delete map[stale];
	try {
		localStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		/* private mode / quota: the in-memory selection still works */
	}
}
