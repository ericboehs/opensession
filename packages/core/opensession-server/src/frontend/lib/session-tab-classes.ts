/**
 * The session tab strip's vocabulary, as finished utility classes — what used
 * to be the `session-tab*` family in legacy.css.
 *
 * Two things shape everything here.
 *
 * 1. The strip has TWO complete looks, not one look with tweaks. On desktop it
 *    is a flat band in flow: plain-text tabs on the transcript's own
 *    background, closed off by a bottom hairline that the active tab's underline
 *    rests on. On phones it is a solid bar docked under the floating header pills,
 *    and its tabs are floating pills with a fill, a ring and a shadow. The old
 *    sheet wrote the pill unconditionally and then had `@media (min-width:
 *    721px)` undo every paint property of it, and that shape is kept: the pill
 *    is unprefixed and the flat band overrides it at `desktop:`. Tailwind
 *    emits every breakpoint variant after every unprefixed and pseudo-class
 *    utility (verified in the compiled sheet: `hover:bg-hover` at ~93k,
 *    the first `desktop:` rule at ~119k), which is what makes a responsive
 *    override reliable at all. Note that Tailwind's `phone:` is
 *    `width < 720px`, NOT the `max-width: 720px` the old sheet and
 *    `useIsPhone` mean — so phone-only rules are written as overrides on a
 *    base that already reads correctly, never as one half of a split.
 *
 * 2. For the same reason, each tab state carries its WHOLE colour set. A
 *    colored tab does not layer a fill over the plain tab's fill; `tabClass`
 *    returns exactly one background, one border colour and one box-shadow per
 *    state. That is also why the states are resolved in JS: the old cascade
 *    picked a winner by rule order (colored beats waiting beats active), and a
 *    stack of utilities cannot reproduce "later rule wins" reliably.
 *
 * A few class names survive on the markup as bare hooks with no styling of
 * their own, because things OUTSIDE this file name them:
 *
 *   · `session-tabs`   — legacy.css keys a structural rule off the strip's
 *     presence from an ancestor this file can't reach
 *     (`.detail-topbar:has(+ .session-tabs) .detail-topbar-title` drops the
 *     top bar's border, because the strip carries both dividers itself), and
 *     SessionSplit sizes the bar with `[&>.session-tabs]:shrink-0`;
 *   · `session-tab-view` / `session-tab-reorder` — `.app:has(.session-tab-view)
 *     .app-header-overlay` and `.detail-pane:has(.session-tab-reorder ~
 *     .session-tab-reorder)` set the phone header's fill and
 *     `--strip-clearance` on elements that belong to other components.
 *
 * The dots used to be a third pair of hooks, for base.css's reduced-motion
 * exception list; they now carry that exception themselves — see `tabDotClass`.
 */

/** 8px, the tab pill's corner. Authored the way base.css authors every corner
 *  so it tracks the squircle bump; there is no 8px step in the radius scale. */
const PILL = "rounded-[calc(8px*var(--rf))]";

/* ── The strip ──────────────────────────────────────────────────────────── */

/**
 * The bar itself. `group/strip` is what reveals the trailing +/history
 * controls, which are quiet chrome until the strip is pointed at.
 *
 * The old rule painted a `linear-gradient(var(--topbar-bg), var(--bg))` here,
 * but BOTH breakpoints set `background: var(--bg)` over it, so the gradient
 * never reached a screen; the same is true of its 6px/8px padding. Neither is
 * carried over.
 */
