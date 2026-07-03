// "Send messages with" — whether Enter sends in the composer (default, with
// Shift+Enter for new lines) or ⌘/Ctrl+Enter sends (plain Enter inserts a new
// line). Stored per-browser in localStorage like the theme: it's a keyboard
// habit, not per-user cloud state.

export type SendKeyPref = "enter" | "mod-enter";
export type BusySendPref = "interrupt" | "queue" | "steer";

const KEY = "michael-send-key";
const BUSY_KEY = "michael-busy-send";
const CHANGE_EVENT = "michael-send-key-changed";
const BUSY_CHANGE_EVENT = "michael-busy-send-changed";

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
	const v = localStorage.getItem(BUSY_KEY);
	// Default is interrupt-and-redirect (matches Esc in the CLI): the message
	// lands now instead of waiting minutes for the turn to end. Queue and steer
	// are the gentler opt-ins.
	return v === "steer" || v === "queue" ? v : "interrupt";
}

export function setBusySendPref(pref: BusySendPref) {
	if (pref === "interrupt") localStorage.removeItem(BUSY_KEY);
	else localStorage.setItem(BUSY_KEY, pref);
	window.dispatchEvent(new Event(BUSY_CHANGE_EVENT));
}

export function onBusySendChanged(handler: () => void): () => void {
	window.addEventListener(BUSY_CHANGE_EVENT, handler);
	return () => window.removeEventListener(BUSY_CHANGE_EVENT, handler);
}

// Mirror changes made in another tab (storage events don't fire same-tab).
window.addEventListener("storage", (e) => {
	if (e.key === KEY) window.dispatchEvent(new Event(CHANGE_EVENT));
	if (e.key === BUSY_KEY) window.dispatchEvent(new Event(BUSY_CHANGE_EVENT));
});

const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Platform-aware display label for the modifier combo ("⌘ Enter" / "Ctrl Enter"). */
export const MOD_ENTER_LABEL = isApple ? "⌘ Enter" : "Ctrl Enter";

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
	return !e.shiftKey && !e.metaKey && !e.ctrlKey;
}
