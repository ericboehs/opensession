import React, { useEffect, useState } from "react";

/**
 * Pixel spinner — a 3×3 grid of tiny pixels that light up in animated
 * patterns, ported from tella-fusion's `UI__PixelSpinner`. The pixels inherit
 * the surrounding text color (via `currentColor`), so dropping one inside a
 * colored chip (e.g. the green "Working" pill) tints it automatically.
 *
 * Styling + keyframes live in global.css under the "PIXEL SPINNER" section.
 * When `cycling`, it swaps to a random pattern every `interval` ms so a
 * long-running indicator never looks static.
 */
const PATTERNS = [
	"wave-lr",
	"wave-tb",
	"ripple-out",
	"snake",
	"spiral-cw",
	"corners",
	"diamond",
	"stripes-h",
	"stripes-v",
	"rain",
	"diagonal-br",
	"frame",
	"orbit",
	"scan-h",
	"scan-v",
	"loading-bar",
	"heartbeat",
	"dots",
	"bounce",
	"shuffle",
] as const;

function randomPattern(): string {
	return PATTERNS[Math.floor(Math.random() * PATTERNS.length)];
}

interface Props {
	/** Cycle through patterns while mounted (default true). */
	cycling?: boolean;
	/** Ms between pattern swaps when cycling (default 2000). */
	interval?: number;
	className?: string;
}

export function PixelSpinner({ cycling = true, interval = 2000, className = "" }: Props) {
	const [pattern, setPattern] = useState(randomPattern);

	useEffect(() => {
		if (!cycling) return;
		const id = setInterval(() => setPattern(randomPattern()), interval);
		return () => clearInterval(id);
	}, [cycling, interval]);

	return (
		<div className={`pixel-spinner ${pattern} ${className}`.trim()} aria-hidden>
			{Array.from({ length: 9 }, (_, i) => (
				<div key={i} className="pixel" />
			))}
		</div>
	);
}