export const TAB_STRIP =
	"session-tabs group/strip flex min-w-0 shrink-0 items-center gap-[3px] bg-surface px-2 " +
	// Desktop: a compact flat band, closed off by the one rule the active tab's
	// underline rests on. Only the bottom edge is drawn. The session header
	// above carries no border of its own, and a top inset here would put a
	// second line across a top region meant to read as one surface.
	//
	// The non-split bar takes its 5px header overlap at the call site. Split bars
	// start at the top of an overflow-clipped column, so their full box stays in
	// flow instead of losing its top edge outside that column.
	"desktop:h-10 desktop:items-stretch desktop:py-0 " +
	"desktop:shadow-[inset_0_-1px_0_var(--border)] " +
	// Phone: pulled out of flow and pinned flush under the header's bottom edge,
	// so it reads as fixed chrome rather than a strip the transcript scrolls by.
	"phone:absolute phone:inset-x-0 phone:top-[var(--pane-header-h)] phone:z-[6] " +
	"phone:m-0 phone:border-b phone:border-line phone:py-[5px] " +
	"phone:shadow-[0_6px_12px_-8px_rgba(0,0,0,0.22)] " +
	// Mobile Safari can rasterize two composited layers that merely touch with a
	// hairline seam: overlap the header by 2px and add those 2px back as padding.
	"phone:[.app:has(.app-header-overlay)_&]:top-[calc(var(--pane-header-h)_-_2px)] " +
	"phone:[.app:has(.app-header-overlay)_&]:pt-[7px] " +
	// Immersive reading: SessionViewer sets body.chrome-collapsed from the
	// transcript's scroll direction and the bar slides off with the top bar.
	// `transform`, not the `translate` property, because that is what the
	// transition names — and what .app-header-overlay animates beside it.
	"phone:[transition:transform_var(--dur-lg)_var(--ease)] " +
	"phone:[body.chrome-collapsed_&]:[transform:translateY(calc(-100%_-_var(--pane-header-h)_-_8px))] " +
	// A lone session with no view tabs has nothing to switch between, so the
	// strip is pure chrome on a phone — every tab is a .session-tab-reorder
	// wrapper, so "2+ sessions" reads as two adjacent wrappers.
	"phone:[&:not(:has(.session-tab-view)):not(:has(.session-tab-reorder~.session-tab-reorder))]:hidden";

/**
 * The scrolling half of the strip. Its edge fades are driven by a CSS scroll
 * timeline — no scroll listeners, no re-renders — and are gated on the
 * `data-overflow` attribute the component writes, because a timeline that goes
 * INACTIVE holds its last value instead of reverting.
 */
export const TAB_SCROLL =
	// `flex-[1_1_auto]`, not `flex-1`: Tailwind's shorthand is `1 1 0%`, and a
	// zero basis sizes the scroll from nothing rather than from its tabs.
	"flex min-w-0 flex-[1_1_auto] items-center gap-[3px] overflow-x-auto overscroll-x-contain " +
	"[scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
	// Hug the content on desktop so the pinned "+" sits right after the last tab
	// rather than being pushed to the far right; full-height so its tabs can
	// stretch down to the band's baseline hairline.
	"desktop:flex-[0_1_auto] desktop:items-stretch " +
	"supports-[animation-timeline:scroll()]:[animation:session-tabs-fade-start_1ms_both,session-tabs-fade-end_1ms_both] " +
	"supports-[animation-timeline:scroll()]:[animation-timeline:scroll(self_inline),scroll(self_inline)] " +
	"supports-[animation-timeline:scroll()]:[animation-range:0_24px,calc(100%_-_24px)_100%] " +
	"supports-[animation-timeline:scroll()]:data-[overflow]:[mask-image:linear-gradient(to_right,transparent_0,#000_var(--tabs-fade-start),#000_calc(100%_-_var(--tabs-fade-end)),transparent_100%)]";

/**
 * The drag-to-reorder group wraps EVERY tab — sessions and view panes alike —
 * so a pane can be dragged in among the sessions. `flex-none` is load-bearing:
 * the tabs inside never shrink, so a group allowed to shrink would collapse
 * below its content and the last tab would paint over whatever the scroll laid
 * out after the shrunken box. Sizing to content pushes the overflow out to the
 * scroll, which is the thing that scrolls.
 */
export const TAB_GROUP =
	"relative inline-flex flex-none items-center gap-[3px] " +
	"desktop:self-stretch desktop:items-stretch";

/** Each tab's Reorder.Item wrapper. `relative` lets whileDrag's z-index lift
 *  the dragged tab over its siblings. */
export const TAB_ITEM =
	"session-tab-reorder relative inline-flex shrink-0 items-center " +
	"desktop:self-stretch desktop:items-stretch";

