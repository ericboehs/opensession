// Vim mode for the composer (Settings → Composer, default off). Stored
// server-side per user (ui-prefs) so it follows you across devices, with a
// localStorage copy as the synchronous cache — the same hydrate pattern as
// lib/turn-activity: reads stay sync (right on first paint), the server
// hydrates on load / user switch and emits the change event so mounted
// composers flip live.

import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

const KEY = "opensession-vim-mode";
const PREF_KEY = "composer-vim"; // key inside the server-side ui-prefs map
const CHANGE_EVENT = "opensession-vim-mode-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

export function getVimModePref(): boolean {
	return localStorage.getItem(KEY) === "on";
}

function writeLocal(on: boolean) {
	// Off is the default, so its absence is the stored form.
	if (on) localStorage.setItem(KEY, "on");
	else localStorage.removeItem(KEY);
}

// Bumped on every local set; an in-flight hydration only applies if nothing
// was set while it was fetching (the user's fresh choice beats a stale read).
let writeStamp = 0;

export function setVimModePref(on: boolean) {
	writeStamp++;
	writeLocal(on);
	window.dispatchEvent(new Event(CHANGE_EVENT));
	// Server stores the explicit value (even "off") so a reset propagates to
	// other devices instead of leaving their old cached value in place.
	void saveUiPrefsApi(getCurrentUser(), {
		[PREF_KEY]: on ? "on" : "off",
	}).catch(() => {});
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
	if (server === "on" || server === "off") {
		if ((server === "on") !== getVimModePref()) {
			writeLocal(server === "on");
			window.dispatchEvent(new Event(CHANGE_EVENT));
		}
	} else if (getVimModePref()) {
		// This browser has a local value the server doesn't know yet: push it up.
		void saveUiPrefsApi(user, { [PREF_KEY]: "on" }).catch(() => {});
	}
}

void hydrate(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () =>
	void hydrate(getCurrentUser()),
);

export function onVimModeChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
	if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
});
