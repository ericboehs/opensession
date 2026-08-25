
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
	relative: {
		"position": "relative"
	},
	border: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "1px"
	},
	bgVarComposerSurface: {
		"backgroundColor": "var(--composer-surface)"
	},
	shadowVarComposerShadow: {
		"--tw-shadow": "var(--composer-shadow)",
		"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
	},
	desktopBorderTransparent: {
		"@media (min-width: 721px)": {
			"borderColor": "transparent"
		}
	},
	desktopSmoothRingColorVarComposerBorder: {
		"@media (min-width: 721px)": {
			"--smooth-ring-color": "var(--composer-border)"
		}
	},
	desktopSmoothShadowRingSoft: {
		"@media (min-width: 721px)": {
			"--smooth-shadow-color": "var(--tw-shadow-color,black)",
			"boxShadow": "0 3px 10px -3px var(--smooth-shadow-color), 0 20px 56px -16px var(--smooth-shadow-color), 0 0 0 var(--smooth-ring-width,1px) var(--smooth-ring-color)",
			"@supports (color: color-mix(in lab, red, red))": {
				"boxShadow": "0 3px 10px -3px color-mix(in srgb, var(--smooth-shadow-color) 4%, transparent), 0 20px 56px -16px color-mix(in srgb, var(--smooth-shadow-color) 12%, transparent), 0 0 0 var(--smooth-ring-width,1px) color-mix(in srgb, var(--smooth-ring-color) 35%, transparent)"
			}
		}
	},
	roundedVarComposerRadius: {
		"borderRadius": "var(--composer-radius)"
	},
	px35: {
		"paddingInline": "14px"
	},
	pt35: {
		"paddingTop": "14px"
	},
	pb25: {
		"paddingBottom": "10px"
	},
	ComposerInsetLeft15px: {
		"--composer-inset-left": "15px"
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phonePt25: {
		"@media (max-width: 720px)": {
			"paddingTop": "10px"
		}
	},
	phonePb9px: {
		"@media (max-width: 720px)": {
			"paddingBottom": "9px"
		}
	},
	phoneComposerInsetLeft13px: {
		"@media (max-width: 720px)": {
			"--composer-inset-left": "13px"
		}
	},
	mx35: {
		"marginInline": "14px"
	},
	flex: {
		"display": "flex"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	gap1: {
		"gap": "4px"
	},
	rounded999px: {
		"borderRadius": "999px"
	},
	p1: {
		"padding": "4px"
	},
	ComposerInsetLeft5px: {
		"--composer-inset-left": "5px"
	},
	block: {
		"display": "block"
	},
	maxH320px: {
		"maxHeight": "320px"
	},
	minH0: {
		"minHeight": "0"
	},
	wFull: {
		"width": "100%"
	},
	resizeNone: {
		"resize": "none"
	},
	borderNone: {
		"--tw-border-style": "none",
		"borderStyle": "none"
	},
	bgTransparent: {
		"backgroundColor": "transparent"
	},
	leading155: {
		"--tw-leading": "1.55",
		"lineHeight": "1.55"
	},
	outlineNone: {
		"--tw-outline-style": "none",
		"outlineStyle": "none"
	},
	phoneMaxH240px: {
		"@media (max-width: 720px)": {
			"maxHeight": "240px"
		}
	},
	phoneTextInputPhone: {
		"@media (max-width: 720px)": {
			"fontSize": "var(--type-input-phone)"
		}
	},
	WordSpacing35px: {
		"wordSpacing": "3.5px"
	},
	px0: {
		"paddingInline": "0"
	},
	pt05: {
		"paddingTop": "2px"
	},
	pb1: {
		"paddingBottom": "4px"
	},
	px1: {
		"paddingInline": "4px"
	},
	py0: {
		"paddingBlock": "0"
	},
	mt25: {
		"marginTop": "10px"
	},
	gap2: {
		"gap": "8px"
	},
	phoneMt15: {
		"@media (max-width: 720px)": {
			"marginTop": "6px"
		}
	},
	phoneGap15: {
		"@media (max-width: 720px)": {
			"gap": "6px"
		}
	},
	beforePointerEventsNone: {
		"::before": {
			"content": "var(--tw-content)",
			"pointerEvents": "none"
		}
	},
	beforeAbsolute: {
		"::before": {
			"content": "var(--tw-content)",
			"position": "absolute"
		}
	},
	beforeInsetX35: {
		"::before": {
			"content": "var(--tw-content)",
			"insetInline": "-14px"
		}
	},
	beforeTop25: {
		"::before": {
			"content": "var(--tw-content)",
			"top": "-10px"
		}
	},
	beforeHPx: {
		"::before": {
			"content": "var(--tw-content)",
			"height": "1px"
		}
	},
	beforeBgDivider: {
		"::before": {
			"content": "var(--tw-content)",
			"backgroundColor": "var(--divider)"
		}
	},
	beforeOpacity0: {
		"::before": {
			"content": "var(--tw-content)",
			"opacity": "0"
		}
	},
	beforeTransitionOpacity: {
		"::before": {
			"content": "var(--tw-content)",
			"transitionProperty": "opacity",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
	beforeContent: {
		"::before": {
			"--tw-content": "\"\"",
			"content": "var(--tw-content)"
		}
	},
	phoneBeforeInsetX3: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"insetInline": "-12px"
			}
		}
	},
	phoneBeforeTop15: {
		"@media (max-width: 720px)": {
			"::before": {
				"content": "var(--tw-content)",
				"top": "-6px"
			}
		}
	},
	contents: {
		"display": "contents"
	},
	inlineFlex: {
		"display": "inline-flex"
	},
	minW0: {
		"minWidth": "0"
	},
	shrink: {
		"flexShrink": "1"
	},
	phoneOrder1: {
		"@media (max-width: 720px)": {
			"order": "-1"
		}
	},
	minW34px: {
		"minWidth": "34px"
	},
	phoneMaxW136px: {
		"@media (max-width: 720px)": {
			"maxWidth": "136px"
		}
	},
	phonePx9px: {
		"@media (max-width: 720px)": {
			"paddingInline": "9px"
		}
	},
	gap9px: {
		"gap": "9px"
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	},
	px9px: {
		"paddingInline": "9px"
	},
	py7px: {
		"paddingBlock": "7px"
	},
	textLeft: {
		"textAlign": "left"
	},
	textFg: {
		"color": "var(--text)"
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	w5: {
		"width": "20px"
	},
	justifyCenter: {
		"justifyContent": "center"
	},
	textDim: {
		"color": "var(--text-dim)"
	},
	absolute: {
		"position": "absolute"
	},
	bottomCalc1006px: {
		"bottom": "calc(100% + 6px)"
	},
	z40: {
		"zIndex": "40"
	},
	roundedLg: {
		"borderRadius": "calc(14px * var(--rf))"
	},
	bgPopupGlass: {
		"backgroundColor": "var(--popup-glass)"
	},
	BackdropFilterVarPopupBlur: {
		"WebkitBackdropFilter": "var(--popup-blur)",
		"backdropFilter": "var(--popup-blur)"
	},
	SmoothRingColorVarPopupRing: {
		"--smooth-ring-color": "var(--popup-ring)"
	},
	minW172px: {
		"minWidth": "172px"
	},
	right0: {
		"right": "0"
	},
	size8: {
		"width": "32px",
		"height": "32px"
	},
	shrink0: {
		"flexShrink": "0"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	},
	leadingNone: {
		"--tw-leading": "1",
		"lineHeight": "1"
	},
	disabledCursorDefault: {
		":disabled": {
			"cursor": "default"
		}
	},
	disabledOpacity35: {
		":disabled": {
			"opacity": ".35"
		}
	},
	phoneSize10: {
		"@media (max-width: 720px)": {
			"width": "40px",
			"height": "40px"
		}
	},
	bgAccent: {
		"backgroundColor": "var(--accent)"
	},
	textOnAccent: {
		"color": "var(--on-accent)"
	},
	bgRed: {
		"backgroundColor": "var(--red)"
	},
	textWhite: {
		"color": "var(--color-white)"
	},
	phoneBgClipContent: {
		"@media (max-width: 720px)": {
			"backgroundClip": "content-box"
		}
	},
	phoneP1: {
		"@media (max-width: 720px)": {
			"padding": "4px"
		}
	},
	mb2: {
		"marginBottom": "8px"
	},
	flexWrap: {
		"flexWrap": "wrap"
	},
	maxW240px: {
		"maxWidth": "240px"
	},
	borderLineStrong: {
		"borderColor": "var(--border-strong)"
	},
	bgVarBgHover: {
		"backgroundColor": "var(--bg-hover)"
	},
	py15: {
		"paddingBlock": "6px"
	},
	pl15: {
		"paddingLeft": "6px"
	},
	pr26px: {
		"paddingRight": "26px"
	},
	size34px: {
		"width": "34px",
		"height": "34px"
	},
	text10px: {
		"fontSize": "10px"
	},
	fontBold: {
		"--tw-font-weight": "var(--font-weight-bold)",
		"fontWeight": "var(--font-weight-bold)"
	},
	tracking002em: {
		"--tw-tracking": ".02em",
		"letterSpacing": ".02em"
	},
	textAccent: {
		"color": "var(--accent-ink)"
	},
	flexCol: {
		"flexDirection": "column"
	},
	gapPx: {
		"gap": "1px"
	},
	truncate: {
		"textOverflow": "ellipsis",
		"whiteSpace": "nowrap",
		"overflow": "hidden"
	},
	textFaint: {
		"color": "var(--text-faint)"
	},
	Mb35: {
		"marginBottom": "-14px"
	},
	roundedTVarComposerRadius: {
		"borderTopLeftRadius": "var(--composer-radius)",
		"borderTopRightRadius": "var(--composer-radius)"
	},
	borderX: {
		"borderInlineStyle": "var(--tw-border-style)",
		"borderInlineWidth": "1px"
	},
	borderT: {
		"borderTopStyle": "var(--tw-border-style)",
		"borderTopWidth": "1px"
	},
	pt25: {
		"paddingTop": "10px"
	},
	pb26px: {
		"paddingBottom": "26px"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	minHCalc13px145: {
		"minHeight": "18.85px"
	},
	borderLine: {
		"borderColor": "var(--border)"
	},
	pt2: {
		"paddingTop": "8px"
	},
	cursorGrab: {
		"cursor": "grab"
	},
	touchNone: {
		"touchAction": "none"
	},
	activeCursorGrabbing: {
		":active": {
			"cursor": "grabbing"
		}
	},
	order1: {
		"order": "1"
	},
	z1: {
		"zIndex": "1"
	},
	Mt11px: {
		"marginTop": "-11px"
	},
	Mb25: {
		"marginBottom": "-10px"
	},
	gap05: {
		"gap": "2px"
	},
	size9: {
		"width": "36px",
		"height": "36px"
	},
	beforeInset3px: {
		"::before": {
			"content": "var(--tw-content)",
			"inset": "3px"
		}
	},
	beforeZ0: {
		"::before": {
			"content": "var(--tw-content)",
			"zIndex": "0"
		}
	},
	beforeRoundedCalc9pxVarRf: {
		"::before": {
			"content": "var(--tw-content)",
			"borderRadius": "calc(9px * var(--rf))"
		}
	},
	beforeCornerShapeVarCs: {
		"::before": {
			"content": "var(--tw-content)",
			"cornerShape": "var(--cs)"
		}
	},
	beforeTransitionBackground: {
		"::before": {
			"content": "var(--tw-content)",
			"transitionProperty": "background",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
	h8: {
		"height": "32px"
	},
	gap15: {
		"gap": "6px"
	},
	borderTransparent: {
		"borderColor": "transparent"
	},
	bgAccentSoft: {
		"backgroundColor": "var(--accent-soft)"
	},
	px13px: {
		"paddingInline": "13px"
	},
	px2: {
		"paddingInline": "8px"
	},
	fontMedium: {
		"--tw-font-weight": "var(--font-weight-medium)",
		"fontWeight": "var(--font-weight-medium)"
	},
	bgClipText: {
		"WebkitbackgroundClip": "text",
		"backgroundClip": "text"
	},
	textTransparent: {
		"color": "transparent"
	},
	WebkitBackgroundClipText: {
		"WebkitbackgroundClip": "text"
	},
	BackgroundSize200100: {
		"backgroundSize": "200% 100%"
	},
	BackgroundRepeatNoRepeat: {
		"backgroundRepeat": "no-repeat"
	},
	animateTextShimmer18sLinearInfinite: {
		"animation": "1.8s linear infinite text-shimmer"
	},
	flex1: {
		"flex": "1"
	},
	h34px: {
		"height": "34px"
	},
	w46px: {
		"width": "46px"
	},
	flexNone: {
		"flex": "none"
	},
	sizeFull: {
		"width": "100%",
		"height": "100%"
	},
	roundedCalc8pxVarRf: {
		"borderRadius": "calc(8px * var(--rf))"
	},
	objectCover: {
		"objectFit": "cover"
	},
	Right1: {
		"right": "-4px"
	},
	Bottom1: {
		"bottom": "-4px"
	},
	h18px: {
		"height": "18px"
	},
	minW18px: {
		"minWidth": "18px"
	},
	bgRaised: {
		"backgroundColor": "var(--bg-raised)"
	},
	textCenter: {
		"textAlign": "center"
	},
	leading4: {
		"--tw-leading": "calc(4px * 4)",
		"lineHeight": "16px"
	},
	leading145: {
		"--tw-leading": "1.45",
		"lineHeight": "1.45"
	},
	mr15: {
		"marginRight": "6px"
	},

	borderColorColorMixInSrgbVarComposerBorder35Transparent: {
		"borderColor": "var(--composer-border)",
		"@supports (color: color-mix(in lab, red, red))": {
			"borderColor": "color-mix(in srgb,var(--composer-border) 35%,transparent)"
		}
	},
	transitionBorderColorBoxShadow: {
		"transitionProperty": "border-color,box-shadow",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	transitionBackgroundColorBorderColorColorFilterScale: {
		"transitionProperty": "background-color,border-color,color,filter,scale",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	enabledActiveScale096: {
		":enabled": {
			":active": {
				"scale": ".96"
			}
		}
	},
	enabledHoverBgAccentHover: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"backgroundColor": "var(--accent-hover)"
				}
			}
		}
	},
	enabledHoverBrightness112: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"--tw-brightness": "brightness(1.12)",
					"filter": "var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,)"
				}
			}
		}
	},
	bgColorMixInSrgbVarAccent16Transparent: {
		"backgroundColor": "var(--accent)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--accent) 16%,transparent)"
		}
	},
	bgColorMixInSrgbVarBgPanel80VarComposerSurface: {
		"backgroundColor": "var(--bg-panel)",
		"@supports (color: color-mix(in lab, red, red))": {
			"backgroundColor": "color-mix(in srgb,var(--bg-panel) 80%,var(--composer-surface))"
		}
	},
	enabledHoverTextFg: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"color": "var(--text)"
				}
			}
		}
	},
	enabledHoverBeforeBgHover: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"::before": {
						"content": "var(--tw-content)",
						"backgroundColor": "var(--hover)"
					}
				}
			}
		}
	},

	enabledHoverTextAccent: {
		"@media (hover: hover)": {
			":enabled": {
				":hover": {
					"color": "var(--accent-ink)"
				}
			}
		}
	},
});

