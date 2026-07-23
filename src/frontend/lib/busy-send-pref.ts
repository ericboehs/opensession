// Follow-up behavior while a run is busy (Settings → Composer, default queue).
// "queue" holds the message until the agent fully finishes (incl. running
// worker sessions); "steer" folds it into the live turn at its next step
// boundary. Holding ⌘/Ctrl on send flips to the non-default action either way.
// Stored server-side per user (ui-prefs) so it follows you across devices,
// with a localStorage copy as the synchronous cache — the same hydrate
// pattern as lib/vim-pref.

import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

export type BusySendPref = "queue" | "steer";

const KEY = "opensession-busy-send";
const PREF_KEY = "busy-send"; // key inside the server-side ui-prefs map
const CHANGE_EVENT = "opensession-busy-send-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

export function getBusySendPref(): BusySendPref {
	return localStorage.getItem(KEY) === "steer" ? "steer" : "queue";
}

function writeLocal(pref: BusySendPref) {
	// Queue is the default, so its absence is the stored form.
	if (pref === "steer") localStorage.setItem(KEY, "steer");
	else localStorage.removeItem(KEY);
}

// Bumped on every local set; an in-flight hydration only applies if nothing
// was set while it was fetching (the user's fresh choice beats a stale read).
let writeStamp = 0;

export function setBusySendPref(pref: BusySendPref) {
	writeStamp++;
	writeLocal(pref);
	window.dispatchEvent(new Event(CHANGE_EVENT));
	// Server stores the explicit value (even "queue") so a reset propagates to
	// other devices instead of leaving their old cached value in place.
	void saveUiPrefsApi(getCurrentUser(), { [PREF_KEY]: pref }).catch(() => {});
}

async function hydrate(user: string) {
	const stampAtStart = writeStamp;
	let prefs: Record<string, string>;
	try {
		prefs = await fetchUiPrefs(user);
	} catch {
		return; // offline/error: keep the local cache
	}
	if (writeStamp !== stampAtStart) return; // user changed it mid-fetch
	const server = prefs[PREF_KEY];
	if (server === "steer" || server === "queue") {
		if (server !== getBusySendPref()) {
			writeLocal(server);
			window.dispatchEvent(new Event(CHANGE_EVENT));
		}
	} else if (getBusySendPref() === "steer") {
		// This browser has a local value the server doesn't know yet: push it up.
		void saveUiPrefsApi(user, { [PREF_KEY]: "steer" }).catch(() => {});
	}
}

void hydrate(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () =>
	void hydrate(getCurrentUser()),
);

export function onBusySendChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
	if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
});
