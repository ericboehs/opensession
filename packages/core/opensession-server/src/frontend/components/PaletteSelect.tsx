import React, { useState } from "react";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { isApple } from "../lib/platform";

export type PaletteSelectOption = {
	value: string;
	label: string;
	menuLabel?: string;
	/** Optional leading icon shown before the label in the desktop menu. */
	icon?: React.ReactNode;
	/**
	 * Multi-select pickers only: this row can be picked on its own but never
	 * alongside another, so the modifier falls through to a plain pick.
	 */
	singleOnly?: boolean;
};

type Props = {
	value: string;
	options: PaletteSelectOption[];
	onChange: (value: string) => void;
	/**
	 * Values picked alongside `value`, in the order they were added. Passing
	 * `onToggleExtra` turns the menu multi-select: the platform's command
	 * modifier adds or removes a row and leaves the menu open, while a plain
	 * click still picks one row and closes.
	 */
	extraValues?: string[];
	onToggleExtra?: (value: string) => void;
	/** Footer line under the rows: the gesture has nowhere else to announce itself. */
	multiHint?: string;
	isPhone: boolean;
	className: string;
	children: React.ReactNode;
	ariaLabel: string;
	title?: string;
	disabled?: boolean;
	align?: "start" | "center" | "end";
};

export function PaletteSelect({
	value,
	options,
	onChange,
	extraValues,
	onToggleExtra,
	multiHint,
	isPhone,
	className,
	children,
	ariaLabel,
	title,
	disabled,
	align = "start",
}: Props) {
	// Owned here because a multi-select pick has to leave the menu up: Base UI
	// closes on `Menu.Item`'s own click, and `closeOnClick` is a per-item prop
	// rather than something the handler can decide, so the close is ours to
	// make. Single-select pickers behave exactly as they did.
	const [open, setOpen] = useState(false);

	if (isPhone) {
		return (
			<div className={className} title={title}>
				{children}
				{/* Invisible native <select> stacked over the styled trigger so we
				    get a real OS menu without hand-rolling a popover. There is no
				    modifier on a phone, so this stays single-select; a second repo
				    is added from the session's own repo menu instead. */}
				<select
					className="absolute inset-0 h-full w-full cursor-pointer appearance-none border-none opacity-0 disabled:cursor-default"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					aria-label={ariaLabel}
				>
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
		);
	}

	const picked = new Set([value, ...(extraValues || [])]);

	function pick(option: PaletteSelectOption, additive: boolean) {
		if (additive && onToggleExtra && !option.singleOnly) {
			onToggleExtra(option.value);
			return;
		}
		onChange(option.value);
		setOpen(false);
	}

	return (
		<Menu.Root open={open} onOpenChange={setOpen}>
			<Menu.Trigger
				type="button"
				className={className}
				title={title}
				disabled={disabled}
				aria-label={ariaLabel}
			>
				{children}
			</Menu.Trigger>
			<Menu.Popup align={align} sideOffset={6} className="max-w-[min(360px,calc(100vw-1rem))]">
				{options.map((option) => {
					const selected = picked.has(option.value);
					return (
						<Menu.Item
							key={option.value}
							closeOnClick={false}
							// Base UI hands a keyboard Enter to this same handler (as
							// the keyboard event, not a synthesized click), so the
							// modifier form works from the keyboard too.
							onClick={(e) => pick(option, isApple ? e.metaKey : e.ctrlKey)}
							// A hair of air between rows: more than one can be picked
							// here, and two selected rows that touch read as one block
							// with a pinched waist rather than as two repos.
							className={cn(
								"mt-0.5 justify-between gap-3 first:mt-0",
								selected && "bg-hover",
							)}
						>
							<span className="flex min-w-0 items-center gap-2.5">
								{option.icon && (
									<span className="flex shrink-0 text-dim" aria-hidden="true">
										{option.icon}
									</span>
								)}
								<span className="min-w-0 truncate">
									{option.menuLabel ?? option.label}
								</span>
							</span>
							<Menu.Check on={selected} className="text-dim" />
						</Menu.Item>
					);
				})}
				{onToggleExtra && multiHint && (
					// `w-0 min-w-full` keeps this line out of the popup's own width:
					// the hint changes as you pick, so a popup sized to it would be
					// one width teaching the gesture and another naming the repos.
					// The rows decide how wide the menu is; the hint wraps inside it.
					<div className="w-0 min-w-full px-2.5 pt-1.5 pb-0.5 text-supporting leading-snug text-faint">
						{multiHint}
					</div>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