/**
 * Shared Tailwind class maps for the composer family (the `composer-*` block
 * that used to live in styles/legacy.css).
 *
 * Two rules shaped how these are written, and breaking either one fails
 * silently — no build error, just the wrong pixels:
 *
 * 1. **Every class is spelled out in full, literal text.** Tailwind scans
 *    source as text, so an interpolated class (`` `text-${tone}` ``) or one
 *    assembled from a constant is never generated. Add a variant by adding a
 *    literal entry here, never by building the string.
 * 2. **A base string carries geometry only; colour lives in the variant.** Two
 *    competing colour utilities on one element do not compose — the browser
 *    takes whichever Tailwind happened to emit last, not the one written last.
 *    Same for any pair that sets the same property (which is why the card's
 *    right padding is separate from the card itself: the composer needs room
 *    for a remove button, a transcript chip does not).
 */

/* ── The composer box ──────────────────────────────────────────────
   `.composer` stays on the markup as a hook: legacy.css still reaches through
   it into controls this family does not own (`.composer.composer-min
   .palette-icon-btn`, whose ::before wash is styled from the stylesheet). The
   declarations below are what that rule used to paint. */
export const composerBox =
	mergeStylexClassName("", sx.borderColorColorMixInSrgbVarComposerBorder35Transparent, sx.transitionBorderColorBoxShadow, sx.relative, sx.border, sx.bgVarComposerSurface, sx.shadowVarComposerShadow) + " " +
	mergeStylexClassName("", sx.desktopBorderTransparent, sx.desktopSmoothRingColorVarComposerBorder, sx.desktopSmoothShadowRingSoft);

