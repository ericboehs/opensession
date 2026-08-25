import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import * as stylex from "@stylexjs/stylex";
import type { CompiledStyles, InlineStyles, StyleXArray } from "@stylexjs/stylex";

type StyleXProp = StyleXArray<
	| null
	| undefined
	| CompiledStyles
	| boolean
	| Readonly<[CompiledStyles, InlineStyles]>
>;

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	px3: {
			paddingInline: "12px"
	},
});

/**
 * The semantic type scale from styles/tailwind.css. tailwind-merge only ships
 * knowledge of the stock `text-*` sizes (xs/sm/base/lg/…), and `text-*` is an
 * ambiguous prefix — it spells both font-size and text color. Anything it
 * doesn't recognise as a size it therefore files under color, which meant
 * `cn("… text-white …", "text-control-label")` dropped the `text-white` as a
 * conflicting color and left the label inheriting the surface's text color.
 * That is exactly what turned the primary CTA on Home into dark-on-red.
 *
 * Registering the scale here keeps size and color in separate conflict groups,
 * so a caller can restyle a primitive's type without silently unstyling it.
 *
 * Adding a `--text-*` token to styles/tailwind.css? Add it to this list too.
 * A token that is missing here still works as a font-size — it just quietly
 * takes the color off whatever it is applied to, which is easy to miss in dark
 * mode where the inherited color is close to the intended one.
 */
const semanticFontSizes = [
	"meta",
	"supporting",
	"control-label",
	"label",
	"body",
	"item-title",
	"dialog-title",
	"section-title",
	"page-title",
] as const;

const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			"font-size": [{ text: [...semanticFontSizes] }],
			// `rounded-control` (the chrome corner, styles/tailwind.css) has the
			// same problem in the radius group: unregistered, tailwind-merge
			// cannot tell it conflicts with `rounded-full`, so a caller's
			// override lands *alongside* the primitive's corner instead of
			// replacing it and the winner is decided by stylesheet order. That
			// currently favours the override by luck — reordering the theme
			// tokens would silently square off AskCard's pill.
			rounded: [{ rounded: ["control"] }],
		},
	},
});

/**
 * Class combiner for the ui/ layer: clsx for conditionals, tailwind-merge so
 * a caller's className can override a wrapper's defaults (`cn("px-2", className)`
 * with {...stylex.props(sx.px3)} yields px-3, not both). Every ui/ component must pass
 * its className prop through this — a wrapper that swallows className forces
 * call sites to fork it.
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

/** Compose residual/semantic class hooks with StyleX without letting JSX's
 * last-prop-wins semantics discard either side. Keep StyleX styles as ordered
 * arguments so its runtime can resolve property conflicts before adding the
 * remaining class string. */
export function mergeStylexProps(
	className: ClassValue,
	...styles: ReadonlyArray<StyleXProp>
) {
	const props = stylex.props(...styles);
	return { ...props, className: cn(className, props.className) };
}
