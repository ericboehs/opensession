import * as React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { cn } from "./cn";
import {
	useExclusivePopup,
	useExclusivePopupDelay,
} from "./exclusive-popups";

/**
 * Popover on Base UI parts, styled with Tailwind tokens. Composable shape —
 * consumers assemble Root/Trigger/Popup. Pass `openOnHover` on the Trigger for
 * hover-card behavior; the trigger stays a real button, so touch devices open
 * it with a tap (hover-only affordances are unreachable on iOS).
 *
 * Like ui/menu.tsx this animates with CSS transitions on Base UI's
 * [data-starting-style]/[data-ending-style] lifecycle attributes rather than a
 * Motion render prop, keeping the injected a11y attributes intact.
 * Roots also close the previously open popover through an imperative registry;
 * Base UI does not provide tooltip-style delay grouping for hover popovers.
 */

function Trigger({
	className,
	delay,
	...props
}: Omit<React.ComponentProps<typeof BasePopover.Trigger>, "className"> & {
	className?: string;
}) {
	const groupedDelay = useExclusivePopupDelay(delay);
	return (
		<BasePopover.Trigger
			{...props}
			delay={groupedDelay}
			className={cn(className)}
		/>
	);
}

function Root<Payload = unknown>({
	actionsRef,
	onOpenChange,
	...props
}: BasePopover.Root.Props<Payload>) {
	const internalActionsRef = React.useRef<BasePopover.Root.Actions | null>(null);
	const entry = React.useMemo(
		() => ({ close: () => internalActionsRef.current?.close() }),
		[],
	);
	const group = useExclusivePopup(entry);

	React.useImperativeHandle(
		actionsRef,
		() => internalActionsRef.current as BasePopover.Root.Actions,
		[],
	);

	return (
		<BasePopover.Root
			{...props}
			actionsRef={internalActionsRef}
			onOpenChange={(open, eventDetails) => {
				if (open) group?.activate(entry);
				else group?.deactivate(entry);
				onOpenChange?.(open, eventDetails);
			}}
		/>
	);
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
						"rounded-[14px] [corner-shape:squircle] border border-line-strong bg-panel shadow-[0_10px_30px_rgba(0,0,0,0.32)] outline-none",
						"origin-[var(--transform-origin)] transition-[transform,opacity] duration-[120ms] ease-out",
						"data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
						"data-[ending-style]:opacity-0 data-[ending-style]:transition-none",
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
	Root,
	Trigger,
	Popup,
};
