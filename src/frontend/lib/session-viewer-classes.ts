/**
 * The session viewer's own chrome, as finished utility classes — what used to
 * be the `viewer-*` family in legacy.css, plus the banner row and the
 * delete-in-flight label that sit with it.
 *
 * Everything that used to be keyed off an ancestor is an arbitrary variant on
 * the element itself, so the whole subtree moves in one step: a compound
 * legacy selector outranks a single utility, and a half-migrated element
 * quietly keeps its old styling.
 *
 * Three class names stay on the markup as bare hooks with no styling of their
 * own, because things outside this family name them:
 *
 *   · `viewer-header` — base.css makes the row a native titlebar drag region
 *     in the desktop shell (`html.wco .viewer-header`), with no-drag carve-outs
 *     for everything interactive inside it. That is a rule about descendants of
 *     an element in a platform state; it cannot be a utility;
 *   · `viewer-header-actions` — lib/pr-tone-classes.ts spaces the PR chip off
 *     the row with `[.viewer-header-actions_&]:mx-1.5`;
 *   · `viewer-messages` — base.css's selection policy opts the whole transcript
 *     in, and MarkdownBody, VirtualTranscriptBlock and CodeHighlight all find
 *     their scroll container with `closest(".viewer-messages")`.
 *
 * One more joins them from the row's contents:
 *
 *   · `session-link` — lib/markdown.ts writes it into rendered agent output,
 *     where base.css styles the chip form (`.session-link[data-session-id]`).
 *     There is no JSX there to hang utilities on. The header's own links are a
 *     different element wearing the same name, and they carry their styling as
 *     utilities (SESSION_LINK below).
 *
 * `presence` used to be a fourth: the only rule that named it spaced the
 * facepile off the ⋯ cluster, and that margin now sits on VIEWER_PRESENCE
 * itself, so the name is gone from the markup rather than kept as a hook for
 * nothing.
 */

/* ── Top bar ────────────────────────────────────────────────────────────── */

/**
 * Fixed height so the bar lines up with the sidebar's brand row instead of
 * growing with its tallest button — including when a tab strip follows, where
 * trimming the row to pull the labels together cost that alignment. The session
 * body's colour rather than the lifted topbar tint keeps the whole top region
 * reading as one surface — the PR strip sharing the row takes the same one.
 *
 * One drawn hairline divides the bar from the content, in the same ink and at
 * the same height as the PR strip's beside it, so the line runs unbroken across
 * the whole top row. A scroll-driven wash used to do the separating instead,
 * which dimmed the rows passing under the bar rather than dividing anything.
 * The hairline drops when the tab strip follows the bar, leaving the strip's
 * own bottom inset as the single divider above the content.
 */
export const VIEWER_HEADER =
	"viewer-header flex h-[var(--desktop-header-h)] min-w-0 shrink-0 items-center justify-between gap-3 " +
	"bg-surface px-4 " +
	"border-b border-b-[var(--top-divider)] " +
	"[.detail-topbar:has(+_.session-tabs)_&]:border-b-0 " +
	// Collapsed desktop sidebar: the floating re-open + nav cluster overlays the
	// pane's left edge, so the row's text starts past it.
	"desktop:[.app-body.sidebar-collapsed_&]:pl-[148px] " +
	// On phones the bar is a set of floating pills inside the app header, not a
	// row of its own.
	"phone:[.app-header-actions_&]:h-auto phone:[.app-header-actions_&]:gap-1.5 " +
	"phone:[.app-header-actions_&]:border-0 phone:[.app-header-actions_&]:bg-transparent " +
	"phone:[.app-header-actions_&]:p-0";

/** Workspace name + origin chip + status. Hidden on phones, where the ⋯ menu
 *  carries what it holds. */
export const VIEWER_TITLE =
	"flex min-w-0 items-center gap-2.5 font-medium phone:hidden";

/**
 * The workspace name. Capped so a long one truncates instead of eating the
 * whole bar; it still shrinks below that when the row runs out of room. The
 * shell makes the surrounding header a native window drag region, so this opts
 * out — its text stays selectable and copyable.
 */
export const VIEWER_BRANCH =
	"min-w-0 max-w-[420px] select-text overflow-hidden text-ellipsis whitespace-nowrap text-body " +
	"[-webkit-touch-callout:default] " +
	"[html.wco_&]:[-webkit-app-region:no-drag] [html.wco_&]:[app-region:no-drag]";