/** Resting/expanded box. `--composer-inset-left` is read by the "+" menu to
 *  line its left edge up with the composer's outer edge rather than the
 *  button's, so it travels with the padding it describes. */
export const composerBoxExpanded =
	mergeStylexClassName("", sx.roundedVarComposerRadius, sx.px35, sx.pt35, sx.pb25, sx.ComposerInsetLeft15px, sx.phonePx3, sx.phonePt25, sx.phonePb9px, sx.phoneComposerInsetLeft13px);

/** Phone resting pill: one row, even 4px inset, held well clear of the screen
 *  edges. The inset is wider than the expanded box's on purpose: at rest the
 *  composer is a short capsule floating over the transcript, and running it
 *  edge to edge made it read as a bar rather than a pill. The internal padding
 *  stays at 4px, so the pill gets smaller through width, not tighter spacing.
 *  Matches the native iOS composer, which steps its resting pill in by the
 *  same 8pt on each side.
 *
 *  Motion animates the radius between this and the expanded box; the class is
 *  here so a first paint (and any non-animated host) lands on the same shape.
 *
 *  `rounded-[999px]` rather than `rounded-full`, and the difference is not
 *  cosmetic: base.css grants `corner-shape: squircle` to
 *  `[class*="rounded-"]:not([class*="rounded-full"])`, so `rounded-full` is
 *  precisely the one spelling that opts OUT of the squircle. The pill is a
 *  squircle — `.composer` used to say so with `corner-shape: var(--cs)` — and
 *  `rounded-full` silently flattened it to a plain capsule. Same radius either
 *  way; only the corner curve differs. Installed phone PWAs override that
 *  curve to `round` in base.css, while keeping this same capsule geometry. */
