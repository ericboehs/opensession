/**
 * The workspace summary: the session header's floating stand-in for the right
 * Workspace panel, and the smaller version of it.
 *
 * It is a list of quiet rows, not a dashboard. One glyph, one label, and a
 * value or an action parked at the right edge. Nothing inside it carries a
 * fill of its own: no plates, no cards, no boxed sections. On first sight it
 * is text on one surface, and the only paint that ever appears is the hover
 * pill under the pointer. That is what lets the labels do the work, and it is
 * why the one row that has something to report (a failing check, a diff's
 * +/−) is the only thing in the card with colour.
 *
 * Rows are full-width buttons rather than text with a link inside: the whole
 * row is the target, which is what makes a 300px card usable without aiming.
 *
 * The grammar is the left sidebar's, deliberately. A shared leading rail, a
 * band label over its own rows, and the same `rounded-row` pill under the
 * pointer. This is the sidebar's shape at the other edge of the window, so it
 * should not need learning twice.
 */

/**
 * The popup body. Fixed width, so the rows truncate rather than reflow and a
 * long branch name cannot make the card wider than the header it hangs from.
 *
 * It caps its own height and scrolls, because the list is open-ended at the
 * bottom: a session with a dozen assets would otherwise grow the card past
 * the window. Everything above the assets is short and never scrolls in
 * practice.
 *
 * No radius, fill or shadow here: `ui/popover.tsx` gives every popup the same
 * `rounded-popup` glass card, and this one has no reason to be a different
 * object from the rest of them.
 */
export const WS_SUMMARY_CARD =
	"flex max-h-[min(72vh,640px)] w-[300px] flex-col overflow-y-auto py-2";

/**
 * Band label ("Assets"), taken from the sidebar so the card heads its lists
 * the way the sidebar heads its own. It shares the rows' 16px content rail and
 * their 31px pitch, so it does not sit tighter than the list it heads.
 *
 * The band above it has no label. It holds the state of the work itself, which
 * is what the card IS, and a heading over it could only repeat the card's own
 * name back at you.
 */
export const WS_SUMMARY_SECTION =
	"flex h-[31px] shrink-0 items-center px-4 text-label font-semibold text-dim";

/**
 * A row. 31px tall on a 300px card, which is the proportion a dense list needs
 * before it stops reading as a cramped menu. Anything under about 28 and the
 * glyph column and the labels start to crowd.
 *
 * `group/ws` lets a trailing action fade in on hover without reserving its own
 * hover state.
 */
export const WS_SUMMARY_ROW =
	"group/ws mx-2 flex h-[31px] w-[calc(100%_-_16px)] min-w-0 shrink-0 cursor-pointer items-center gap-3.5 " +
	"rounded-row border-none bg-transparent px-2 text-left text-item-title text-fg " +
	"hover:bg-hover focus-ring";

/**
 * The one row that holds a real control: the PR headline and its action
 * (Merge, Push, Pull, Resolve). Taller than a plain row because a button has
 * its own height, and unhoverable because it is not one target: the label goes
 * to the PR, the button does the thing.
 */
export const WS_SUMMARY_STATUS_ROW =
	"mx-2 flex min-h-[38px] w-[calc(100%_-_16px)] min-w-0 shrink-0 items-center gap-3.5 " +
	"rounded-row px-2 text-left text-item-title text-fg";

/**
 * The leading column every row opens with, whatever it holds: a glyph, an
 * asset's thumbnail, or nothing at all. It is the sidebar's rail at this
 * card's scale, and for the same reason: sized once here, so the marks share a
 * centre line AND the labels after them share a left edge.
 *
 * Measured before it existed: an icon, a 16px thumbnail and a bare spacer
 * came out 20, 16 and 15 wide, which fanned the labels of one list across
 * three different left edges. 20px because that is what the icon set actually
 * draws — `Svg` in components/icons.tsx clamps `size` up to a 20px minimum, so
 * a row asking for 15 was never getting it.
 */
export const WS_SUMMARY_RAIL = "grid size-5 shrink-0 place-items-center";

/** A glyph in that rail. Faint: the label is the content, the icon only says
 *  which kind of thing the row is. */
export const WS_SUMMARY_ICON = "text-faint";

/** The label. It truncates, because a PR title or a worktree path is routinely
 *  longer than the card. */
export const WS_SUMMARY_LABEL = "min-w-0 flex-1 truncate";

/** Right-edge action word ("Fix", "Pull", "Commit"). Reads as text until the
 *  row is hovered, then takes the accent, because the row itself is the
 *  button. */
export const WS_SUMMARY_ACTION =
	"shrink-0 text-meta font-medium text-dim group-hover/ws:text-accent";

/** A count parked at a place row's right edge (live portals, working agents).
 *  Tone comes from the caller; a number that only reports gets `text-faint`,
 *  one that means something is running gets `text-yellow`, exactly as the
 *  panel's own bottom bar reads them. */
export const WS_SUMMARY_COUNT = "shrink-0 text-meta tabular-nums";

/** Hairline between two bands. Inset to the rows' own gutter, so it divides
 *  the list rather than cutting the card. */
export const WS_SUMMARY_DIVIDER = "mx-4 my-2 h-px shrink-0 bg-line";

/** The PR row's trailing state word ("Draft", "Merged", "Changes requested").
 *  Tone comes from the caller; this is only the shape. */
export const WS_SUMMARY_STATE = "shrink-0 text-meta font-medium";

/* A reviewer's face is drawn by `UserAvatar`, not by a class here: it resolves
 * the roster picture, the GitHub fallback and the initials tile, and it wears
 * the person mark the sidebar and the presence pile already use. A local
 * avatar class was tried and only produced a second shape for the same thing.
 */

/** An asset's preview, centred in the rail above. A 16px tile inside a 20px
 *  slot, the same inset the sidebar gives its repo tiles: a filled image next
 *  to line art wants to sit a little smaller than the glyphs, or it reads as
 *  the heaviest thing in the list. */
export const WS_SUMMARY_THUMB =
	"size-4 overflow-hidden rounded-sm border border-line bg-panel object-cover";
