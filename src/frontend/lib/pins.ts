// Pinned tabs, stored server-side per user (keyed on the UserPicker name) so
// they follow you across devices instead of living in one browser. The public
// API stays synchronous (an in-memory cache) so callers don't change: the cache
// is hydrated from the server on load and on user switch, and writes are
// optimistic — update the cache + fire the change event immediately, then PUT.
import { fetchPins, savePinsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

const LEGACY_KEY = "michael-pins"; // old per-browser store, migrated once
const MIGRATED_FLAG = "michael-pins-migrated";
const CHANGE_EVENT = "michael-pins-changed";
const USER_CHANGE_EVENT = "michael-user-changed";

let cache: string[] = [];
let loadedFor: string | null = null;

function emit() {
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

function readLegacy(): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(LEGACY_KEY) || "[]");
		return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

// Hydrate the cache for `user`. On first run after the server-side switch, fold
// this browser's old localStorage pins into the user's server store so nobody
// loses their pins. Migration is deferred until a real user is picked (never
// "Anonymous") so legacy pins land on the right account, and runs at most once.
async function load(user: string) {
	loadedFor = user;
	let pins: string[] = [];
	try {
		pins = await fetchPins(user);
	} catch {
		pins = [];
	}

	if (user !== "Anonymous" && !localStorage.getItem(MIGRATED_FLAG)) {
		const legacy = readLegacy();
		if (legacy.length) {
			pins = Array.from(new Set([...pins, ...legacy]));
			try {
				pins = await savePinsApi(user, pins);
			} catch {
				/* keep the merged list in memory even if the write fails */
			}
		}
		localStorage.setItem(MIGRATED_FLAG, "1");
	}

	// A newer load() (user switched mid-flight) wins.
	if (loadedFor !== user) return;
	cache = pins;
	emit();
}

void load(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));

export function getPins(): string[] {
	return cache;
}

export function isPinned(id: string): boolean {
	return cache.includes(id);
}

/** Add a pin if it isn't already set (never removes). Returns the new list.
    New pins go to the FRONT — the pins array is the Pinned band's display
    order (drag-to-reorder rewrites it), and a fresh session should surface at
    the top of the band, not sink under old pins. */
export function pin(id: string): string[] {
	if (cache.includes(id)) return cache;
	const next = [id, ...cache];
	cache = next;
	emit();
	void savePinsApi(getCurrentUser(), next).catch(() => {});
	return next;
}

// "Pin new sessions" preference — per-browser (a workflow habit, like the
// send-key/theme prefs), default ON. Absence = on; the string "off" is the
// only stored form, so the default survives a cleared store.
const PIN_NEW_KEY = "michael-pin-new-sessions";
const PIN_NEW_EVENT = "michael-pin-new-changed";

export function getPinNewSessions(): boolean {
	return localStorage.getItem(PIN_NEW_KEY) !== "off";
}

export function setPinNewSessions(on: boolean): void {
	if (on) localStorage.removeItem(PIN_NEW_KEY);
	else localStorage.setItem(PIN_NEW_KEY, "off");
	window.dispatchEvent(new Event(PIN_NEW_EVENT));
}

export function onPinNewSessionsChanged(handler: () => void): () => void {
	window.addEventListener(PIN_NEW_EVENT, handler);
	return () => window.removeEventListener(PIN_NEW_EVENT, handler);
}

// "Pin new workspaces" preference — per-browser, default OFF. A new workspace is
// heavier than a chat, so pinning every one you spin up floods the Pinned band;
// off by default. The string "on" is the only stored form, so the default
// survives a cleared store.
const PIN_NEW_WS_KEY = "michael-pin-new-workspaces";
const PIN_NEW_WS_EVENT = "michael-pin-new-workspaces-changed";

export function getPinNewWorkspaces(): boolean {
	return localStorage.getItem(PIN_NEW_WS_KEY) === "on";
}

export function setPinNewWorkspaces(on: boolean): void {
	if (on) localStorage.setItem(PIN_NEW_WS_KEY, "on");
	else localStorage.removeItem(PIN_NEW_WS_KEY);
	window.dispatchEvent(new Event(PIN_NEW_WS_EVENT));
}

export function onPinNewWorkspacesChanged(handler: () => void): () => void {
	window.addEventListener(PIN_NEW_WS_EVENT, handler);
	return () => window.removeEventListener(PIN_NEW_WS_EVENT, handler);
}

/**
 * Remove any of `ids` that are currently pinned (no-op for the rest). Returns
 * the new list. This is the client-side mirror of the server's
 * `unpinArchivedSessions` — archiving a session drops its pins server-side, but
 * our cache is optimistic and never hears about that write, so the next
 * `savePinsApi` would re-upload the whole stale list and *resurrect* the pin we
 * just archived away. Call this on archive so the cache stays in sync and can't
 * bring an archived (unreachable) pin back to the Pinned band.
 */
export function unpin(ids: string[]): string[] {
	const drop = new Set(ids.filter(Boolean));
	if (!drop.size) return cache;
	const next = cache.filter((id) => !drop.has(id));
	if (next.length === cache.length) return cache;
	cache = next;
	emit();
	void savePinsApi(getCurrentUser(), next).catch(() => {});
	return next;
}

export function togglePin(id: string): string[] {
	// Adding prepends — same top-of-band rule as pin().
	const next = cache.includes(id)
		? cache.filter((p) => p !== id)
		: [id, ...cache];
	cache = next;
	emit();
	void savePinsApi(getCurrentUser(), next).catch(() => {});
	return next;
}

/**
 * Replace the pin order with `ids` (drag-to-reorder in the tab bar). Keeps only
 * ids already pinned, so a stale drag can't resurrect an unpinned tab; appends
 * any pinned id the caller omitted, so nothing is silently dropped.
 */
export function reorderPins(ids: string[]): string[] {
	const known = new Set(cache);
	const next = ids.filter((id) => known.has(id));
	for (const id of cache) if (!next.includes(id)) next.push(id);
	cache = next;
	emit();
	void savePinsApi(getCurrentUser(), next).catch(() => {});
	return next;
}

export function onPinsChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}