/** Picked up: desktop tabs are flat labels on the strip's own background, so a
 *  dragged one has no surface of its own and smears over every tab it passes.
 *  It lifts into an opaque chip instead. */
export const TAB_ITEM_DRAGGING = `${PILL} cursor-grabbing bg-panel smooth-shadow-ring-sm`;

/**
 * Where the dragged tab will land. Reorder already opens the gap live, but an
 * empty hole between two bare labels reads as nothing, so this paints a thin
 * insertion rule at the slot's leading edge — a caret, not a second chip
 * competing with the tab in hand. Above the dragged chip on purpose: the chip
 * follows the pointer while the slot snaps to whole positions, so a caret
 * painted underneath would vanish exactly when the order changes.
 */
export const TAB_DROP_SLOT =
	"pointer-events-none absolute inset-y-2 z-[5] " +
	"[animation:tab-drop-slot-in_var(--dur-micro)_var(--ease)] [transition:left_var(--dur)_var(--ease)] " +
	"motion-reduce:animate-none motion-reduce:transition-none " +
	"after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:rounded-[1px] after:bg-accent after:content-['']";

/** Trailing controls pinned after the scroll on desktop. */
export const TAB_ACTIONS = "ml-auto flex flex-none items-center gap-[3px]";

/* ── A tab ──────────────────────────────────────────────────────────────── */

/**
 * Everything a tab is regardless of state: box, type and the interaction
 * transition. The label was 12px, which is not a step on the type scale; it is
 * interface copy, so it snaps UP to `text-label` (13px) — which is also what
 * the phone rule already set on the title, so the two viewports now agree
 * instead of differing by a pixel.
 */
const TAB_BASE =
	"inline-flex max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap " +
	"px-2.5 py-1.5 text-label transition-[background-color,color] " +
	// A floating pill with a solid fill, so the transcript scrolling underneath
	// never shows through it. (`--tab-stroke`, the ring's colour in the old
	// sheet, was never set anywhere — it always resolved to transparent.)
	`border ${PILL} smooth-shadow-sm ` +
	// Desktop: no fill, ring, lift or rounding — just the label.
	"desktop:relative desktop:rounded-none desktop:border-0 desktop:bg-transparent " +
	"desktop:shadow-none desktop:hover:bg-transparent " +
	// …and the underline, which every state paints by naming a colour in
	// `--tab-line` (see `tabClass`) rather than by writing a rule of its own.
	// It is a pseudo-element and not the inset box-shadow it used to be
	// because a shadow can only trace the whole box, and this line is 6px
	// shorter than that at each end: full width, it ran within 3px of the next
	// tab's, which is what made two tabs read as one rule. 6px and not the
	// 10px padding, so the line still overhangs the content it marks — cut to
	// the content box it looked like a text decoration, and stopping it before
	// the close × (which it did briefly) left it visibly short of the tab.
	"desktop:after:absolute desktop:after:inset-x-1.5 desktop:after:bottom-0 " +
	"desktop:after:h-0.5 desktop:after:rounded-[1px] desktop:after:content-[''] " +
	"desktop:after:bg-[var(--tab-line,transparent)]";

export type TabState = {
	active: boolean;
	waiting: boolean;
	/** A user-chosen swatch, supplied inline as `--tab-color`. */
	colored: boolean;
};

/**
 * One tab, painted for exactly one state.
 *
 * The order of the branches below is the order the old stylesheet resolved:
 * colored beats waiting beats active beats plain, because equal-specificity
 * rules were written in that order. Desktop moves the whole cue to the
 * underline, since a flat tab has no pill to tint.
 */
