// The chat last open in each workspace, so re-entering a workspace (sidebar
// click, bare /workspace/<id> URL) lands on the chat tab it was left on
// rather than the oldest chat. A per-device working preference, like the
// per-workspace view tab in active-view-tab.ts.
const KEY = "opensession-workspace-last-chats";

// Workspaces accumulate over time, so cap the map. Entries are kept in
// insertion order; a save re-appends its workspace, so trimming from the
// front evicts the least recently saved.
const MAX_ENTRIES = 200;

function read(): Record<string, string> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}

/** `undefined` means no chat has been opened in this workspace on this device. */
export function getWorkspaceLastChat(workspaceId: string): string | undefined {
	return read()[workspaceId];
}

export function saveWorkspaceLastChat(
	workspaceId: string,
	chatId: string,
): void {
	if (!workspaceId || !chatId) return;
	const map = read();
	if (map[workspaceId] === chatId) return;
	delete map[workspaceId];
	map[workspaceId] = chatId;
	const ids = Object.keys(map);
	for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES)))
		delete map[stale];
	try {
		localStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		/* private mode / quota: landing just falls back to the default pick */
	}
}