export const composerBoxMinimized =
	mergeStylexClassName("", sx.mx35, sx.flex, sx.itemsCenter, sx.gap1, sx.rounded999px, sx.p1, sx.ComposerInsetLeft5px);

/* ── The draft field ──────────────────────────────────────────────
   `.composer-textarea` stays on the markup as a hook too: it is read as a
   class NAME by the sidebar swipe guard (lib/sidebar-swipe.ts) and by
   SessionViewer's keyboard handlers, which skip global shortcuts while the
   caret is in the composer.

   The mirror div that paints code tints behind the field (`.composer-hl`)
   shares these metrics exactly — any difference in font, padding or wrap
   desyncs the caret from the painted glyphs — so both read the same strings. */
/** The draft field and the code/mention mirror behind it both take this, which
 *  is what keeps them glyph-identical. */
export const composerTextarea =
	mergeStylexClassName("", sx.block, sx.maxH320px, sx.minH0, sx.wFull, sx.resizeNone, sx.borderNone, sx.bgTransparent, typography.body, sx.leading155, sx.outlineNone, sx.phoneMaxH240px, sx.phoneTextInputPhone);
/** The only room a mention pill can take is the space character beside it: its
 *  wash is painted rather than laid out, and 3.7px of natural space has to
 *  cover both the pill's own padding and the gap to the next word. Widening
 *  the space is the only way to give that chip a margin, and it goes on the
 *  field as well as the mirror, so the painted text stays under the caret it
 *  belongs to.
 *
 *  It is worn only while the draft actually holds a mention (Composer.tsx),
 *  because every space pays it, not just the two beside the pill. A sentence
 *  set this way on its own reads as broken word spacing, which is what a
 *  permanent 3.5px did. Scoped, the cost lands on the draft that wanted the
 *  chip and ordinary prose keeps the type's own spacing.
 *
 *  Session pills deliberately do not wear it. A pasted link often sits inside
 *  a full sentence, where widening every space is more distracting than the
 *  extra pixel of air buys the pill. */
