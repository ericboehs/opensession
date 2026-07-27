// Per-user order for the sidebar's reorderable bands. Tools stay fixed at the
// top; the server-side ui-prefs value follows the user across devices, and the
// user-scoped localStorage entry is the synchronous cache used during startup.

import { getCurrentUser } from "../components/UserPicker";
import { fetchUiPrefs, saveUiPrefsApi } from "./api";

export const SIDEBAR_SECTION_IDS = [
	"workspaces",
	"automations",
	"people",
] as const;

export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

export const SIDEBAR_SECTION_LABELS: Record<SidebarSectionId, string> = {
	workspaces: "Workspaces",
	automations: "Automations",
	people: "People",
};

const LOCAL_KEY_PREFIX = "opensession-sidebar-order:";
const PREF_KEY = "sidebar-order";
const CHANGE_EVENT = "opensession-sidebar-order-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

function localKey(user: string): string {
	return `${LOCAL_KEY_PREFIX}${user.trim().toLowerCase() || "anonymous"}`;
}

export function normalizeSidebarOrder(value: unknown): SidebarSectionId[] {
	const valid = new Set<SidebarSectionId>(SIDEBAR_SECTION_IDS);
	const seen = new Set<SidebarSectionId>();
	const order: SidebarSectionId[] = [];
	if (Array.isArray(value)) {
		for (const item of value) {
			if (valid.has(item as SidebarSectionId) && !seen.has(item as SidebarSectionId)) {
				seen.add(item as SidebarSectionId);
				order.push(item as SidebarSectionId);
			}
		}
	}
	for (const id of SIDEBAR_SECTION_IDS) {
		if (!seen.has(id)) order.push(id);
	}
	return order;
}

function readLocal(user: string): SidebarSectionId[] {
	try {
		return normalizeSidebarOrder(JSON.parse(localStorage.getItem(localKey(user)) || "[]"));
	} catch {
		return [...SIDEBAR_SECTION_IDS];
	}
}

function writeLocal(user: string, order: SidebarSectionId[]) {
	localStorage.setItem(localKey(user), JSON.stringify(normalizeSidebarOrder(order)));
}

export function getSidebarOrder(): SidebarSectionId[] {
	return readLocal(getCurrentUser());
}

let writeStamp = 0;
let saveChain: Promise<unknown> = Promise.resolve();

export function setSidebarOrder(order: SidebarSectionId[]) {
	const user = getCurrentUser();
	const next = normalizeSidebarOrder(order);
	writeStamp++;
	writeLocal(user, next);
	window.dispatchEvent(new Event(CHANGE_EVENT));
	saveChain = saveChain
		.catch(() => {})
		.then(() => saveUiPrefsApi(user, { [PREF_KEY]: JSON.stringify(next) }))
		.catch(() => {});
}

async function hydrate(user: string) {
	const stampAtStart = writeStamp;
	let prefs: Record<string, string>;
	try {
		prefs = await fetchUiPrefs(user);
	} catch {
		return;
	}
	if (writeStamp !== stampAtStart) return;
	const serverValue = prefs[PREF_KEY];
	if (typeof serverValue === "string") {
		try {
			const serverOrder = normalizeSidebarOrder(JSON.parse(serverValue));
			if (JSON.stringify(serverOrder) !== JSON.stringify(readLocal(user))) {
				writeLocal(user, serverOrder);
				window.dispatchEvent(new Event(CHANGE_EVENT));
			}
		} catch {}
	} else {
		const localOrder = readLocal(user);
		if (JSON.stringify(localOrder) !== JSON.stringify(SIDEBAR_SECTION_IDS)) {
			void saveUiPrefsApi(user, {
				[PREF_KEY]: JSON.stringify(localOrder),
			}).catch(() => {});
		}
	}
}

void hydrate(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () => {
	writeStamp++;
	window.dispatchEvent(new Event(CHANGE_EVENT));
	void hydrate(getCurrentUser());
});

export function onSidebarOrderChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

window.addEventListener("storage", (event) => {
	if (event.key?.startsWith(LOCAL_KEY_PREFIX)) {
		writeStamp++;
		window.dispatchEvent(new Event(CHANGE_EVENT));
	} else if (event.key === "opensession-user" || event.key === "backstage-user") {
		writeStamp++;
		window.dispatchEvent(new Event(CHANGE_EVENT));
		void hydrate(getCurrentUser());
	}
});
