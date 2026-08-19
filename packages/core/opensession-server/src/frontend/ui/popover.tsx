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
	arrow = false,
	elevation = "md",
	anchor,
	initialFocus = false,
	children,
}: {
	className?: string;
	side?: React.ComponentProps<typeof BasePopover.Positioner>["side"];
	align?: React.ComponentProps<typeof BasePopover.Positioner>["align"];
	sideOffset?: number;
	/** Draw a callout diamond pointing back at the anchor, bridging
	 * `sideOffset`. Matches the sidebar's legacy hover card, so a popup that
	 * sits beside one of those reads as the same object. */
	arrow?: boolean;
	/** Large preview cards need a wider cast shadow than compact popovers. */
	elevation?: "md" | "lg";
	/** Position against something other than the Trigger — pass the wrapper of a
	 * control cluster whose popup opens from several places (a caret, a
	 * right-click, a disabled button), so the popup keeps one anchor no matter
	 * which of them opened it. */
	anchor?: React.ComponentProps<typeof BasePopover.Positioner>["anchor"];
	/** Defaults to false: most popups here are hover preview cards, and yanking
	 * focus out of the page on hover would be hostile. Pass `true` for a
	 * click-opened popup that holds controls, so the keyboard reaches them. */
	initialFocus?: React.ComponentProps<typeof BasePopover.Popup>["initialFocus"];
	children: React.ReactNode;
}) {
	return (
		<BasePopover.Portal>
			<BasePopover.Positioner
				side={side}
				align={align}
				sideOffset={sideOffset}
				anchor={anchor}
				collisionPadding={8}
				// Keep the diamond clear of the popup's rounded corners.
				arrowPadding={14}
				className="z-[10001] outline-none"
			>
				<BasePopover.Popup
					initialFocus={initialFocus}
					className={cn(
						// The ring override rides on the popup so the arrow, which
						// continues that hairline, inherits the same value.
						"rounded-popup [corner-shape:squircle] outline-none",
						"bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)]",
						elevation === "lg"
							? "smooth-shadow-ring-lg"
							: "smooth-shadow-ring-md",
						"origin-[var(--transform-origin)] transition-[transform,opacity] duration-[120ms] ease-out",
						"data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
						"data-[ending-style]:opacity-0 data-[ending-style]:transition-none",
						className,
					)}
				>
					{arrow && (
						// A square rotated onto its point, half of it hanging off the
						// popup edge: the outward two borders continue the popup's
						// hairline. Base UI sets the cross-axis offset inline; the
						// main-axis one is ours.
						//
						// The clip is what lets the arrow be glass. Unclipped, its
						// inner half lies ON the popup, and two thinned fills stacked
						// composite brighter than one — the whole diamond shows
						// through the card as a wedge, which is exactly the seam a
						// pointer is meant not to have. Clipped to the half that
						// hangs off, arrow and popup tile edge to edge and read as
						// one sheet of glass. Each polygon is that half plus a ~1px
						// sliver past the diagonal, so the arrow's own fill covers
						// the popup's hairline where it would otherwise draw a line
						// across the arrow's base.
						<BasePopover.Arrow
							className={cn(
								"size-[10px] rotate-45 [border-color:var(--smooth-ring-color)]",
								"bg-popup-glass [backdrop-filter:var(--popup-blur)]",
								"data-[side=right]:left-[-5px] data-[side=right]:border-b data-[side=right]:border-l",
								"data-[side=right]:[clip-path:polygon(14%_0,0_0,0_100%,100%_100%,100%_86%)]",
								"data-[side=left]:right-[-6px] data-[side=left]:border-t data-[side=left]:border-r",
								"data-[side=left]:[clip-path:polygon(0_0,100%_0,100%_100%,86%_100%,0_14%)]",
								"data-[side=top]:bottom-[-6px] data-[side=top]:border-r data-[side=top]:border-b",
								"data-[side=top]:[clip-path:polygon(100%_0,100%_100%,0_100%,0_86%,86%_0)]",
								"data-[side=bottom]:top-[-6px] data-[side=bottom]:border-t data-[side=bottom]:border-l",
								"data-[side=bottom]:[clip-path:polygon(0_0,100%_0,100%_14%,14%_100%,0_100%)]",
							)}
						/>
					)}
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
