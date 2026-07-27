// The foregrounded non-chat tab in each workspace. This is a per-device
// working preference, like tab order, so switching workspaces or reloading the
// app returns each workspace to the surface that was last in front.
const KEY = "opensession-active-view-tabs";

const VIEW_TABS = [
	"review",
	"conversation",
	"staging",
	"assets",
	"preview",
] as const;

export type ActiveViewTab = (typeof VIEW_TABS)[number] | null;
type ActiveViewTabMap = Record<string, ActiveViewTab>;

function read(): ActiveViewTabMap {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, ActiveViewTab] =>
					entry[1] === null ||
					(typeof entry[1] === "string" &&
						(VIEW_TABS as readonly string[]).includes(entry[1])),
			),
		);
	} catch {
		return {};
	}
}

/** `undefined` means the workspace has never had an explicit selection. */
export function getActiveViewTab(workspaceId: string): ActiveViewTab | undefined {
	return read()[workspaceId];
}

export function saveActiveViewTab(
	workspaceId: string,
	tab: ActiveViewTab,
): void {
	if (!workspaceId) return;
	const map = read();
	map[workspaceId] = tab;
	try {
		localStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		/* private mode / quota: the in-memory selection still works */
	}
}

/** Workspaces whose remembered selection requires that view tab to be open. */
export function getActiveViewTabKeys(tab: Exclude<ActiveViewTab, null>): string[] {
	return Object.entries(read())
		.filter(([, selected]) => selected === tab)
		.map(([workspaceId]) => workspaceId);
}
