
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";

const sx = stylex.create({
	pointerEventsNone: {
		"pointerEvents": "none"
	},
	fixed: {
		"position": "fixed"
	},
	right4: {
		"right": "16px"
	},
	topCalcVarDesktopHeaderH8px: {
		"top": "calc(var(--desktop-header-h) + 8px)"
	},
	z200: {
		"zIndex": "200"
	},
	phoneInsetX0: {
		"@media (max-width: 720px)": {
			"insetInline": "0"
		}
	},
	phoneRight0: {
		"@media (max-width: 720px)": {
			"right": "0"
		}
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phoneTopCalcVarHeaderH8px: {
		"@media (max-width: 720px)": {
			"top": "calc(var(--header-h) + 8px)"
		}
	},
	insetX0: {
		"insetInline": "0"
	},
	bottom124px: {
		"bottom": "124px"
	},
	phoneFixed: {
		"@media (max-width: 720px)": {
			"position": "fixed"
		}
	},
	phoneBottomAuto: {
		"@media (max-width: 720px)": {
			"bottom": "auto"
		}
	},
	phoneTopPaneHeader: {
		"@media (max-width: 720px)": {
			"top": "calc(var(--pane-header-h) + var(--strip-clearance, 0px) + 8px)"
		}
	},
	bottom2: {
		"bottom": "8px"
	},
	left2: {
		"left": "8px"
	},
	z9500: {
		"zIndex": "9500"
	},
	flex: {
		"display": "flex"
	},
	wFit: {
		"width": "fit-content"
	},
	maxWCalc100vw16px: {
		"maxWidth": "calc(100vw - 16px)"
	},
	flexCol: {
		"flexDirection": "column"
	},
	gap2: {
		"gap": "8px"
	},
	pointerEventsAuto: {
		"pointerEvents": "auto"
	},
	wFull: {
		"width": "100%"
	},
	itemsCenter: {
		"alignItems": "center"
	},
	justifyBetween: {
		"justifyContent": "space-between"
	},
	roundedRow: {
		"borderRadius": "calc(12px * var(--rf))"
	},
	border: {
		"borderStyle": "var(--tw-border-style)",
		"borderWidth": "1px"
	},
	borderColorVarComposerBorder: {
		"borderColor": "var(--composer-border)"
	},
	bgVarComposerSurface: {
		"backgroundColor": "var(--composer-surface)"
	},
	py15: {
		"paddingBlock": "6px"
	},
	pr15: {
		"paddingRight": "6px"
	},
	pl3: {
		"paddingLeft": "12px"
	},
	phoneShadowVarComposerShadow: {
		"@media (max-width: 720px)": {
			"--tw-shadow": "var(--composer-shadow)",
			"boxShadow": "var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)"
		}
	},
	animateUpdateToastInVarDurLgVarEase: {
		"animation": "update-toast-in var(--dur-lg) var(--ease)"
	},
	motionReduceAnimateNone: {
		"@media (prefers-reduced-motion: reduce)": {
			"animation": "none"
		}
	},
});

/**
 * Screen-level notification lanes.
 *
 * Live status stays near the app header. Toast receipts sit above the composer
 * at every width. Persistent prompts use the bottom-left desktop shelf; their
 * phone equivalents belong in the app header so they remain visible without
 * covering controls.
 */
export const TRANSIENT_NOTICE_LANE =
	mergeStylexClassName("", sx.pointerEventsNone, sx.fixed, sx.right4, sx.topCalcVarDesktopHeaderH8px, sx.z200) + " " +
	mergeStylexClassName("", sx.phoneInsetX0, sx.phoneRight0, sx.phonePx3, sx.phoneTopCalcVarHeaderH8px);

export const TOAST_NOTICE_LANE =
	mergeStylexClassName("", sx.pointerEventsNone, sx.insetX0, sx.bottom124px, sx.z200);

/** Live phone status clears the fixed header and an optional docked tab strip. */
export const ONGOING_TOAST_POSITION =
	mergeStylexClassName("", sx.phoneFixed, sx.phoneTopPaneHeader, sx.phoneBottomAuto);

export const PERSISTENT_NOTICE_SHELF =
	mergeStylexClassName("", sx.pointerEventsNone, sx.fixed, sx.bottom2, sx.left2, sx.z9500, sx.flex, sx.wFit) + " " +
	mergeStylexClassName("", sx.maxWCalc100vw16px, sx.flexCol, sx.gap2);

/** Card shared by durable update and desktop-link prompts. */
export const PERSISTENT_NOTICE_CARD =
	mergeStylexClassName("", sx.pointerEventsAuto, sx.flex, sx.wFull, sx.itemsCenter, sx.justifyBetween, sx.gap2) + " " +
	mergeStylexClassName("", sx.roundedRow, sx.border, sx.borderColorVarComposerBorder, sx.bgVarComposerSurface) + " " +
	mergeStylexClassName("smooth-shadow-md", sx.py15, sx.pr15, sx.pl3, sx.phoneShadowVarComposerShadow) + " " +
	mergeStylexClassName("", sx.animateUpdateToastInVarDurLgVarEase, sx.motionReduceAnimateNone);
