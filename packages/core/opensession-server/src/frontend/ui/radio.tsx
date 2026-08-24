import * as React from "react";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { cn } from "./cn";
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
});

type RadioProps = React.ComponentProps<typeof BaseRadio.Root>;
type RadioGroupProps = React.ComponentProps<typeof BaseRadioGroup>;

/** The app's radio control for choosing one option from a visible set. */
export function Radio({ className, ...props }: RadioProps) {
	return (
		<BaseRadio.Root
			className={cn(
				"flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line-strong bg-surface p-0 outline-none",
				"transition-[background-color,border-color] duration-[var(--dur-micro)] ease-[var(--ease)]",
				"hover:border-faint",
				"data-[checked]:border-accent-control data-[checked]:bg-accent-control data-[checked]:hover:border-accent-control",
				"focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
				"data-[disabled]:cursor-default data-[disabled]:opacity-40",
				className,
			)}
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