export const composerMentionSpacing = mergeStylexClassName("", sx.WordSpacing35px);
export const composerTextareaPadding = mergeStylexClassName("", sx.px0, sx.pt05, sx.pb1);
/** In the resting pill the field is one row inside a 4px-inset box, so it
 *  carries the horizontal breathing room and no vertical padding at all. */
export const composerTextareaPaddingMinimized = mergeStylexClassName("", sx.px1, sx.py0);

/* ── The toolbar row ──────────────────────────────────────────────
   The row under the draft: "+", the mode marker, a spacer, the model pill,
   the mic and the send disc.

   The stylesheet pinned every DIRECT child at `flex-shrink: 0` from here, so
   that when the row ran out of room the model/effort pill gave way (its label
   ellipsizes) and never the icon buttons or the send button, which would
   otherwise be pushed past the composer's edge on phones. That is now written
   on the children themselves rather than as `[&>*]:shrink-0`: a descendant
   utility and a child's own `shrink` are the same specificity, so the pill's
   opt-back-in would have depended on the compiled sheet's order. */
export const composerToolbar =
	mergeStylexClassName("", sx.relative, sx.mt25, sx.flex, sx.itemsCenter, sx.gap2, sx.phoneMt15, sx.phoneGap15);
/** The seam a scrolling draft earns.
 *
 *  Past the field's cap the draft scrolls inside the composer, and the last
 *  visible line is cut mid-glyph a few pixels above the toolbar — text and
 *  controls read as one run, with the cut looking like a rendering fault. The
 *  hairline says the two are different regions and that the text continues
 *  under it. It is the same rule the palette draws over its footer
 *  (NewSession) and the app draws under its top bars (SCROLL_EDGE_DIVIDER),
 *  earned on the same terms: only while content actually sits beyond the edge,
 *  so a draft that fits keeps an undivided box.
 *
 *  A pseudo-element rather than a `border-t`, because a border that appears
 *  would push the toolbar down a pixel each time you scrolled past the fold.
 *  It bleeds past the composer's own padding to the box's inner edges — inset
 *  to the text column it reads as a rule under a paragraph rather than as the
 *  floor of the scrolling region.
 *
 *  It is hung at the FIELD's bottom edge (the toolbar's whole top margin,
 *  negated) rather than at the toolbar's own top, so it lands on the floor of
 *  the scrolling text and hands the entire gap to the controls below it. Sat
 *  at the toolbar's edge instead, the gap was split: the line stood off the
 *  text it belongs to and pressed against the send disc, whose fill reaches
 *  much closer than the hairline glyphs beside it do. Where it is now the
 *  toolbar keeps equal air above and below — the composer's own bottom padding
 *  is the same 10px (9px on phones) — so the row reads as its own strip.
 *
 *  `data-scroll-under` is written imperatively by the composer's scroll
 *  handler, for the reason the fade at the other edge is: a state round-trip
 *  lands the line a frame late, which during momentum scroll reads as a
 *  flicker. */
export const composerToolbarScrollDivider =
	mergeStylexClassName("", sx.beforePointerEventsNone, sx.beforeAbsolute, sx.beforeInsetX35, sx.beforeTop25) + " " +
	mergeStylexClassName("", sx.beforeHPx, sx.beforeBgDivider, sx.beforeOpacity0, sx.beforeTransitionOpacity) + " " +
	mergeStylexClassName("data-[scroll-under]:before:opacity-100", sx.beforeContent) + " " +
	mergeStylexClassName("", sx.phoneBeforeInsetX3, sx.phoneBeforeTop15);
/** Resting phone pill: `display: contents` lifts the toolbar's buttons into
 *  the composer's own flex row, so the textarea can sit between the "+" and
 *  the mic/send and `order` can sequence them. Combine through `cn()` —
 *  tailwind-merge is what drops the `flex` above. */
export const composerToolbarMinimized = mergeStylexClassName("", sx.contents);
/** The one flexible item in the row, and the wrapper it has to be granted to:
 *  the model pill sits inside a Motion layout box, and pinning the shrink on
 *  the pill itself left the WRAPPER rigid — the row stayed wider than the
 *  composer and pushed the send button off its right edge on phones. Phones
 *  also pull it to the front of the row, next to the "+". */
export const composerToolbarSelect =
	mergeStylexClassName("", sx.inlineFlex, sx.minW0, sx.shrink, sx.phoneOrder1);
/** The pill's toolbar-only metrics: it may shrink to a 34px stub here (the
 *  new-session footer lets it go to 0 instead), and phones tighten its
 *  padding and cap it so the whole row fits without clipping the send. */
export const composerToolbarPill =
	mergeStylexClassName("", sx.shrink, sx.minW34px, sx.phoneMaxW136px, sx.phonePx9px);

