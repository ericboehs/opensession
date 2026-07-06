import React from "react";
import { Menu } from "../ui/menu";
import { IconCheck } from "./icons";

export type PaletteSelectOption = {
	value: string;
	label: string;
	menuLabel?: string;
	/** Optional leading icon shown before the label in the desktop menu. */
	icon?: React.ReactNode;
};

type Props = {
	value: string;
	options: PaletteSelectOption[];
	onChange: (value: string) => void;
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
	isPhone,
	className,
	children,
	ariaLabel,
	title,
	disabled,
	align = "start",
}: Props) {
	if (isPhone) {
		return (
			<div className={className} title={title}>
				{children}
				<select
					className="palette-select-overlay"
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

	return (
		<Menu.Root>
			<Menu.Trigger
				type="button"
				className={className}
				title={title}
				disabled={disabled}
				aria-label={ariaLabel}
			>
				{children}
			</Menu.Trigger>
			<Menu.Popup align={align} sideOffset={6} className="palette-select-menu">
				{options.map((option) => {
					const selected = option.value === value;
					return (
						<Menu.Item
							key={option.value}
							onClick={() => onChange(option.value)}
							className={`palette-select-menu-item ${selected ? "is-selected" : ""}`}
						>
							<span className="palette-select-menu-main">
								{option.icon && (
									<span className="palette-select-menu-icon" aria-hidden="true">
										{option.icon}
									</span>
								)}
								<span className="palette-select-menu-label">
									{option.menuLabel ?? option.label}
								</span>
							</span>
							{selected && <IconCheck className="palette-select-menu-check" size={17} />}
						</Menu.Item>
					);
				})}
			</Menu.Popup>
		</Menu.Root>
	);
}