/** Double-clickable to rename — hinted on hover without shifting the row. */
export const VIEWER_BRANCH_EDITABLE =
	"-mx-2 -my-[5px] cursor-text rounded-[calc(6px*var(--rf))] px-2 py-[5px] hover:bg-hover";

/** Inline rename input, sized to sit in place of the name. */
export const VIEWER_BRANCH_RENAME =
	"my-[-2px] min-w-0 max-w-[280px] rounded-[calc(8px*var(--rf))] border border-accent bg-surface " +
	"px-1 py-px font-[inherit] text-body text-[inherit] outline-none";

/**
 * The trailing controls. Icon buttons sit in a tight cluster so they read as
 * one group; the labelled items in the row (the Linear/Plain links, the
 * presence facepile, the PR chip) space themselves.
 */
export const VIEWER_HEADER_ACTIONS =
	"viewer-header-actions flex shrink-0 items-center gap-0.5 phone:justify-end " +
	// Phones give every control in the row a real touch target. Keyed off the
	// row rather than written on each control because these are shared
	// primitives (Button, and the source links below): a descendant selector is
	// also what lets it outrank the primitive's own padding, exactly as the
	// legacy rule did. `inline-flex`/`items-center` are not carried — the
	// primitive is already both, on every viewport.
	"phone:[&_button]:min-h-[38px] phone:[&_button]:px-[11px] phone:[&_button]:py-[7px] " +
	"phone:[&_button]:text-[12px]";

/** The presence facepile (Figma/Notion-style), just before Share. Labelled
 *  items in the row space themselves off the icon cluster; the icons keep the
 *  row's tight 2px gap. */
export const VIEWER_PRESENCE = "mr-1.5 flex items-center";

/**
 * One face in it. They overlap by 8px so the pile reads as a stack, and the
 * first one keeps the row's own left edge.
 *
 * No ring here: `.presence-avatar` carried a `box-shadow` meant to separate the
 * faces with the header's colour, but UserAvatar's own `shadow-[var(--avatar-edge)]`
 * is a utility and so already won that tie — the ring has not been drawn for as
 * long as the avatar has been Tailwind-styled. Left as it renders today rather
 * than reintroduced here, which would be a visual change dressed up as a
 * migration.
 */
export const VIEWER_PRESENCE_AVATAR = "-ml-2 first:ml-0";

/**
 * The Linear / Plain / feed links in the header: quiet outlined pills that
 * carry their source's hue. Each variant only re-tints the ink and the edge, so
 * it must come after the base string through `cn()` — two `text-*` utilities on
 * one element resolve by Tailwind's output order, not by the order written.
 *
 * The hues stay literal. They are the sources' brand colours (Linear's indigo,
 * Plain's teal), not steps of the app's palette, so there is no token to reach
 * for and swapping in one would be a redesign.
 */
export const SESSION_LINK =
	"session-link mr-1.5 rounded-control border border-line-strong px-[11px] py-[5px] " +
	"text-label font-semibold text-dim no-underline " +
	// Phones give it the same 38px touch target as the buttons beside it. These
	// sit on the link rather than on the row (where the buttons' copy lives)
	// because this is the element's own styling and nothing else wears the
	// class in this row. Only the declarations that actually change are
	// written: the 11px sides are already the resting value. A `phone:` variant
	// beats the unprefixed `py-[5px]`/`text-label` on the same element because
	// Tailwind emits every breakpoint variant after the unprefixed utilities.
	"phone:inline-flex phone:min-h-[38px] phone:items-center phone:py-[7px] phone:text-[12px]";
export const SESSION_LINK_LINEAR = "border-[rgba(94,106,210,0.5)] text-[#7b86e8]";
export const SESSION_LINK_PLAIN = "border-[rgba(13,148,136,0.5)] text-[#5eead4]";

/** ⋯ overflow: the secondary actions collapse into the shared Menu popup when
 *  they would otherwise crowd the title. */
export const VIEWER_OVERFLOW = "relative inline-flex";

export const VIEWER_DELETE_CONFIRM = "flex gap-1.5";

/* ── Panes ──────────────────────────────────────────────────────────────── */

/**
 * Full-width review host: a flex child of the session column that stretches, so
 * the PrPanel (whose split is `height: 100%`) fills the whole area. Unlike the
 * transcript it doesn't self-pad for the phone's fixed header and docked tab
 * bar, so it is pushed below them instead.
 */
export const VIEWER_REVIEW_MAIN =
	"flex min-h-0 flex-1 flex-col " +
	"phone:pt-[calc(var(--pane-header-h)+var(--strip-clearance,0px))]";

