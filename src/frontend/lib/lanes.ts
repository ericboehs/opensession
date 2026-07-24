// Per-user sidebar lanes, stored server-side per user (keyed on the
// UserPicker name) like pins, so they follow you across devices. An entry
// claims a session into YOUR sidebar lanes — that's what pulls an automation
// run or a teammate's workspace out of its own band; the value then either
// forces a status lane (Backlog, In review, …) or, as "mine", leaves it to
// follow its live state. Personal triage, not workspace state, so two
// teammates can each hold the same workspace in their own Backlog. The legacy global
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
	| "pending"
	/** Claimed into your sidebar with no forced lane — it follows its live
	    state (In progress while running, Backlog once idle). */
	| "mine";

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
