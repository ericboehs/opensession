import * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { cn } from "./cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	textOnAccentControl: {
			color: "var(--on-accent-control,var(--on-accent))"
	},
	size3: {
			width: "12px",
			height: "12px"
	},
});

type CheckboxProps = Omit<React.ComponentProps<typeof BaseCheckbox.Root>, "size"> & {
	className?: string;
};

/**
 * The app's checkbox: a form option you pick, as opposed to `Switch`, which
 * turns a setting on. It replaces the browser's own `input[type=checkbox]`,
 * whose fill is the UA accent rather than ours and whose box ignores the
 * corner and border scales every other control follows.
 *
 * It is labelable, so the existing pattern still works and the whole row stays
 * clickable:
 *
 *   <label {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
 *     <Checkbox checked={x} onCheckedChange={setX} />
 *     Include thread replies
 *   </label>
 */
export function Checkbox({ className, ...props }: CheckboxProps) {
	return (
		<BaseCheckbox.Root
			className={cn(
				"flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-line-strong bg-surface p-0 outline-none",
				"transition-[background-color,border-color] duration-[var(--dur-micro)] ease-[var(--ease)]",
				"hover:border-faint",
				"data-[checked]:border-accent-control data-[checked]:bg-accent-control data-[checked]:hover:border-accent-control",
				"focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
				"data-[disabled]:cursor-default data-[disabled]:opacity-40",
				className,
			)}
			{...props}
		>
			<BaseCheckbox.Indicator className="data-[unchecked]:hidden" {...stylex.props(sx.flex, sx.textOnAccentControl)}>
				<svg
					viewBox="0 0 12 12"
					{...stylex.props(sx.size3)}
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden
				>
					<path d="M2.4 6.3 4.7 8.6 9.6 3.5" />
				</svg>
			</BaseCheckbox.Indicator>
		</BaseCheckbox.Root>
	);
}
