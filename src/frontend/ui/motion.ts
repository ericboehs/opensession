/**
 * Shared Motion presets so micro-interactions feel like one system instead of
 * per-component guesses. Use `motion.*` / `AnimatePresence` directly in
 * components and spread these — don't build wrapper components around Motion.
 */

import type { Transition } from "motion/react";

/** Snappy pop for small anchored popups (tooltips, menus, popovers). */
export const popupTransition: Transition = {
	type: "spring",
	duration: 0.18,
	bounce: 0,
};

/**
 * Enter/exit for anchored popups, tuned to read like the old tt-in keyframes
 * (fade + slight scale from the anchor side). Pair with
 * `style={{ transformOrigin: "var(--transform-origin)" }}` on Base UI popups —
 * the Positioner sets that variable to face the anchor.
 */
export const popupMotion = {
	initial: { opacity: 0, scale: 0.96 },
	animate: { opacity: 1, scale: 1 },
	exit: { opacity: 0, transition: { duration: 0.1 } },
	transition: popupTransition,
} as const;
