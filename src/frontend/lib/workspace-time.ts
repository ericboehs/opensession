// "Show last used time" on sidebar workspace rows — the compact relative time
// ("3h", "2d") of a workspace's last activity. Off by default: the idle "time
// since" was sidebar noise everywhere, so it was dropped (a live run still shows
// its elapsed ticker regardless). This opt-in brings it back for anyone who
// wants it — either always visible, or revealed only on row hover. Stored
// per-browser in localStorage like the theme: a display habit, not cloud state.

export type WsTimePref = "off" | "always" | "hover";

const KEY = "michael-ws-time";
const CHANGE_EVENT = "michael-ws-time-changed";

export function getWsTimePref(): WsTimePref {
	const v = localStorage.getItem(KEY);
	return v === "always" || v === "hover" ? v : "off";
}

export function setWsTimePref(pref: WsTimePref) {
	// "off" is the default, so its absence is the stored form.
	if (pref === "off") localStorage.removeItem(KEY);
	else localStorage.setItem(KEY, pref);
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onWsTimeChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
	if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
});