export function tabClass(state: TabState): string {
	const { active, waiting, colored } = state;
	const ink = active || waiting ? "text-fg" : "text-dim hover:text-fg";

	// Desktop: one — and only one — underline, drawn by TAB_BASE from the colour
	// named here. 2px, which is the weight every other tab strip in the app
	// selects with (Reviews writes the same cue as `border-b-2 border-b-accent`);
	// at 3px the bar was a slab of full-strength ink next to a hairline band.
	// That leaves active and waiting on the same weight, so waiting carries the
	// colour instead: blue, the same "needs you" the tab's own dot and the
	// sidebar row already speak.
	//
	// Ink rather than --accent for the plain active tab. The accent is a chosen
	// hue, and a strip of tabs is the app's own chrome: which tab you are on is
	// structure, not a status worth spending the one saturated colour on, and
	// at full strength beside a hairline band it was the loudest thing in the
	// header. --text also inverts with the theme for free, which is what keeps
	// the mark reading as "this one" on paper as well as on ink.
	const underline = active
		? "[--tab-line:var(--text)]"
		: waiting
			? "[--tab-line:var(--blue)]"
			: colored
				? "[--tab-line:color-mix(in_srgb,var(--tab-color)_70%,transparent)]"
				: "";

	// One fill + one ring per state, hover included: a second background
	// utility in the same variant bucket would be resolved by Tailwind's output
	// order rather than by which state is meant to win.
	const pill =
		colored && active
			? "border-[color-mix(in_srgb,var(--tab-color)_60%,transparent)] " +
				"bg-[color-mix(in_srgb,var(--tab-color)_26%,var(--bg-active))] " +
				"hover:bg-[color-mix(in_srgb,var(--tab-color)_26%,var(--bg-active))]"
			: colored
				? "border-[color-mix(in_srgb,var(--tab-color)_50%,transparent)] " +
					"bg-[color-mix(in_srgb,var(--tab-color)_14%,var(--bg-panel))] " +
					"hover:bg-[color-mix(in_srgb,var(--tab-color)_22%,var(--bg-panel))]"
				: waiting
					? // Same hue as the sidebar's "needs you" row and the Needs
						// action band: blocked-on-you is urgent, not informational.
						"border-red bg-red-soft hover:bg-red-soft"
					: active
						? // The pointed-at wash beats the selected fill here, exactly as
							// `.session-tab:hover` (0,2,0) beat `.session-tab-active` (0,1,0).
							"border-transparent bg-[color-mix(in_srgb,var(--bg-active)_94%,var(--text))] hover:bg-hover"
						: "border-transparent bg-panel hover:bg-hover";

	return `${TAB_BASE} ${ink} ${underline} ${pill}`;
}

/** The label. Gives up its width first so a long title truncates instead of
 *  pushing the close × out of the pill. */
export const TAB_TITLE = "max-w-[150px] overflow-hidden text-ellipsis";

/** An icon-only view tab (Staging → a globe): drop the label's text metrics so
 *  the tab sizes to the glyph. */
export const TAB_VICON = "inline-flex items-center justify-center leading-none";

/** Unsent draft in a sibling session. */
export const TAB_DRAFT = "inline-flex flex-none items-center text-dim";

/**
 * Teammates who have THIS tab open. The sidebar answers "someone is in this
 * workspace"; a workspace is a strip of tabs, so the strip is where that
 * answers "which one".
 *
 * The faces sit in a row with a small gap rather than an overlapping pile:
 * a pile needs a gap ring painted in the surface behind it, and a tab has
 * five of those (plain, hover, active, waiting, coloured, and none of them on
 * desktop, where the tab is flat on the strip). Two faces plus a count is
 * also all a 200px tab has room for.
 */
export const TAB_FACES = "flex flex-none items-center gap-0.5";

/** One face. Small enough to read as a marker beside the label, not a
 *  participant list. */
export const TAB_FACE = "shrink-0";

/** "+2" when more people are here than the strip shows faces for. */
export const TAB_FACES_MORE = "text-meta leading-none text-dim";

/** Inline rename input, sized to sit in place of the title. */
export const TAB_RENAME =
	"my-[-1px] max-w-[150px] rounded-xs border border-accent bg-surface px-[3px] font-[inherit] text-[inherit] outline-none";

/* ── Liveness dots ──────────────────────────────────────────────────────── */