/* ── Toolbar popover menus ─────────────────────────────────────────
   The popup surface for the "+" add menu and the send-later menu, and the
   rows that go in them. */
/** One row in those menus. The row used to stay in the stylesheet because
 *  SessionViewer contributes one through the composer's `menuExtra` and
 *  SchedulePrompt contributes two more — but all three hosts are components,
 *  so the row lives here and they import it.
 *
 *  Only the deviations from the base button reset in styles/base.css are
 *  written: that already supplies `cursor: pointer`, `background: none`,
 *  `border: none` and zero padding. */
export const composerMenuItem =
	mergeStylexClassName("", sx.flex, sx.wFull, sx.itemsCenter, sx.gap9px, sx.roundedControl, sx.px9px, sx.py7px, sx.textLeft, typography.controlLabel, sx.textFg, sx.hoverBgHover);
/** The row's leading glyph. A fixed 20px column so the labels line up however
 *  wide the icons draw. */
export const composerMenuIcon =
	mergeStylexClassName("", sx.inlineFlex, sx.w5, sx.itemsCenter, sx.justifyCenter, typography.label, sx.textDim);
/** The surface those rows sit on. Edge and cast come from the same ring the
 *  Base UI menus use (ui/menu.tsx) rather than a `border-line-strong` hairline:
 *  that line is drawn for a control resting IN the page, and on a floating
 *  popup it read a step darker than every other menu on screen. */
export const composerMenuPopup =
	mergeStylexClassName("smooth-shadow-ring-md", sx.absolute, sx.bottomCalc1006px, sx.z40, sx.roundedLg, sx.bgPopupGlass, sx.BackdropFilterVarPopupBlur, sx.SmoothRingColorVarPopupRing, sx.p1);
/** The menu's own floor width. Kept out of the surface above because a second
 *  `min-w-*` on the same element would not compose — the send-later menu is
 *  wider (it lists pending messages), and whichever Tailwind emitted last would
 *  win rather than the one written last. */
export const composerMenuWidth = mergeStylexClassName("", sx.minW172px);
/** Default anchoring: the menu hangs off the right edge of its trigger. */
export const composerMenuAnchorRight = mergeStylexClassName("", sx.right0);
/** The "+" sits at the LEFT of the toolbar, so its menu grows rightward from
 *  the composer's outer left edge (not the button's — the toolbar lives inside
 *  the composer's padding, which left the menu inset and off-axis). */
export const composerMenuAnchorLeft =
	"left-[calc(-1*var(--composer-inset-left,17px))]";

/* ── The send disc ────────────────────────────────────────────────
   The one filled control in the toolbar and the one place a circle is right:
   it is the only control whose whole job is "commit this", and roundness is
   what keeps a full-strength fill from feeling heavy.

   Geometry only — each state below brings its own fill, ink and edge. The
   40px phone size is what the last of the three (!) competing phone blocks in
   legacy.css resolved to. */
export const composerSend =
	mergeStylexClassName("", sx.transitionBackgroundColorBorderColorColorFilterScale, sx.enabledActiveScale096, sx.inlineFlex, sx.size8, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.leadingNone, sx.disabledCursorDefault, sx.disabledOpacity35, sx.phoneSize10);
/** Ordinary send: the accent plate. Hover takes `--accent-hover` rather than
 *  brightening — brightening a wash read as a disabled state. */
export const composerSendDefault =
	mergeStylexClassName("", sx.enabledHoverBgAccentHover, sx.bgAccent, sx.textOnAccent);
/** Busy + queue keeps the send plate and changes the glyph. The old 2px ring
 *  read like a selected toggle, then hovered to dark-on-dark because its ink
 *  did not invert with the fill. */
export const composerSendQueue = composerSendDefault;
/** Busy + steer keeps the full accent plate too; its up-arrow glyph separates
 *  it from queue's return arrow without making the action look secondary. */
export const composerSendSteer = composerSendDefault;
/** Stop: the only full-strength red plate. */
export const composerSendStop =
	mergeStylexClassName("", sx.enabledHoverBrightness112, sx.bgRed, sx.textWhite);
/** Inside the 50px resting pill a 40px disc is a blob against the hairline
 *  glyphs beside it. Keep the target, shrink the fill: padding plus
 *  background-clip paints a 32px disc without moving the hit area. */
export const composerSendMinimizedFill = mergeStylexClassName("", sx.phoneBgClipContent, sx.phoneP1);

/* ── File attachment chips ────────────────────────────────────────
   Shared by the composer's staged attachments (removable) and a user turn's
   download chips in the transcript (a link). The right padding is deliberately
   not part of the card: the composer needs room for its × button. */
export const fileChipRow = mergeStylexClassName("", sx.mb2, sx.flex, sx.flexWrap, sx.gap2);
export const fileChipCard =
	mergeStylexClassName("", sx.relative, sx.inlineFlex, sx.maxW240px, sx.itemsCenter, sx.gap9px, sx.roundedLg, sx.border, sx.borderLineStrong, sx.bgVarBgHover, sx.py15, sx.pl15);
