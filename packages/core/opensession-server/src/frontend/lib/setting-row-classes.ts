/**
 * The row a settings popover is made of. Shared by the sidebar's filter panel
 * and the review's code-view panel, which are the same object in two places
 * and so have to read as one. The components that use these live in
 * `ui/setting-row`; the strings are here so a panel can dress a row of its own
 * (an "Advanced" menu trigger, a link out to another screen) in the same box.
 *
 * One rule holds the vocabulary together: every setting is ONE row, its name
 * on the left in `text-dim` and the control that answers it pinned to the
 * right, and the shape of that control follows the shape of the answer. On and
 * off gets a switch. Two or three one-word answers that all deserve to be read
 * get a `size="sm"` segmented. Phrase-length answers, or a set that can grow,
 * get a value row, where the row itself is the trigger and the answer sits
 * beside a chevron.
 *
 * The rows wear the popup's vocabulary (a menu row's corner and hover wash),
 * never a field's. A bordered field per row puts a column of the strong
 * hairline on a panel whose whole job is to be quiet, a 7px box inside a 16px
 * panel corner reads square, and fields sized to their own longest option
 * left-ragged the column. Without the frames the values are the only thing to
 * read, and every control lands on one right-hand x.
 *
 * The phone step is the row's own rather than the panel's: 36px is a
 * comfortable pointer row and a tight thumb one, and the whole row is the
 * target, so its padding is all that stands between it and 44.
 */
export const SETTING_ROW =
	"flex w-full items-center gap-3 rounded-md px-2 py-2 phone:py-3 text-left text-item-title";

/** A row you can press: the value rows and the switch rows, whose whole box is
 *  the target. A row holding a segmented control does not take this, because
 *  there the options are the targets and the row is only their label. */
export const SETTING_ROW_PRESSABLE =
	"cursor-pointer select-none hover:bg-hover data-[popup-open]:bg-hover";

/** The leading glyph in a row and in its menu: one 16px box either way, so a
 *  list where only some options carry one keeps its labels on a single x. */
export const SETTING_GLYPH =
	"flex size-4 shrink-0 items-center justify-center text-dim";
