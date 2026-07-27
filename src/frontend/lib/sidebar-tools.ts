export const SIDEBAR_TOOL_IDS = [
	"home",
	"catchup",
	"prtinder",
	"supporttinder",
	"reports",
	"analytics",
	"notes",
] as const;

export type SidebarToolId = (typeof SIDEBAR_TOOL_IDS)[number];

export const SIDEBAR_TOOL_LABELS: Record<SidebarToolId, string> = {
	home: "Home",
	catchup: "Catch up",
	prtinder: "PR Tinder",
	supporttinder: "Support Tinder",
	reports: "Reports",
	analytics: "Analytics",
	notes: "Notes",
};

const HIDDEN_TOOLS_KEY = "opensession-sidebar-hidden-tools";
const TOOLS_CHANGED_EVENT = "opensession-sidebar-tools-changed";

export function readHiddenSidebarTools(): Set<SidebarToolId> {
	try {
		const stored = JSON.parse(localStorage.getItem(HIDDEN_TOOLS_KEY) || "[]");
		return new Set(
			Array.isArray(stored)
				? stored.filter((id): id is SidebarToolId =>
						SIDEBAR_TOOL_IDS.includes(id),
					)
				: [],
		);
	} catch {
		return new Set();
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
