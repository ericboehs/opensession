/**
 * Shared Motion presets so micro-interactions feel like one system instead of
 * per-component guesses. Use `motion.*` / `AnimatePresence` directly in
 * components and spread these — don't build wrapper components around Motion.
 */

import { MotionGlobalConfig, type Transition } from "motion/react";

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

/**
 * Morph for the mobile composer collapsing to / expanding from its single-row
 * resting pill. Gentle spring with a hint of bounce so the shape change reads
 * as a settle, not a snap. Used as the `layout` transition on the composer and
 * the enter/exit of its toolbar chips.
 */
export const composerMorph: Transition = {
	type: "spring",
	duration: 0.32,
	bounce: 0.14,
};

/**
 * Enter for the composer's toolbar chips (model/effort/goal) as it expands — a
 * quick fade + scale from the collapsed baseline. Deliberately no `exit`: on
 * collapse the chips are removed instantly (the container's layout glide carries
 * the motion) so they don't briefly reflow through the reordered single-row.
 */
export const composerChipMotion = {
	initial: { opacity: 0, scale: 0.8 },
	animate: { opacity: 1, scale: 1 },
	transition: composerMorph,
} as const;

/**
 * Suppress Motion animations for the duration of a synchronous UI gesture such
 * as a drag-resize, then restore. While active, any Motion animation that
 * STARTS snaps to its end instead of tweening — crucially this includes the
 * `layout` ("morph") animations the composer and sidebar rows run whenever
 * their measured width changes. Dragging the sidebar / right-panel resize
 * handles changes those widths on every mousemove; without this each step
 * springs, which reads as a "funky" text morph. (Motion already blocks layout
 * animation during a real window resize via projection update-blocking; a
 * custom drag doesn't trip that path, so we snap explicitly.)
 *
 * Returns a restore fn. It defers by one frame so the gesture's final layout
 * change settles instantly too, before normal animation resumes.
 */
export function suppressLayoutAnimations(): () => void {
	const prev = MotionGlobalConfig.instantAnimations;
	MotionGlobalConfig.instantAnimations = true;
	return () => {
		requestAnimationFrame(() => {
			MotionGlobalConfig.instantAnimations = prev;
		});
	};
}