/* ── Transcript ─────────────────────────────────────────────────────────── */

/**
 * Holds the scroll area plus the floating "Jump to latest" pill.
 *
 * Desktop used to paint a scroll-edge wash across the top here, driven by a CSS
 * scroll timeline, so rows dissolved into the header as they passed under it.
 * A drawn hairline on the bar divides the two surfaces instead: the wash dimmed
 * the first legible rows to say what one line says outright. Phones still fade
 * the transcript under their floating pills with a mask (see VIEWER_MESSAGES),
 * where the chrome overlays the content rather than sitting above it.
 */
export const VIEWER_MESSAGES_REGION = "relative flex min-h-0 flex-1 flex-col";

/**
 * The scroll container.
 *
 * Never a sideways-pannable session: anything internally wide (code, tables)
 * scrolls inside its own pane. A flex column rather than block flow, because
 * WebKit paints cross-block selection as full-width bands across a block
 * container — it skips flex containers, so selection hugs the text. That is
 * also why the children need an explicit width: auto side margins centre them,
 * and in a flex container auto cross-axis margins disable `align-items:
 * stretch`, so they would size to their content and overflow sideways.
 *
 * Bottom padding pays for the composer's overlap plus 16px of clear resting
 * space. Older rows can still scroll directly underneath the input instead of
 * stopping above it.
 */
export const VIEWER_MESSAGES =
	"viewer-messages flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain " +
	// Keep the reader's place when content loads or expands above them.
	"[overflow-anchor:auto] px-5 pt-0 pb-[calc(var(--session-under)_+_16px)] " +
	"[&>*]:w-full [&>*]:shrink-0 " +
	// Whatever sits above — the bar's hairline, or the tab strip's when a split
	// gives every column one — the first row would otherwise rest directly on
	// that line. 12px of clear space instead. Only at rest: scrolled content
	// still runs right up under the chrome.
	"desktop:pt-3 " +
	// Phone: clear the floating pills at rest, then scroll under them.
	// --strip-clearance is 0 by default and the docked tab bar's height on a
	// multi-session workspace.
	"phone:px-3 " +
	"phone:pt-[calc(var(--pane-header-h)+var(--strip-clearance,0px)+8px)] " +
	// Dissolve the transcript into the header as it scrolls up under the pills.
	// A non-linear fade mirrored into mask alpha:
	// hidden for the first fifth, 45% by three fifths, full at the bar height.
	"phone:[-webkit-mask-image:linear-gradient(to_bottom,transparent_0,transparent_calc(var(--pane-header-h)*0.2),rgba(0,0,0,0.45)_calc(var(--pane-header-h)*0.6),#000_var(--pane-header-h))] " +
	"phone:[mask-image:linear-gradient(to_bottom,transparent_0,transparent_calc(var(--pane-header-h)*0.2),rgba(0,0,0,0.45)_calc(var(--pane-header-h)*0.6),#000_var(--pane-header-h))] " +
	// With the header slid away, the revealed rows read at full strength rather
	// than dissolving into an absent bar.
	"phone:[body.chrome-collapsed_&]:[-webkit-mask-image:none] " +
	"phone:[body.chrome-collapsed_&]:[mask-image:none]";

/**
 * The composer floats up over the transcript so the session scrolls UNDER it,
 * in normal flow — a negative top margin only shifts it visually, which is what
 * keeps the iOS keyboard handling untouched. Its top padding is deliberately
 * smaller than that margin, so the box rises a few px above where the
 * transcript ends and the last row tucks slightly under it.
 *
 * The input's background is transparent at the top of that overlap and solid
 * by the composer's edge. Content therefore remains crisp as it enters beneath
 * the input, then disappears behind the composer itself without a blank band.
 */
export const VIEWER_INPUT =
	"relative z-[1] mt-[calc(-1*var(--session-under))] shrink-0 px-5 pt-1 pb-3.5 " +
	// The fade is a later sibling of the native scroller, so painting it edge to
	// edge also fades an overlay scrollbar. Leave its narrow gutter unpainted;
	// raising the scroller would incorrectly lift transcript content too.
	"[background:linear-gradient(to_bottom,transparent_0,var(--bg)_var(--session-under))_left_top/calc(100%_-_14px)_100%_no-repeat] " +
	// Phone: clear the home indicator rather than jamming the composer against
	// the very bottom edge — that gap is also all the room the composer's
	// shadow gets in mobile Safari, where there is no safe-area inset.
	"phone:px-3 phone:pb-[max(16px,env(safe-area-inset-bottom,0px))] " +
	// Keyboard up: iOS keeps reporting the inset even though the keyboard now
	// covers that area. Scoped to the EXPANDED composer — the resting pill only
	// shows while the field is unfocused, so it must keep the full gap.
	"phone:[body.kb-open_&:has(.composer:not(.composer-min))]:pb-0";

