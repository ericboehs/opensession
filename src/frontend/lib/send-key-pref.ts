// "Send messages with" — whether Enter sends in the composer (default, with
// Shift+Enter for new lines) or ⌘/Ctrl+Enter sends (plain Enter inserts a new
// line). Stored server-side per user (ui-prefs) so it follows you across
// devices, with a localStorage copy as the synchronous cache — the same
// hydrate pattern as lib/vim-pref. Migration from the pre-2026-07-23
// per-browser-only storage is the hydrate push-up: a browser whose local
// value the server doesn't know yet uploads it on first load.
//
// The pure key-matching helpers (isSendCombo, labels) live in lib/send-key —
// this module owns only the stored preference.

import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";
import type { SendKeyPref } from "./send-key";

const KEY = "opensession-send-key";
const PREF_KEY = "send-key"; // key inside the server-side ui-prefs map
const CHANGE_EVENT = "opensession-send-key-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

export function getSendKeyPref(): SendKeyPref {
	return localStorage.getItem(KEY) === "mod-enter" ? "mod-enter" : "enter";
}

function writeLocal(pref: SendKeyPref) {
	// "enter" is the default, so its absence is the stored form.
	if (pref === "enter") localStorage.removeItem(KEY);
	else localStorage.setItem(KEY, pref);
}

// Bumped on every local set; an in-flight hydration only applies if nothing
// was set while it was fetching (the user's fresh choice beats a stale read).
let writeStamp = 0;

export function setSendKeyPref(pref: SendKeyPref) {
	writeStamp++;
	writeLocal(pref);
	window.dispatchEvent(new Event(CHANGE_EVENT));
	// Server stores the explicit value (even "enter") so a reset propagates to
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
	if (server === "enter" || server === "mod-enter") {
		if (server !== getSendKeyPref()) {
			writeLocal(server);
			window.dispatchEvent(new Event(CHANGE_EVENT));
		}
	} else if (getSendKeyPref() !== "enter") {
		// Migration: this browser has the old localStorage-only value the server
		// doesn't know yet — push it up so other devices adopt it.
		void saveUiPrefsApi(user, { [PREF_KEY]: getSendKeyPref() }).catch(
			() => {},
		);
	}
}

void hydrate(getCurrentUser());
window.addEventListener(USER_CHANGE_EVENT, () =>
	void hydrate(getCurrentUser()),
);

export function onSendKeyChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
	if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
});
