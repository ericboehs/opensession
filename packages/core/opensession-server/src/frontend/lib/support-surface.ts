/**
 * Where the Plain queue lives: the band at the bottom of the sidebar, the
 * Support tool's own page, or nowhere.
 *
 * The two surfaces answer the same question differently. The band opens a
 * ticket's WORKSPACE, so the answer arrives with a session, a tab strip and a
 * transcript around it; the tool opens the TICKET, with the queue beside it and
 * no chat. Which one someone wants is a preference, not a pair of unrelated
 * visibility toggles, so this reads and writes it as one choice.
 *
 * Never both. Two entry points into one queue is a fork in every habit built
 * on it, and a sidebar that lists the same 84 tickets twice reads as a bug.
 *
 * It deliberately stores nothing of its own. Both halves already have a
 * per-user, cross-device preference: the hidden-tools list (sidebar-tools.ts)
 * and the hidden-sources list (sidebar-feeds.ts). A third key holding the same
 * fact would be one more thing to keep in step, and would fight the ticks in
 * the sidebar's own menu. So the choice is derived from those two, and setting
 * it writes both.
 */

import { setSidebarFeedVisible } from "./sidebar-feeds";
import { setSidebarToolVisible } from "./sidebar-tools";

/** The Plain feed's id, which is also the Support tool's id: one queue, and
 *  the two surfaces are keyed to it on either side. */
export const PLAIN_ID = "plain";

export type SupportSurface = "sidebar" | "page" | "off";

export const SUPPORT_SURFACE_OPTIONS: { value: SupportSurface; label: string }[] =
	[
		{ value: "sidebar", label: "In the sidebar" },
		{ value: "page", label: "As a tool" },
		{ value: "off", label: "Off" },
	];

/** The two places it can live, without the off state. For surfaces that show
 *  on/off some other way — a tick on the row it sits in — where a third
 *  "Off" row would be the same switch twice. */
export const SUPPORT_PLACEMENT_OPTIONS = SUPPORT_SURFACE_OPTIONS.filter(
	(option) => option.value !== "off",
);

/** Where it goes when switched back on. Nothing records the placement it had
 *  before it went off (the two lists this is derived from only say what is
 *  showing), and the band is where the queue lived before the tool existed. */
export const DEFAULT_SUPPORT_PLACEMENT: SupportSurface = "sidebar";

/**
 * Which surface is on, as one choice.
 *
 * Storage can still say both, because the two lists it is derived from are
 * older than this choice and each is independently editable: adding the
 * Support tool switched it on for everyone who had ever arranged their tools,
 * on top of the band they already had. Nobody chose that, so it resolves to
 * the band, which is what those accounts had before the tool existed. The
 * page is then one setting away rather than something that happened to them.
 */
export function supportSurfaceOf(
	toolShown: boolean,
	bandShown: boolean,
): SupportSurface {
	if (bandShown) return "sidebar";
	if (toolShown) return "page";
	return "off";
}

/** Does the Support TOOL render? False whenever the band is on, so the two can
 *  never both be up, whatever the two underlying lists say. */
export function supportToolShown(
	toolShown: boolean,
	bandShown: boolean,
): boolean {
	return supportSurfaceOf(toolShown, bandShown) === "page";
}

export function setSupportSurface(surface: SupportSurface) {
	setSidebarToolVisible(PLAIN_ID, surface === "page");
	setSidebarFeedVisible(PLAIN_ID, surface === "sidebar");
}
