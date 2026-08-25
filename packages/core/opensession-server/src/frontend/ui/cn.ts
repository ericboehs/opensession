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

type RegisteredOverride = {
	className: ClassValue;
	styles: ReadonlyArray<StyleXProp>;
};

/** Caller overrides passed through custom components. Ordinary shared class
 * maps stay opaque strings: replaying their compiled styles would collapse a
 * base + responsive pair into the conditional class only. */
const registeredOverrides = new Map<string, RegisteredOverride>();

function resolveOverrides(inputs: readonly ClassValue[]): {
	classNames: ClassValue[];
	styles: StyleXProp[];
} {
	const classNames: ClassValue[] = [];
	const styles: StyleXProp[] = [];
	const collect = (value: ClassValue): void => {
		if (!value) return;
		if (typeof value === "string") {
			const registered = registeredOverrides.get(value);
			if (registered) {
				collect(registered.className);
				styles.push(...registered.styles);
			} else classNames.push(value);
			return;
		}
		if (typeof value === "number") {
			classNames.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) collect(item);
			return;
		}
		if (typeof value === "object") {
			for (const [name, enabled] of Object.entries(value)) {
				if (enabled) collect(name);
			}
		}
	};
	for (const input of inputs) collect(input);
	return { classNames, styles };
}

/** Join semantic/residual hooks. If a caller override travels through cn(),
 * preserve its metadata for the primitive's mergeStylexProps boundary. */
export function cn(...inputs: ClassValue[]): string {
	const resolved = resolveOverrides(inputs);
	const props = stylex.props(...resolved.styles);
	const result = clsx(resolved.classNames, props.className);
	if (result && resolved.styles.length > 0) {
		registeredOverrides.set(result, {
			className: resolved.classNames,
			styles: resolved.styles,
		});
	}
	return result;
}

/** Compose primitive defaults with caller overrides. */
export function mergeStylexProps(
	className: ClassValue,
	...styles: ReadonlyArray<StyleXProp>
) {
	const override = resolveOverrides([className]);
	const props = stylex.props(...styles, ...override.styles);
	return { ...props, className: clsx(override.classNames, props.className) };
}

/** Class-name form for shared style maps and third-party APIs. The result stays
 * opaque so base and responsive classes can coexist in the cascade. */
export function mergeStylexClassName(
	className: ClassValue,
	...styles: ReadonlyArray<StyleXProp>
): string {
	const props = stylex.props(...styles);
	return clsx(className, props.className);
}

/** Class-name form specifically for a custom component's caller override. The
 * receiving primitive's mergeStylexProps() will compose these styles after its
 * defaults, preserving the pre-migration cn(defaults, className) contract. */
export function mergeStylexOverrideClassName(
	className: ClassValue,
	...styles: ReadonlyArray<StyleXProp>
): string {
	const props = stylex.props(...styles);
	const result = clsx(className, props.className);
	if (result) registeredOverrides.set(result, { className, styles });
	return result;
}
