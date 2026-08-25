import * as React from "react";
import { cn } from "./cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	inlineBlock: {
			display: "inline-block"
	},
	shrink0: {
			flexShrink: "0"
	},
	animateSpin: {
			animation: "var(--animate-spin)"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	},
	borderCurrent25: {
			borderColor: "currentColor"
	},
	borderTCurrent: {
			borderTopColor: "currentColor"
	},
});

/**
 * The waiting spinner: a turning ring, for anything that is fetching,
 * uploading or preparing.
 *
 * It is deliberately not the PixelSpinner. That one is the app's *generating*
 * indicator: the wave a session wears while a model is producing output, so
 * wearing it to fetch a pull request reads as "the agent is working on this"
 * for a PR that has simply not arrived over the network yet. A ring says
 * "waiting", which is the truth on those surfaces.
 *
 * The same ring was hand-rolled in eight places (TurnBlock, PortalPane,
 * PreviewWait, CheckStatusIcon, VoiceInput…) at three different border widths;
 * this is that recipe, once. It inherits `currentColor`, so the caller's text
 * class picks the hue, and base.css keeps `animate-spin` turning under
 * prefers-reduced-motion.
 */
export type SpinnerSize = "sm" | "md" | "lg";

const sizes: Record<SpinnerSize, string> = {
	sm: "size-3 border",
	md: "size-4 border-2",
	lg: "size-5 border-2",
};

export function Spinner({
	size = "sm",
	className,
	...props
}: React.ComponentPropsWithoutRef<"span"> & { size?: SpinnerSize }) {
	return (
		<span
			aria-hidden
			className={cn(sizes[size], className)} {...stylex.props(sx.inlineBlock, sx.shrink0, sx.animateSpin, sx.roundedFull, sx.borderCurrent25, sx.borderTCurrent)}
			{...props}
		/>
	);
}