/** Composer: leaves room for the absolutely-placed remove button. */
export const fileChipCardPaddingRemovable = mergeStylexClassName("", sx.pr26px);
/** Transcript: nothing to remove there, and `.msg-file-card` asked for 10px —
 *  but that rule sat ABOVE `.composer-file-card`'s padding shorthand in the
 *  stylesheet at equal specificity, so it never applied. This keeps what the
 *  chip has always rendered; closing it up is a design change, not a migration. */
export const fileChipCardPadding = mergeStylexClassName("", sx.pr26px);
export const fileChipThumb =
	mergeStylexClassName("", sx.bgColorMixInSrgbVarAccent16Transparent, sx.inlineFlex, sx.size34px, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.text10px, sx.fontBold, sx.tracking002em, sx.textAccent);
export const fileChipMeta = mergeStylexClassName("", sx.flex, sx.minW0, sx.flexCol, sx.gapPx);
/** The chip's title. 13px (text-label) rather than the stylesheet's off-scale
 *  12px — it is interface copy, and the card's height comes from the 34px
 *  badge, so nothing reflows. */
export const fileChipName = mergeStylexClassName("", sx.truncate, typography.label, sx.textFg);
export const fileChipSub = mergeStylexClassName("", typography.meta, sx.textFaint);

/* ── Flap edges ───────────────────────────────────────────────────
   Shared by both flaps that tuck under the composer (the queue flap below and
   the run-status flap in components/ComposerAgents.tsx). */
/** The hairline a flap draws, matched to the edge the composer actually paints.
 *
 *  The composer carries the border token at 35% strength: through a smooth
 *  ring on desktop and a solid hairline on phone. Drawing the flap at full
 *  strength made the panel behind it about three times darker than the input
 *  in front. Use the same mix everywhere so the two layers keep one edge. */
export const composerFlapBorder = mergeStylexClassName(
	"pwa-composer-edge",
	sx.borderColorColorMixInSrgbVarComposerBorder35Transparent,
);

/* ── The queue flap ───────────────────────────────────────────────
   The flap that folds out from behind the composer: a dimmer panel flush with
   the composer's edges, rounded only on top, its bottom tucked under the
   composer box. The negative bottom margin is what does the tucking — the
   composer is a later positioned sibling, so it paints over the seam.

   Its top corner reads `--composer-radius` rather than a `rounded-*` step,
   so the flap keeps matching the box it is flush with when that token moves.

   `border-x border-t` rather than `border` + `border-b-0`: the bottom edge has
   to be `border-bottom-style: none`, not a zero-width solid, because the
   composer's own hairline continues it. `border-b-0` leaves the style behind. */
export const composerQueue =
	mergeStylexClassName("", sx.relative, sx.Mb35, sx.flex, sx.flexCol, sx.gap2, sx.roundedTVarComposerRadius, sx.borderX, sx.borderT) +
	composerFlapBorder +
	mergeStylexClassName("", sx.bgColorMixInSrgbVarBgPanel80VarComposerSurface, sx.px35, sx.pt25, sx.pb26px);
export const composerQueueTitle = mergeStylexClassName("", typography.meta, sx.fontSemibold, sx.textFaint);
export const composerQueueList = mergeStylexClassName("", sx.flex, sx.flexCol, sx.gap2);
/** One queued/steered row. The floor is one line of body text, so a row whose
 *  point is a single message does not inherit the 40px action cluster's
 *  height. Centered rather than top-aligned: the body is a single truncated
 *  line, so the tallest thing in the row is whatever attachment preview it
 *  carries — top alignment left a 34px thumbnail hanging 9px below the text
 *  and the actions. Nothing here ever wraps, so there is no first-line to
 *  align to. */
export const composerQueueItem =
	mergeStylexClassName("", sx.relative, sx.flex, sx.minHCalc13px145, sx.itemsCenter, sx.gap2);
/** The hairline between rows. The stylesheet drew it with
 *  `.composer-queue-item + .composer-queue-item`, which a utility cannot
 *  spell against itself — so each list applies it from its own index. The
 *  three groups (steered, queued, sending) are separated by non-row elements,
 *  so "not first in ITS group" is exactly what the sibling selector matched. */
export const composerQueueItemSeparated = mergeStylexClassName("", sx.borderT, sx.borderLine, sx.pt2);
/** Drag-to-reorder: the whole row is the grab surface. The action buttons
 *  still take clicks — a drag only starts once the pointer actually moves. */
export const composerQueueItemDraggable =
	mergeStylexClassName("", sx.cursorGrab, sx.touchNone, sx.activeCursorGrabbing);
/** In flow at the row's trailing edge, so each row reserves exactly the width
 *  its own actions need — it used to be absolutely positioned over a fixed
 *  128px of padding, which clipped the rows carrying a pill into the text.
 *  Written before the message in the markup (it owns the row's controls) and
 *  painted after it, hence `order-1`. The negative block margins keep the 36px
 *  cluster from setting the height of a one-line row. */
export const composerQueueActions =
	mergeStylexClassName("", sx.order1, sx.z1, sx.Mt11px, sx.Mb25, sx.inlineFlex, sx.shrink0, sx.itemsCenter, sx.gap05);
