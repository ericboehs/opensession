// Sidebar folders, stored server-side per user (keyed on the UserPicker name)
// so they follow you across devices — the exact same optimistic-cache pattern
// as pins.ts: the public API is synchronous over an in-memory cache, hydrated
// from the server on load and on user switch; writes update the cache + fire
// the change event immediately, then PUT the full list.
//
// A folder is `{ id, name, keys }`. Array order is the sidebar's section
// order; each folder's `keys` order is its rows' order. Keys use the same
// vocabulary as pins (`workspace:<id>` for real workspaces, the chat id for
// solo rows), and a key lives in at most one folder.
import { fetchFolders, saveFoldersApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

export type SidebarFolder = { id: string; name: string; keys: string[] };

const CHANGE_EVENT = "michael-folders-changed";
const USER_CHANGE_EVENT = "michael-user-changed";

let cache: SidebarFolder[] = [];
let loadedFor: string | null = null;

function emit() {
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

function persist(next: SidebarFolder[]): SidebarFolder[] {
	cache = next;
	emit();
	void saveFoldersApi(getCurrentUser(), next).catch(() => {});
	return next;
}

async function load(user: string) {
	loadedFor = user;
	let folders: SidebarFolder[] = [];
	try {
		folders = await fetchFolders(user);
	} catch {
		folders = [];
	}
	// A newer load() (user switched mid-flight) wins.
	if (loadedFor !== user) return;
	cache = folders;
	emit();
}

void load(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));

export function getFolders(): SidebarFolder[] {
	return cache;
}

export function onFoldersChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function createFolder(name: string): SidebarFolder {
	const folder: SidebarFolder = {
		id: `fld-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		name: name.trim() || "New folder",
		keys: [],
	};
	// New folders append at the end — sections read top-down in creation order
	// until the user drags them around.
	persist([...cache, folder]);
	return folder;
}

export function renameFolder(id: string, name: string): void {
	const clean = name.trim();
	if (!clean) return;
	persist(cache.map((f) => (f.id === id ? { ...f, name: clean } : f)));
}

/** Delete a folder. Its rows return to the status lanes (keys just vanish). */
export function deleteFolder(id: string): void {
	persist(cache.filter((f) => f.id !== id));
}

/**
 * Move a row between sections in one write: every key in `removeKeys` and
 * `addKeys` is stripped from every folder — a row lives in at most one section
 * — then `addKeys` are prepended to `folderId` so a freshly moved row surfaces
 * at the top of its new folder (same top-of-band rule as pins). Pass
 * `folderId: null` (with empty addKeys) to just take a row out of folders.
 */
export function moveToFolder(
	removeKeys: string[],
	addKeys: string[],
	folderId: string | null,
): void {
	const drop = new Set([...removeKeys, ...addKeys].filter(Boolean));
	if (!drop.size) return;
	const stripped = cache.map((f) => ({
		...f,
		keys: f.keys.filter((k) => !drop.has(k)),
	}));
	persist(
		folderId
			? stripped.map((f) =>
					f.id === folderId ? { ...f, keys: [...addKeys, ...f.keys] } : f,
				)
			: stripped,
	);
}

/**
 * Replace one folder's key order (drag-to-reorder inside a section). Keeps
 * only keys already in the folder, so a stale drag can't resurrect a moved
 * row; appends any omitted key so nothing is silently dropped.
 */
export function reorderFolderKeys(folderId: string, keys: string[]): void {
	persist(
		cache.map((f) => {
			if (f.id !== folderId) return f;
			const known = new Set(f.keys);
			const next = keys.filter((k) => known.has(k));
			for (const k of f.keys) if (!next.includes(k)) next.push(k);
			return { ...f, keys: next };
		}),
	);
}

/**
 * Replace the section order (drag-to-reorder folder headers). Keeps only ids
 * that exist, appends any omitted folder — same defensive shape as
 * reorderPins.
 */
export function reorderFolders(ids: string[]): void {
	const byId = new Map(cache.map((f) => [f.id, f] as const));
	const next: SidebarFolder[] = [];
	for (const id of ids) {
		const f = byId.get(id);
		if (f && !next.includes(f)) next.push(f);
	}
	for (const f of cache) if (!next.includes(f)) next.push(f);
	persist(next);
}

/**
 * Remove any of `keys` from every folder (no-op for the rest). The client
 * mirror of the server's archive-time cleanup — same reason as pins.unpin():
 * our cache is optimistic and never hears about the server-side removal, so
 * the next save would re-upload the stale key and resurrect the row.
 */
export function removeKeysFromFolders(keys: string[]): void {
	const drop = new Set(keys.filter(Boolean));
	if (!drop.size) return;
	let changed = false;
	const next = cache.map((f) => {
		const kept = f.keys.filter((k) => !drop.has(k));
		if (kept.length !== f.keys.length) changed = true;
		return kept.length !== f.keys.length ? { ...f, keys: kept } : f;
	});
	if (changed) persist(next);
}
