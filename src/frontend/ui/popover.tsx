import * as React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { cn } from "./cn";

/**
 * Popover on Base UI parts, styled with Tailwind tokens. Composable shape —
 * consumers assemble Root/Trigger/Popup. Pass `openOnHover` on the Trigger for
 * hover-card behavior; the trigger stays a real button, so touch devices open
 * it with a tap (hover-only affordances are unreachable on iOS).
 *
 * Like ui/menu.tsx this animates with CSS transitions on Base UI's
 * [data-starting-style]/[data-ending-style] lifecycle attributes rather than a
 * Motion render prop, keeping the injected a11y attributes intact.
 */

function Trigger({
	className,
	...props
}: Omit<React.ComponentProps<typeof BasePopover.Trigger>, "className"> & {
	className?: string;
}) {
	return <BasePopover.Trigger {...props} className={cn(className)} />;
}

function Popup({
	className,
	side,
	align,
	sideOffset = 8,
	children,
}: {
	className?: string;
	side?: React.ComponentProps<typeof BasePopover.Positioner>["side"];
	align?: React.ComponentProps<typeof BasePopover.Positioner>["align"];
	sideOffset?: number;
	children: React.ReactNode;
}) {
	return (
		<BasePopover.Portal>
			<BasePopover.Positioner
				side={side}
				align={align}
				sideOffset={sideOffset}
				collisionPadding={8}
				className="z-[10001] outline-none"
			>
				<BasePopover.Popup
					// A preview card, not a form: don't yank focus into the popup.
					initialFocus={false}
					className={cn(
						"rounded-[10px] border border-line-strong bg-panel shadow-[0_10px_30px_rgba(0,0,0,0.32)] outline-none",
						"origin-[var(--transform-origin)] transition-[transform,opacity] duration-[120ms] ease-out",
						"data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
						"data-[ending-style]:opacity-0",
						className,
					)}
				>
					{children}
				</BasePopover.Popup>
			</BasePopover.Positioner>
		</BasePopover.Portal>
	);
}

export const Popover = {
	Root: BasePopover.Root,
	Trigger,
	Popup,
};
