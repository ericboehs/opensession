import * as React from "react";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { cn, mergeStylexProps } from "./cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	size15: {
			width: "6px",
			height: "6px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	},
	bgOnAccentControl: {
			backgroundColor: "var(--on-accent-control,var(--on-accent))"
	},
	flex: {
			display: "flex"
	},
	size4: {
			width: "16px",
			height: "16px"
	},
	shrink0: {
			flexShrink: "0"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderLineStrong: {
			borderColor: "var(--border-strong)"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	p0: {
			padding: "0"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	durationVarDurMicro: {
			transitionDuration: "var(--dur-micro)"
	},
	easeVarEase: {
			transitionTimingFunction: "var(--ease)"
	},
});

type RadioProps = React.ComponentProps<typeof BaseRadio.Root>;
type RadioGroupProps = React.ComponentProps<typeof BaseRadioGroup>;

/** The app's radio control for choosing one option from a visible set. */
export function Radio({ className, ...props }: RadioProps) {
	return (
		<BaseRadio.Root {...mergeStylexProps(cn("transition-[background-color,border-color]", "hover:border-faint", "data-[checked]:border-accent-control data-[checked]:bg-accent-control data-[checked]:hover:border-accent-control", "focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg", "data-[disabled]:cursor-default data-[disabled]:opacity-40", className), sx.flex, sx.size4, sx.shrink0, sx.cursorPointer, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.border, sx.borderLineStrong, sx.bgSurface, sx.p0, sx.outlineNone, sx.durationVarDurMicro, sx.easeVarEase)}
			{...props}
		>
			<BaseRadio.Indicator {...stylex.props(sx.size15, sx.roundedFull, sx.bgOnAccentControl)} />
		</BaseRadio.Root>
	);
}

/** Coordinates a visible set of `Radio` controls. */
export function RadioGroup({ className, ...props }: RadioGroupProps) {
	return <BaseRadioGroup className={cn(className)} {...props} />;
}
