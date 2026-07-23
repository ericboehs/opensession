// Pure helpers for the "Send messages with" preference: key-combo matching
// and platform-aware labels. Deliberately side-effect-free (unit-tested) —
// the stored per-user preference itself lives in lib/send-key-pref.

export type SendKeyPref = "enter" | "mod-enter";

const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Platform-aware display label for the modifier combo ("⌘ Enter" / "Ctrl Enter"). */
export const MOD_ENTER_LABEL = isApple ? "⌘ Enter" : "Ctrl Enter";

/** Compact glyph form for inline hints ("⌘↩" / "Ctrl ↩"). */
export const MOD_ENTER_GLYPH = isApple ? "⌘↩" : "Ctrl ↩";

export function sendKeyLabel(pref: SendKeyPref): string {
	return pref === "mod-enter" ? MOD_ENTER_LABEL : "Enter";
}

/** True when this keydown should send under the given preference. */
export function isSendCombo(
	e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
	pref: SendKeyPref,
): boolean {
	if (e.key !== "Enter") return false;
	if (pref === "mod-enter") return e.metaKey || e.ctrlKey;
	return !e.shiftKey;
}
