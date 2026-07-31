export const SIDEBAR_TOOL_IDS = [
	"home",
	"tasks",
	"catchup",
	"prtinder",
	"supporttinder",
	"reports",
	"analytics",
	"notes",
	"desk",
] as const;

export type SidebarToolId = (typeof SIDEBAR_TOOL_IDS)[number];

export const SIDEBAR_TOOL_LABELS: Record<SidebarToolId, string> = {
	home: "Home",
	tasks: "Tasks",
	catchup: "Catch up",
	prtinder: "PR Tinder",
	supporttinder: "Support Tinder",
	reports: "Reports",
	analytics: "Analytics",
	notes: "Notes",
	desk: "Desk",
};

const HIDDEN_TOOLS_KEY = "opensession-sidebar-hidden-tools";
const TOOLS_CHANGED_EVENT = "opensession-sidebar-tools-changed";
const DEFAULT_HIDDEN_TOOLS: SidebarToolId[] = [
	"catchup",
	"prtinder",
	"supporttinder",
	"analytics",
	"notes",
	"desk",
];

export function readHiddenSidebarTools(): Set<SidebarToolId> {
	try {
		const value = localStorage.getItem(HIDDEN_TOOLS_KEY);
		if (value === null) return new Set(DEFAULT_HIDDEN_TOOLS);
		const stored = JSON.parse(value);
		return new Set(
			Array.isArray(stored)
				? stored.filter((id): id is SidebarToolId =>
						SIDEBAR_TOOL_IDS.includes(id),
					)
				: [],
		);
	} catch {
		return new Set(DEFAULT_HIDDEN_TOOLS);
	}
}

function writeHiddenSidebarTools(hidden: Set<SidebarToolId>) {
	localStorage.setItem(HIDDEN_TOOLS_KEY, JSON.stringify([...hidden]));
	window.dispatchEvent(new Event(TOOLS_CHANGED_EVENT));
}

export function setSidebarToolVisible(id: SidebarToolId, visible: boolean) {
	const hidden = readHiddenSidebarTools();
	if (visible) hidden.delete(id);
	else hidden.add(id);
	writeHiddenSidebarTools(hidden);
}

export function showAllSidebarTools() {
	writeHiddenSidebarTools(new Set());
}

export function hideAllSidebarTools() {
	writeHiddenSidebarTools(new Set(SIDEBAR_TOOL_IDS));
}

export function areAllSidebarToolsHidden() {
	return readHiddenSidebarTools().size === SIDEBAR_TOOL_IDS.length;
}

export function onSidebarToolsChanged(listener: () => void) {
	window.addEventListener(TOOLS_CHANGED_EVENT, listener);
	return () => window.removeEventListener(TOOLS_CHANGED_EVENT, listener);
}
