import React from "react";

/**
 * Pixel spinner — a 3×3 grid of tiny pixels that light up in a single,
 * consistent diagonal wave sweeping top-left → bottom-right (the
 * `diagonal-br` pattern). The wavefront runs along successive anti-diagonals,
 * so the number of lit pixels grows 1 → 2 → 3 and then recedes 3 → 2 → 1 as
 * it crosses the grid. Ported from tella-fusion's `UI__PixelSpinner`. The
 * pixels inherit the surrounding text color (via `currentColor`), so the
 * color is controlled by the caller's text class (e.g. `text-fg` for a
 * neutral black/white loader).
 *
 * Styling + keyframes live in global.css under the "PIXEL SPINNER" section.
 *
 * The pattern is intentionally fixed (not random per instance) so every
 * loader in the app looks identical — a row of session spinners reads as one
 * consistent indicator rather than a different animation each. `cycling` and
 * `interval` are kept for call-site compatibility but no longer switch the
 * pattern.
 */
interface Props {
	/** Retained for compatibility; the pattern no longer changes over time. */
	cycling?: boolean;
	/** Retained for compatibility; no longer used. */
	interval?: number;
	className?: string;
}

export function PixelSpinner({ className = "" }: Props) {
	return (
		<div className={`pixel-spinner diagonal-br ${className}`.trim()} aria-hidden>
			{Array.from({ length: 9 }, (_, i) => (
				<div key={i} className="pixel" />
			))}
		</div>
	);
}