/**
 * The running / needs-you dot. "Needs you" is blue throughout — the sidebar
 * already resolved it that way.
 *
 * base.css's reduced-motion block kills every animation with `!important` and
 * then hands a handful of liveness signals back BY CLASS NAME — these two dots
 * among them. That list is the one thing a migration can break silently: the
 * rule stays valid, it just stops matching, and the "still running" pulse
 * freezes for anyone with the preference set with nothing to detect it. So the
 * exception rides the element instead of the list, where it travels with the
 * component; it wins on equal specificity because the utility sheet is linked
 * last, and `!` matches the block it is arguing with.
 *
 * `pulse` is defined by BOTH legacy.css and the utility sheet, and keyframes
 * don't cascade by specificity: the later definition wins document-wide, so
 * every legacy `animation: pulse` has in fact been running the utility sheet's
 * 1 → 0.5 fade rather than the authored 1 → 0.35. Naming the same keyframes
 * here keeps exactly what ships; this is not the place to change it.
 */
const DOT_BASE = "size-1.5 shrink-0 rounded-full";

export const tabDotClass = (waiting: boolean) =>
	waiting
		? `${DOT_BASE} bg-blue shadow-[0_0_6px_var(--blue)] animate-[pulse_1.2s_ease-in-out_infinite] ` +
			"motion-reduce:[animation-duration:1.2s]! motion-reduce:[animation-iteration-count:infinite]!"
		: `${DOT_BASE} bg-yellow animate-[pulse_1.4s_ease-in-out_infinite] ` +
			"motion-reduce:[animation-duration:1.4s]! motion-reduce:[animation-iteration-count:infinite]!";

/** A view tab's status dot (PR state). Shared with the right panel's tabs,
 *  which render the same mark. The caller adds the tone's fill. */
export const PANEL_TAB_DOT = "size-[7px] rounded-full";

/**
 * What that dot means on a Review view-tab: the PR's state, plus the conflict
 * case, which is a mergeability flag rather than a state of its own.
 *
 * A lookup of literal strings because the old spelling was
 * `` `pr-dot-${prState.toLowerCase()}` `` — a class assembled at runtime, which
 * no utility can ever be (Tailwind only compiles names it can find in source).
 * Same tones the rule set, and the same ones lib/sidebar-hover gives these
 * states in the row hover cards.
 */
export const PR_DOT_TONE: Record<string, string> = {
	OPEN: "bg-green",
	MERGED: "bg-purple",
	CLOSED: "bg-red",
	CONFLICT: "bg-yellow",
};

/* ── Per-tab close, and the trailing controls ───────────────────────────── */

const CLOSE_BASE =
	"-my-0.5 -mr-[3px] inline-flex size-4 shrink-0 cursor-pointer items-center justify-center " +
	"rounded-sm border-0 bg-transparent p-0 font-[inherit] text-[15px] leading-none text-dim " +
	"hover:bg-pressed hover:text-fg " +
	// Touch screens can't hover, so the × is always there — with a finger-sized
	// hit area, while the glyph stays small.
	"[@media_(hover:none)]:size-[26px] [@media_(hover:none)]:-mr-1";

/** Revealed with the tab on pointer devices; an active tab keeps its × on. */
const CLOSE_REVEAL =
	"[@media_(hover:hover)_and_(pointer:fine)]:pointer-events-none " +
	"[@media_(hover:hover)_and_(pointer:fine)]:opacity-0 " +
	"[@media_(hover:hover)_and_(pointer:fine)]:transition-opacity " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/tab:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/tab:opacity-100";

export const tabCloseClass = (active: boolean) =>
	active ? CLOSE_BASE : `${CLOSE_BASE} ${CLOSE_REVEAL}`;

/**
 * The trailing "+" and history controls. They are quiet chrome — no pill fill
 * or shadow — and they light up on hover of the strip, on focus (hover cannot
 * be the only way to reach a control) and while their menu is open.
 */
