// "Send messages with" — whether Enter sends in the composer (default, with
// Shift+Enter for new lines) or ⌘/Ctrl+Enter sends (plain Enter inserts a new
// line). Stored per-browser in localStorage like the theme: it's a keyboard
// habit, not per-user cloud state.

export type SendKeyPref = "enter" | "mod-enter";
export type BusySendPref = "queue" | "steer";

const KEY = "opensession-send-key";
const BUSY_KEY = "opensession-busy-send";
const CHANGE_EVENT = "opensession-send-key-changed";
const BUSY_CHANGE_EVENT = "opensession-busy-send-changed";

export function getSendKeyPref(): SendKeyPref {
	return localStorage.getItem(KEY) === "mod-enter" ? "mod-enter" : "enter";
}

export function setSendKeyPref(pref: SendKeyPref) {
	// "enter" is the default, so its absence is the stored form.
	if (pref === "enter") localStorage.removeItem(KEY);
	else localStorage.setItem(KEY, pref);
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onSendKeyChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function getBusySendPref(): BusySendPref {
	// Follow-up behavior: steer (default) folds the message into the live run at
	// its next stopping point; queue waits for the whole run to end. While busy,
	// ⌘/Ctrl+Enter is the per-send interrupt (abort the turn, deliver now).
	return localStorage.getItem(BUSY_KEY) === "queue" ? "queue" : "steer";
}

export function setBusySendPref(pref: BusySendPref) {
	if (pref === "steer") localStorage.removeItem(BUSY_KEY);
	else localStorage.setItem(BUSY_KEY, pref);
	window.dispatchEvent(new Event(BUSY_CHANGE_EVENT));
}

export function onBusySendChanged(handler: () => void): () => void {
	window.addEventListener(BUSY_CHANGE_EVENT, handler);
	return () => window.removeEventListener(BUSY_CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
if (typeof window !== "undefined") {
	window.addEventListener("storage", (e) => {
		if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
		if (e.key === BUSY_KEY) window.dispatchEvent(new Event(BUSY_CHANGE_EVENT));
	});
}

const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Platform-aware display label for the modifier combo ("⌘ Enter" / "Ctrl Enter"). */
export const MOD_ENTER_LABEL = isApple ? "⌘ Enter" : "Ctrl Enter";

/** Compact glyph form for inline hints ("⌘↩" / "Ctrl ↩"). */
export const MOD_ENTER_GLYPH = isApple ? "⌘↩" : "Ctrl ↩";

export function sendKeyLabel(pref: SendKeyPref = getSendKeyPref()): string {
	return pref === "mod-enter" ? MOD_ENTER_LABEL : "Enter";
}

/** True when this keydown should send under the given preference. */
export function isSendCombo(
	e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
	pref: SendKeyPref = getSendKeyPref(),
): boolean {
	if (e.key !== "Enter") return false;
	if (pref === "mod-enter") return e.metaKey || e.ctrlKey;
	return !e.shiftKey;
}
