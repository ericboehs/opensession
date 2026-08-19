import {
	ACCENT_THEME_OPTIONS,
	type AccentTheme,
	DEFAULT_ACCENT_THEME,
	getAccentThemeOption,
	isAccentTheme,
} from "../../shared/accent-theme";
import { getCurrentUser } from "../components/UserPicker";
import { saveUiPrefsApi } from "./api";

/**
 * Seven accents, ordered as a walk around the hue wheel from the blues.
 *
 * Each fill runs at 92% of the chroma its hue can physically reach in sRGB at
 * its lightness, which is as saturated as the colour gets before it leaves the
 * gamut. That share is flat across the wheel, but the results are not: teal and
 * sky top out near chroma 0.10 and 0.13 where indigo and coral reach 0.22, so
 * the cool end reads calmer than the warm one no matter what is asked of it.
 *
 * Two entries sit outside the rule. `lime` (Honey) is a yellow, and yellow only
 * exists at high lightness, so it keeps one value in both appearances; its ink
 * form deepens instead, since a label has to clear text contrast that a plate
 * does not. `mono` (Black) has no hue at all and inverts with the page.
 *
 * The `value` is persisted per person, so these ids outlive their colours:
 * changing a hex re-themes everyone who chose that slot, while renaming one
 * drops them back to the default. Migrate instead: see `getAccentTheme`.
 */
export {
	ACCENT_THEME_OPTIONS,
	type AccentTheme,
	DEFAULT_ACCENT_THEME,
	getAccentThemeOption,
	isAccentTheme,
};

const KEY = "opensession-accent";
const CHANGE_EVENT = "opensession-accent-changed";
const PREF_KEY = "accent";

/**
 * Selections that outlived their colour. Each maps to the nearest hue still in
 * the palette, so someone who chose a removed accent lands somewhere close
 * rather than back on the default.
 */
const RETIRED_THEMES: Record<string, AccentTheme> = {
	gold: "lime",
	purple: "coral",
	pink: "coral",
	brown: "orange",
	teal: "sky",
};

export function getAccentTheme(): AccentTheme {
	const stored = localStorage.getItem(KEY);
	const retired = stored === null ? undefined : RETIRED_THEMES[stored];
	if (retired) {
		localStorage.setItem(KEY, retired);
		return retired;
	}
	return isAccentTheme(stored) ? stored : DEFAULT_ACCENT_THEME;
}

/** Black's fill inverts with the page, so it is the only accent whose glyph
 *  changes with the appearance. Honey's white glyph is the palette's one
 *  deliberate low-contrast pairing; see its block in base.css. */
export function getOnAccentInk(
	theme: AccentTheme,
	tone: "light" | "dark",
): "#000000" | "#ffffff" {
	return theme === "mono" && tone === "dark" ? "#000000" : "#ffffff";
}

export function applyAccentTheme(theme: AccentTheme = getAccentTheme()) {
	document.documentElement.dataset.accent = theme;
}

function publishAccentTheme(theme: AccentTheme) {
	void saveUiPrefsApi(getCurrentUser(), { [PREF_KEY]: theme }).catch(() => {});
}

export function setAccentTheme(theme: AccentTheme) {
	localStorage.setItem(KEY, theme);
	applyAccentTheme(theme);
	publishAccentTheme(theme);
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onAccentThemeChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function handleAccentStorageChange(event: Pick<StorageEvent, "key">) {
	// A null key is localStorage.clear(), which resets the accent to its default.
	if (event.key !== KEY && event.key !== null) return;
	applyAccentTheme();
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

if (
	typeof window !== "undefined" &&
	typeof document !== "undefined" &&
	typeof window.addEventListener === "function"
) {
	window.addEventListener("storage", handleAccentStorageChange);

	// The inline bootstrap applies this before paint; repeat it on import so the
	// contract still holds if that bootstrap is ever removed.
	const theme = getAccentTheme();
	applyAccentTheme(theme);
	publishAccentTheme(theme);
}
