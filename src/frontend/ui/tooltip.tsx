import * as React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { motion } from "motion/react";
import { cn } from "./cn";
import { popupMotion } from "./motion";

/**
 * Tooltip on Base UI (Tooltip.Root/Trigger/Positioner/Popup), styled with
 * Tailwind tokens, animated with Motion. First component of the ui/ layer —
 * the pattern to copy for new primitives: Base UI parts for behavior
 * (positioning, collision flip, focus/hover semantics, a11y), our classes via
 * cn() with className passthrough, Motion presets from ui/motion.ts.
 *
 * Keeps the exact API of the old hand-rolled components/Tooltip.tsx
 * (label/side/offset/shortcut, single-element child, no wrapper DOM) so call
 * sites didn't change. Open delay + instant group hand-off between adjacent
 * triggers come from <TooltipProvider> at the app root.
 *
 * Motion animates the enter only; close unmounts instantly (same as the old
 * CSS tooltip). Don't add AnimatePresence for exit here — it can't track the
 * popup through Base UI's portal, so it silently does nothing.
 */

type Side = "top" | "bottom" | "left" | "right";

/** Mount once at the app root: shared 200ms open delay, and for 300ms after a
 * tooltip closes, neighbouring triggers open instantly (toolbar sweep). */
export function TooltipProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<BaseTooltip.Provider delay={200} timeout={300}>
			{children}
		</BaseTooltip.Provider>
	);
}

export function Tooltip({
	label,
	side = "top",
	offset = 8,
	shortcut,
	children,
}: {
	label: React.ReactNode;
	side?: Side;
	offset?: number;
	/** Optional keyboard-shortcut badges, e.g. ["⌘", "S"]. */
	shortcut?: string[];
	children: React.ReactElement;
}) {
	if (!label) return children;

	return (
		<BaseTooltip.Root>
			<BaseTooltip.Trigger render={children} />
			<BaseTooltip.Portal>
				<BaseTooltip.Positioner
					side={side}
					sideOffset={offset}
					collisionPadding={6}
					className="z-[10001]"
				>
					<BaseTooltip.Popup
						render={
							<motion.div
								// The render-prop merge drops Base UI's own role attr,
								// so restore it (screen readers + our test hooks).
								role="tooltip"
								initial={popupMotion.initial}
								animate={popupMotion.animate}
								transition={popupMotion.transition}
								style={{ transformOrigin: "var(--transform-origin)" }}
							/>
						}
						className={cn(
							"pointer-events-none flex max-w-[280px] items-center gap-2",
							// Sized after tella-fusion's UI__Tooltip3: 13px medium text
							// (Tella overrides text-xs to 13px) on a near-black chip with
							// its soft `shadow-popup` + our theme ring.
							"rounded-panel bg-tooltip px-2 py-1 text-[13px] leading-snug font-medium whitespace-nowrap text-tooltip-fg",
							"shadow-[0px_10px_38px_-10px_rgba(14,18,22,0.35),0px_10px_20px_-15px_rgba(14,18,22,0.2),0_0_0_1px_var(--tooltip-ring)]",
						)}
					>
						<span className="overflow-hidden text-ellipsis">{label}</span>
						{shortcut && shortcut.length > 0 && (
							<span className="inline-flex items-center gap-[3px]">
								{shortcut.map((k, i) => (
									<kbd
										key={i}
										className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-[3px] text-xs font-medium [font-family:inherit] bg-white/20 text-white/75"
									>
										{k}
									</kbd>
								))}
							</span>
						)}
					</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	);
}
