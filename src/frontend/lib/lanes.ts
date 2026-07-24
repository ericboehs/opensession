// Per-user sidebar lanes, stored server-side per user (keyed on the
// UserPicker name) like pins, so they follow you across devices. A lane entry
// pins a session into a chosen status lane (Backlog, In review, …) in YOUR
// sidebar only — personal triage, not workspace state, so two teammates can
// each hold the same workspace in their own Backlog. The legacy global
// `manualStatus` (status-overrides registry, applied server-side) remains as
// a fallback for entries set before lanes went per-user; the sidebar reads
// the personal lane first. The public API stays synchronous (an in-memory
// cache) mirroring pins.ts: hydrated on load and on user switch, writes are
// optimistic — update the cache + fire the change event, then PUT.
import { fetchLanes, saveLanesApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

export type Lane =
	| "needsinput"
	| "inprogress"
	| "review"
	| "merged"
	| "pending";

const CHANGE_EVENT = "opensession-lanes-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

let cache: Record<string, Lane> = {};

function emit() {
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

let loadedFor: string | null = null;

async function load(user: string) {
	loadedFor = user;
	let lanes: Record<string, Lane> = {};
	try {
		lanes = (await fetchLanes(user)) as Record<string, Lane>;
	} catch {
		lanes = {};
	}
	// A newer load() (user switched mid-flight) wins.
	if (loadedFor !== user) return;
	cache = lanes;
	emit();
}

void load(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));

export function getLanes(): Record<string, Lane> {
	return cache;
}

/** Your personal lane for a session id, or undefined. */
export function getLane(id: string): Lane | undefined {
	return cache[id];
}

/** Set (a lane) or clear (null) your personal lane for a session id. */
export function setLane(id: string, lane: Lane | null): void {
	if (lane) cache = { ...cache, [id]: lane };
	else {
		if (!(id in cache)) return;
		const next = { ...cache };
		delete next[id];
		cache = next;
	}
	emit();
	void saveLanesApi(getCurrentUser(), cache).catch(() => {});
}

export function onLanesChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}