/** A compact 36px action with the same `rounded-control` corner and inset
 *  hover wash as the composer's toolbar buttons. It remains a separate
 *  constant because the wash sits 3px in rather than 4px, there is no
 *  transparent border holding layout, and disabled actions fade further. */
export const composerQueueAction =
	mergeStylexClassName("", sx.enabledHoverTextFg, sx.relative, sx.inlineFlex, sx.size9, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.textDim, sx.disabledCursorDefault, sx.disabledOpacity35) + " " +
	mergeStylexClassName("", sx.enabledHoverBeforeBgHover, sx.beforeAbsolute, sx.beforeInset3px, sx.beforeZ0, sx.beforeRoundedCalc9pxVarRf, sx.beforeCornerShapeVarCs, sx.beforeTransitionBackground, sx.beforeContent) + " " +
	"[&>*]:relative [&>*]:z-[1]";
/** Destructive action: the wash goes red rather than neutral. */
export const composerQueueActionDanger =
	"enabled:hover:text-red enabled:hover:before:bg-red-soft";
/** Steer stays accent at rest AND under the cursor — it is the one action on
 *  the row that is not a correction, and the shared hover would have dropped
 *  it back to plain ink. */
export const composerQueueActionSteer = mergeStylexClassName("", sx.enabledHoverTextAccent, sx.textAccent);
/** A status readout, not a control: "Steered". Genuinely
 *  round (the stylesheet spelled a bare 999px with no `corner-shape`), so
 *  `rounded-full` rather than `rounded-[999px]`. */
export const composerQueuePill =
	mergeStylexClassName("", sx.inlineFlex, sx.h8, sx.shrink0, sx.itemsCenter, sx.gap15, sx.roundedFull, sx.border, sx.borderTransparent, sx.bgAccentSoft, sx.px13px, typography.label, sx.fontSemibold, sx.textAccent);
/** Optimistic busy send: a transient readout, not a badge or control. Keeping
 *  it borderless prevents the in-flight state from reading as a pill button. */
export const composerQueueSendingStatus =
	mergeStylexClassName("", sx.inlineFlex, sx.h8, sx.shrink0, sx.itemsCenter, sx.px2, typography.label, sx.fontMedium, sx.textFaint);
/** The label carries its own motion instead of standing next to a spinner: a
 *  highlight crosses the word, which reads as "not settled yet" without adding
 *  a second moving thing to a row that already sits in a list. The letters are
 *  painted with a gradient twice the box wide (`bg-clip-text` over transparent
 *  text) and the keyframe slides it; the crest is `--text-dim`, one step up
 *  from the resting `--text-faint` in both themes. Settled states ("Queued")
 *  do not take it. */
export const composerQueueSendingShimmer =
	mergeStylexClassName("", sx.bgClipText, sx.textTransparent, sx.WebkitBackgroundClipText) + " " +
	"[background-image:linear-gradient(100deg,var(--text-faint)_38%,var(--text-dim)_50%,var(--text-faint)_62%)] " +
	mergeStylexClassName("", sx.BackgroundSize200100, sx.BackgroundRepeatNoRepeat) + " " +
	mergeStylexClassName("", sx.animateTextShimmer18sLinearInfinite);
export const composerQueueContent = mergeStylexClassName("", sx.flex, sx.minW0, sx.flex1, sx.itemsCenter, sx.gap2);
/** The thumbnail keeps its size — shrunk to the 19px line box it stops being a
 *  recognizable preview, and the `+N` badge below is nearly as tall as the
 *  image it counts. The row centers on it instead. */
export const composerQueueImage = mergeStylexClassName("", sx.relative, sx.h34px, sx.w46px, sx.flexNone);
export const composerQueueImageThumb =
	mergeStylexClassName("", sx.block, sx.sizeFull, sx.roundedCalc8pxVarRf, sx.border, sx.borderLine, sx.objectCover);
export const composerQueueImageCount =
	mergeStylexClassName("", sx.absolute, sx.Right1, sx.Bottom1, sx.h18px, sx.minW18px, sx.roundedFull, sx.border, sx.borderLine, sx.bgRaised, sx.px1, sx.textCenter, sx.text10px, sx.fontBold, sx.leading4, sx.textDim);
/** The message itself, one line with an ellipsis. Size and leading stay in one
 *  string with leading last: tailwind-merge files `leading` as a conflict of
 *  `font-size`, so a later `text-*` would drop an earlier `leading-*`. */
export const composerQueueBody = mergeStylexClassName("", sx.minW0, sx.flex1, sx.truncate, typography.label, sx.leading145);
/** Whose message it is. `github` outranks `human` — both were equally specific
 *  in the stylesheet and github came last. */
export const composerQueueBodyTone = {
	default: mergeStylexClassName("", sx.textFg),
	human: "text-[color-mix(in_srgb,var(--text)_88%,#1f9e8a)]",
	github: mergeStylexClassName("", sx.textDim),
	sending: mergeStylexClassName("", sx.textDim),
} as const;
/** The "from" label ahead of the body — a teammate's name, or "GitHub". */
export const composerQueueFrom = mergeStylexClassName("", sx.mr15, sx.fontSemibold, sx.textFaint);
