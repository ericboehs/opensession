import * as React from "react";
import { cn } from "./cn";

/**
 * Button primitive — the shared optics for text, icon+label, and icon-only
 * buttons. New buttons go through this; legacy `.btn-*` classes in global.css
 * migrate here opportunistically when touched (strangler pattern).
 *
 * The icon/spacing rules are ported from tella-fusion's button system
 * (webapp Button.res + ButtonWithIcon.res — the product these iconic-pro
 * glyphs come from):
 *
 *  - icon ↔ label gap is 4px, with 20px iconic glyphs (their `w-5 h-5`
 *    convention; matches our icons.tsx size-20 "inline/meta" step);
 *  - when an icon LEADS a label, pull the icon-side padding in 2px
 *    (Tella: px-3 → pl-2.5) so the pair reads optically balanced against a
 *    text-only button — the glyph's built-in whitespace otherwise makes the
 *    icon side look padded out;
 *  - dim the leading icon relative to the label (Tella: opacity-50 on
 *    neutral weights, a lighter tint on the primary) — the label stays the
 *    dominant read, the icon is support;
 *  - icon-only buttons go square with symmetric padding and the icon
 *    dead-centered, UNdimmed — there the icon *is* the label;
 *  - press feedback is a whole-button scale tick (Tella: active:scale-97).
 */

type Variant = "default" | "primary" | "ghost" | "danger";
type Size = "sm" | "md";

const sizes: Record<Size, string> = {
	// Heights bracket the app's existing chrome: 32px matches the viewer
	// header buttons, 26px the chip/inline tier.
	sm: "min-h-[26px] px-2.5 text-xs rounded-xs",
	md: "min-h-8 px-3 text-sm rounded-sm",
};

// Leading icon + label: shave 2px off the icon side (see doc block).
const iconLeadPad: Record<Size, string> = {
	sm: "pl-2",
	md: "pl-2.5",
};

// Icon-only: square hit target, symmetric.
const iconOnlyPad: Record<Size, string> = {
	sm: "w-[26px] px-0",
	md: "w-8 px-0",
};

const variants: Record<Variant, string> = {
	// The raised control look of the newest chrome (viewer Share button).
	default:
		"bg-control border-line text-dim shadow-control hover:text-fg hover:border-line-strong",
	primary:
		"bg-accent border-transparent text-white shadow-control hover:brightness-110",
	ghost: "border-transparent text-dim hover:bg-hover hover:text-fg",
	// Outline red, like the delete-worktree confirm buttons.
	danger: "border-red text-red hover:bg-red-soft",
};

// Leading-icon dimming per variant (icon-only stays full strength).
const iconDim: Record<Variant, string> = {
	default: "opacity-60",
	primary: "opacity-80",
	ghost: "opacity-60",
	danger: "opacity-80",
};

export type ButtonProps = React.ComponentPropsWithoutRef<"button"> & {
	variant?: Variant;
	size?: Size;
	/** Leading icon — pass a 20px glyph from components/icons.tsx. Renders an
	 * icon-only square button when there are no children. */
	icon?: React.ReactNode;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	function Button(
		{ variant = "default", size = "md", icon, className, children, ...rest },
		ref,
	) {
		const hasLabel = children != null && children !== false && children !== "";
		const iconOnly = icon != null && !hasLabel;
		return (
			<button
				type="button"
				ref={ref}
				className={cn(
					"inline-flex items-center justify-center gap-1 border whitespace-nowrap select-none",
					"font-[550] transition active:scale-[0.97]",
					"disabled:pointer-events-none disabled:opacity-40",
					sizes[size],
					variants[variant],
					icon != null && hasLabel && iconLeadPad[size],
					iconOnly && iconOnlyPad[size],
					className,
				)}
				{...rest}
			>
				{icon != null && (
					<span
						className={cn(
							"inline-flex shrink-0 items-center",
							!iconOnly && iconDim[variant],
						)}
					>
						{icon}
					</span>
				)}
				{children}
			</button>
		);
	},
);
