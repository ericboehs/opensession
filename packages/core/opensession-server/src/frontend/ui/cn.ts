import { clsx, type ClassValue } from "clsx";
import * as stylex from "@stylexjs/stylex";
import type { CompiledStyles, InlineStyles, StyleXArray } from "@stylexjs/stylex";

type StyleXProp = StyleXArray<
	| null
	| undefined
	| CompiledStyles
	| boolean
	| Readonly<[CompiledStyles, InlineStyles]>
>;

/** Join semantic and residual class hooks. StyleX resolves property conflicts
 * before classes reach this boundary, so this helper only needs clsx. */
export function cn(...inputs: ClassValue[]): string {
	return clsx(inputs);
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

/** Class-name form for third-party component APIs and legacy shared style maps
 * that cannot accept a JSX props spread. */
export function mergeStylexClassName(
	className: ClassValue,
	...styles: ReadonlyArray<StyleXProp>
): string {
	return mergeStylexProps(className, ...styles).className ?? "";
}