/* ── Banners and the delete overlay ─────────────────────────────────────── */

export const SESSION_BANNERS =
	"flex flex-wrap gap-2 border-b border-line bg-raised px-4 py-[7px]";

/** A single notice pill. It carries no ink of its own: the caller supplies the
 *  tone, because two text-colour utilities on one element are resolved by
 *  Tailwind's output order rather than the order they are written. 12px in the
 *  old sheet; it is interface copy, so it snaps to `text-label`. */
export const SESSION_BANNER =
	"inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap " +
	"rounded-full border border-line bg-panel px-3 py-[3px] text-label";

/** Shown while a delete (optionally + worktree) is in flight — worktree
 *  cleanup can take a few seconds, so the view shows progress instead of
 *  looking frozen. */
export const SESSION_DELETE_LABEL = "text-label text-dim";

/* ── Floating transcript pills ──────────────────────────────────────────────
 *
 * "Load all" at the top of the transcript, "Scroll to bottom" at its foot, and
 * the loading state each of them swaps to. They float over live content, so
 * they use the same compact opaque capsule as the native app: this is chrome
 * the eye should pass over, not a primary action. `rounded-full` is deliberate
 * here. Unlike the app's squircle radii, it keeps the ends truly round.
 *
 * The padding is asymmetric on purpose. Every one of these carries a leading
 * icon, and an icon brings its own whitespace to the edge, so matching the
 * label's padding on that side reads as a gap. Trimming the leading side by
 * 4px puts the two ends back in optical balance — the same trim Tella makes on
 * its icon+label buttons.
 */

/** Everything but the gap, which is the one value the two states disagree on.
 *  Written this way rather than as an override on top: two `gap-*` utilities on
 *  one element resolve by Tailwind's output order, not by the order they are
 *  written in. */
const PILL_BASE =
	"inline-flex h-[26px] items-center rounded-full bg-panel pr-2.5 pl-2 " +
	"text-xs font-medium text-dim " +
	"[--smooth-ring-width:0.5px] [--smooth-ring-color:var(--line)] smooth-shadow-ring-sm";

export const TRANSCRIPT_PILL = `${PILL_BASE} gap-1.5`;

/**
 * The button form. The hover wash paints on a pseudo-element so it layers over
 * the glass instead of replacing it — which means the pseudo needs the pill's
 * corner treatment too: base.css grants `corner-shape: squircle` by matching
 * `rounded-*` on the ELEMENT, and a pseudo-element matches no selector, so
 * `rounded-[inherit]` alone left a round wash sitting inside a squircle pill
 * with a pale sliver showing at each corner. `corner-shape: inherit` follows
 * whatever the pill resolved to, including the PWA's round-cornered phone case.
 *
 * `after` is the 40px hit target around the 26px visible capsule; it must not
 * paint anything, or it would square off the corners it extends past.
 */
export const TRANSCRIPT_PILL_BUTTON =
	`group relative cursor-pointer ${TRANSCRIPT_PILL} transition-[scale] ` +
	"before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] " +
	"before:[corner-shape:inherit] before:bg-transparent before:transition-colors before:content-[''] " +
	"after:absolute after:-inset-x-1 after:-inset-y-[7px] after:content-[''] hover:before:bg-hover " +
	"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg active:scale-[0.96]";

/** The loading state's leading spinner, and the wider gap it asks for: an arrow
 *  glyph carries side bearing of its own, a bare 12px ring carries none, so at
 *  the label's own spacing the two sit on top of each other. */
export const TRANSCRIPT_PILL_LOADING = `${PILL_BASE} gap-2`;
export const TRANSCRIPT_PILL_SPINNER =
	"size-3 shrink-0 animate-spin rounded-full border border-current/25 border-t-current text-dim";

/* ── Session info page (phone) ──────────────────────────────────────────────
 *
 * Tapping the top-bar title opens this as a deeper page, WhatsApp-style: a
 * full-screen sheet with the session identity up top and every action below,
 * with its own chevron-back to the session.
 *
 * The whole page renders only when `useIsPhone()` is true, so none of it is
 * written as a `phone:` override — which also keeps it clear of the
 * one-pixel disagreement between Tailwind's `max-[720px]` (`width < 720px`)
 * and the `max-width: 720px` that `useIsPhone` and the old sheet mean.
 *
 * `session-info-topbar` and `session-info-status` stay on the markup as bare
 * hooks: the scroll handler finds the bar with `querySelector`, and
 * lib/pr-tone-classes.ts fits the PR strip to the status card with
 * `[.session-info-status_&]`.
 */

