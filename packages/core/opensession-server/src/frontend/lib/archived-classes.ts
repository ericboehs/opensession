/**
 * A plain list rather than a bordered card. At 200 rows an outer border is a
 * box around the page itself; inset row separators carry the useful structure.
 */
export const ARCHIVED_LIST = "-mx-3";

/** Section labels and row contents share the page's content edge. The list
 * itself extends 12px beyond it so the hover wash has room to breathe. */
export const ARCHIVED_SECTION_LABEL =
	"m-0 px-3 pb-1.5 text-meta font-semibold text-faint";

export const ARCHIVED_SECTION_ROWS = "m-0 list-none p-0";

/**
 * A row. `relative` positions three things: the separator below it, the
 * open-button's full-bleed overlay (see ROW_OPEN) and the action that has to
 * sit above that overlay.
 *
 * `focus-within:bg-hover` matters as much as the hover: with the whole row
 * clickable through an overlay, keyboard focus lands on a button whose visible
 * text is only the title — lighting the row is what says how far the target
 * reaches.
 *
 * The separator is the row's own `::after`, inset past the repo tile and gone
 * on the last row. It also clears out around the highlight: the
 * hovered row hides its own, and `:has(+ li:hover)` hides the one above it, so
 * a lit row is a clean slab rather than a strip with a line cutting its corner
 * — the same tidying an iOS list does around a highlighted cell.
 */
export const ARCHIVED_ROW =
	"group relative flex items-start gap-3 rounded-control px-3 py-2.5 transition-colors " +
	"duration-[var(--dur-micro)] ease-[var(--ease)] hover:bg-hover focus-within:bg-hover " +
	"after:pointer-events-none after:absolute after:right-3 after:bottom-0 after:left-[42px] " +
	"after:h-px after:bg-line after:transition-opacity after:duration-[var(--dur-micro)] " +
	"last:after:opacity-0 hover:after:opacity-0 focus-within:after:opacity-0 " +
	"[&:has(+li:hover)]:after:opacity-0 [&:has(+li:focus-within)]:after:opacity-0 " +
	"phone:gap-2.5 phone:py-3 phone:pr-[54px] phone:after:left-[40px]";

/**
 * The open action, stretched over the whole row by its own `::after` so a click
 * anywhere opens the session — including on the repo tile and the timestamp,
 * which are not themselves interactive. The ring stays on the title (the thing
 * a reader is aiming at); the row's `focus-within` wash carries the rest.
 */
export const ARCHIVED_ROW_OPEN =
	"focus-ring min-w-0 flex-1 cursor-pointer rounded-sm border-none bg-transparent p-0 " +
	"text-left after:absolute after:inset-0 after:content-['']";

export const ARCHIVED_ROW_TITLE =
	"block truncate text-label text-fg phone:text-body";

/** The line under the title, and only when it has something to say — see the
 *  meta rules in the component: a field the current filter already fixes is
 *  the same word on every row. */
export const ARCHIVED_ROW_META =
	"mt-1 flex min-w-0 items-center gap-2.5 text-meta text-faint";

/** The timestamp and disclosure affordance step aside for Restore on hover. */
export const ARCHIVED_ROW_TRAIL =
	"flex shrink-0 items-center gap-0.5 text-faint transition-opacity " +
	"duration-[var(--dur-micro)] ease-[var(--ease)] group-hover:opacity-0 " +
	"group-focus-within:opacity-0 phone:hidden";

export const ARCHIVED_ROW_TIME =
	"w-[62px] text-right text-meta leading-none tabular-nums";

/**
 * Restore: absolutely placed over the timestamp it replaces, so a row
 * costs no width for an action that is usually not wanted. Revealed by hover,
 * by focus, and unconditionally where hover can't reveal it — a control that
 * only exists on `:hover` does not exist on a phone.
 *
 * Both the width query and the pointer query, and deliberately: `phone:` is
 * the one a narrow window can be checked against (a hover-capable browser
 * never matches `hover: none`, so a rig that emulates a phone by size alone
 * would show the row reserving space for a button it never draws), and the
 * pointer query is what catches a touch device that isn't phone-width.
 *
 * The label collapses to its glyph on phones — spelled out it costs a quarter
 * of a 390px row, and the row is mostly title.
 */
export const ARCHIVED_ROW_ACTION =
	"absolute right-3 top-1.5 z-[1] opacity-0 transition-opacity " +
	"duration-[var(--dur-micro)] ease-[var(--ease)] group-hover:opacity-100 " +
	"focus-visible:opacity-100 phone:top-0 phone:min-h-11 phone:w-11 phone:gap-0 phone:px-0 phone:opacity-100 " +
	"[@media(hover:none)]:opacity-100";