const CTRL_REVEAL =
	"[@media_(hover:hover)_and_(pointer:fine)]:pointer-events-none " +
	"[@media_(hover:hover)_and_(pointer:fine)]:opacity-0 " +
	"[@media_(hover:hover)_and_(pointer:fine)]:transition-opacity " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/strip:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:group-hover/strip:opacity-100 " +
	"[@media_(hover:hover)_and_(pointer:fine)]:focus-visible:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100 " +
	"[@media_(hover:hover)_and_(pointer:fine)]:data-[menu-open]:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:data-[menu-open]:opacity-100 " +
	"[@media_(hover:hover)_and_(pointer:fine)]:data-[popup-open]:pointer-events-auto " +
	"[@media_(hover:hover)_and_(pointer:fine)]:data-[popup-open]:opacity-100";

const CTRL_BASE =
	"inline-flex min-h-[36px] shrink-0 cursor-pointer items-center whitespace-nowrap " +
	`border border-transparent bg-transparent px-3.5 py-1.5 ${PILL} ` +
	"font-[inherit] leading-none text-dim transition-[background-color,color] " +
	"hover:bg-hover hover:text-fg";

/**
 * New-tab "+". A comfortable square hit area on touch; on desktop a real
 * control on the same footprint and weight as the header's ⋯ menu, centered
 * on the same line as the tab labels.
 */
export const TAB_NEW =
	`${CTRL_BASE} justify-center text-[15px] ` +
	"desktop:min-h-auto desktop:self-center desktop:rounded-control " +
	"desktop:px-[5px] desktop:py-[3px] desktop:text-[22px] " +
	CTRL_REVEAL;

/**
 * Archived-sessions menu. Same desktop footprint as the "+" it sits beside:
 * the two are one pair of quiet square controls after the last tab, and a
 * taller plate here read as a control stretched to fill the 40px band. Stays
 * lit while its menu is open (`data-popup-open`).
 */
export const TAB_HISTORY =
	`${CTRL_BASE} justify-center ` +
	"desktop:min-h-auto desktop:self-center desktop:rounded-control " +
	"desktop:px-[5px] desktop:py-[3px] " +
	"data-[popup-open]:bg-hover data-[popup-open]:text-fg " +
	CTRL_REVEAL;

/** The + tab's right-click mode menu (share / stacked / ask): a fixed popup
 *  anchored at the cursor, so it escapes the tab strip's overflow clipping.
 *  This carries the surface too — it used to come from `.tab-color-menu`, a
 *  rule named after the swatch row it no longer dresses (those chips live in the
 *  tab context menu now). Above every other popup on the pane at z-1000. */
export const NEW_MENU =
	"fixed z-[1000] flex min-w-[250px] flex-col gap-px rounded-popup bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] p-1 " +
	"smooth-shadow-ring-md";
export const NEW_MENU_ITEM =
	"block w-full cursor-pointer whitespace-nowrap rounded-[calc(6px*var(--rf))] border-0 " +
	"bg-transparent px-2 py-1.5 text-left text-label text-fg hover:bg-hover";

/* ── Tab colour swatches ─────────────────────────────────────────────────────
   The row of colour chips in a tab's context menu. Each chip carries its colour
   as an inline style (the palette is data, see lib/tab-colors), so what's left
   here is the ring, the box and the grow-on-hover.

   `rounded-full` is right on these and only these: the rule spelled a bare
   `border-radius: 50%` with no `corner-shape`, so a chip is a true circle
   rather than one of the app's squircles. The hairline stays the untokenized
   15% white it has always been — it reads as a highlight on a saturated chip,
   not as a chrome border, so `border-line` would be a visual change rather
   than a translation. */
export const TAB_SWATCH =
	"size-[22px] rounded-full border border-[rgba(255,255,255,0.15)] transition-transform hover:scale-[1.18]";

/** The chip for the colour the tab currently wears: a ring in the page ink,
 *  gapped off the chip by the panel it sits on. */
export const TAB_SWATCH_ON = "shadow-[0_0_0_2px_var(--bg-panel),0_0_0_3px_var(--text)]";

/** The "no colour" chip: an empty ring with a diagonal strike. */
export const TAB_SWATCH_NONE =
	"relative bg-active after:absolute after:inset-[3px] after:rotate-45 after:border-t " +
	"after:border-t-faint after:content-['']";
