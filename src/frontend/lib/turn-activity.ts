// How a turn's folded work (tool calls + intermediate assistant messages)
// displays in the chat: "auto" opens the fold while the turn is running and
// collapses it when the turn settles; "expanded"/"collapsed" pin one state.
// Stored per-browser in localStorage like the theme: it's a reading
// preference, not per-user cloud state. Edited in Settings → Appearance.

export type TurnActivityPref = "auto" | "expanded" | "collapsed";

const KEY = "michael-turn-activity";
const CHANGE_EVENT = "michael-turn-activity-changed";

export function getTurnActivityPref(): TurnActivityPref {
	const v = localStorage.getItem(KEY);
	return v === "expanded" || v === "collapsed" ? v : "auto";
}

export function setTurnActivityPref(pref: TurnActivityPref) {
	// "auto" is the default, so its absence is the stored form.
	if (pref === "auto") localStorage.removeItem(KEY);
	else localStorage.setItem(KEY, pref);
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onTurnActivityChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
	if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
});