export const INFO_PAGE =
	"fixed inset-0 z-[60] flex flex-col gap-0.5 overflow-y-auto overscroll-contain bg-surface " +
	"pb-[max(16px,env(safe-area-inset-bottom,0px))] " +
	"[animation:session-info-in_var(--dur)_var(--ease)]";

const INFO_TOPBAR =
	"session-info-topbar sticky top-0 z-[4] flex items-center border-b " +
	"min-h-[calc(env(safe-area-inset-top,0px)+52px)] " +
	"pt-[env(safe-area-inset-top,0px)] px-2 pb-0 " +
	"[transition:background-color_var(--dur)_var(--ease),border-color_var(--dur)_var(--ease)]";

/** Transparent until the page scrolls, then a frosted bar with a hairline —
 *  each state carries its whole set, since two background utilities in one
 *  variant bucket resolve by Tailwind's output order. */
export const infoTopbarClass = (scrolled: boolean) =>
	`${INFO_TOPBAR} ` +
	(scrolled
		? "border-b-line bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] " +
			"backdrop-blur-[18px] backdrop-saturate-[1.35]"
		: "border-b-transparent bg-transparent");

const INFO_TOPBAR_TITLE =
	"pointer-events-none absolute right-14 bottom-0 left-14 flex h-[52px] items-center justify-center " +
	"overflow-hidden text-ellipsis whitespace-nowrap text-item-title font-semibold tracking-[-0.01em] text-fg " +
	// `transform`, not Tailwind's `translate` property: that is what the
	// transition beside it names.
	"[transition:opacity_var(--dur)_var(--ease),transform_var(--dur)_var(--ease)]";

/** The bar's own title fades up as the hero scrolls away. 15px in the old
 *  sheet, which is not a step on the type scale; it is an item title, so it
 *  snaps to `text-item-title` (14px). */
export const infoTopbarTitleClass = (scrolled: boolean) =>
	`${INFO_TOPBAR_TITLE} ` +
	(scrolled ? "opacity-100 [transform:translateY(0)]" : "opacity-0 [transform:translateY(5px)]");

/** Identity block: repo tile, name, and the repo · model line. The tile gets a
 *  soft key shadow here that it doesn't carry elsewhere. */
export const INFO_HERO =
	"flex flex-col items-center gap-[9px] px-5 pt-0.5 pb-5 text-center " +
	"[&_.repo-tile]:smooth-shadow-ring-sm";

/** 20px in the old sheet — the page's one heading, so it snaps to
 *  `text-page-title` (19px). */
export const INFO_NAME =
	"max-w-full text-page-title font-semibold leading-[1.2] tracking-[-0.02em] break-words text-fg";
export const INFO_SUB = "text-label font-medium text-dim";

/** Phone PR strip frame: spacing + clipping only. The status tone itself
 * reaches the outer radius, so the row does not become a card inside a card. */
export const INFO_STATUS =
	"session-info-status mx-3 mb-3 overflow-hidden rounded-xl";

export const INFO_CONTENT = "min-h-[320px]";
export const INFO_SECTION = "mt-2 border-t border-line p-3";

/**
 * A static, full-width settings list. Its rows come from RepoBar and
 * ModelMenuRow, so their shape is a child variant here rather than a prop two
 * components away — the same relationship the old `> button` rule expressed.
 */
export const INFO_LIST =
	"session-info-list mx-3 flex flex-col items-stretch gap-1 rounded-xl border border-line bg-panel p-1.5 " +
	"[&>button]:w-full [&>button]:justify-start [&>button]:gap-2 [&>button]:text-left " +
	"[&>button]:rounded-[calc(6px*var(--rf))] [&>button]:border [&>button]:border-transparent " +
	"[&>button]:bg-transparent [&>button]:px-2.5 [&>button]:py-2 [&>button]:text-label [&>button]:text-fg " +
	"[&>button:hover]:bg-hover";

/** The whole-workspace view embedded below the actions. Its own title repeats
 *  the page hero, so it goes; the meta line and PR chips still add detail. */
export const INFO_OVERVIEW =
	"pt-2 [&_.workspace-info-title]:hidden [&_.workspace-info-panel]:pt-0";
