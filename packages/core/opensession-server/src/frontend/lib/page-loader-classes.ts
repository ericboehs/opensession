/** Class strings for the page loader (ui/page-loader). Its own module rather
 * than constants in the component file, so the component stays component-only
 * and keeps React Fast Refresh — the same split lib/pixel-spinner-classes
 * makes. */

/** The row. Its height is the tallest bar's, so the mark occupies exactly its
 *  own ink and centres against a label without a correction. */
export const PAGE_LOADER_ROW = "flex h-4 items-center gap-1.5";

/** One bar, capped as a pill.
 *
 *  `rounded-full` is deliberate and is the one radius spelling that opts OUT of
 *  base.css's squircle rule. That rule is right almost everywhere, but a
 *  squircle takes far less off a corner than a circular arc at the same radius,
 *  and on a 4px-wide bar the difference is the whole shape: `rounded-xs` (or
 *  `rounded-[999px]`, which keeps the squircle) renders these as five little
 *  rectangles with the corners barely touched. The launch splash caps its own
 *  bars with a plain circular 2px radius, so a true pill is also the closer
 *  match to the thing this is echoing.
 *
 *  The animation is spelled as LONGHANDS rather than an `animate-[…]`
 *  shorthand: the shorthand resets `animation-delay`, so which of the two won
 *  would depend on Tailwind's output order rather than on the order they are
 *  written, and every bar would breathe in unison the moment the delay utility
 *  happened to be emitted first (the trap lib/pixel-spinner-classes documents).
 *
 *  Under prefers-reduced-motion the bars keep breathing. base.css freezes
 *  animation by default and excepts progress spinners for a reason that applies
 *  here more than anywhere: this mark is the only thing on an otherwise empty
 *  region saying the app is still working, and a frozen one reads as hung. What
 *  the preference does take away is the ripple — the stagger drops to zero, so
 *  the five bars breathe together, in place, at a slower rate. Gentler, not
 *  zero, and put on the element the way base.css asks new exceptions to be. */
export const PAGE_LOADER_BAR =
	"w-1 rounded-full bg-current " +
	"[animation-name:page-loader-bar] [animation-timing-function:ease-in-out] " +
	"[animation-iteration-count:infinite] [animation-duration:1s] " +
	"motion-reduce:[animation-delay:0ms]! motion-reduce:[animation-duration:1.8s]! " +
	"motion-reduce:[animation-iteration-count:infinite]!";

/** Per-bar height, weight and phase: a shallow arc that is tallest and
 *  brightest in the middle, with the wave entering from the left. Written out
 *  as literal utilities, because Tailwind only compiles class names it can find
 *  in the source — a built string like `[animation-delay:${n}ms]` compiles to
 *  nothing, and every bar would light at once.
 *
 *  The arc runs 8/12/16 where the launch splash (index.html) runs 6/10/14. The
 *  splash is sized against a 76px logo; here the mark stands alone above a 13px
 *  label, and at the splash's size the outer bars stop reading as bars and turn
 *  into two specks. What must NOT drift is the cadence — 1s, 0.6→1, 150ms
 *  apart, all restated in the shell — because that is what makes this the same
 *  wave the app opened with rather than a second, similar one. */
export const PAGE_LOADER_BARS = [
	"h-2 opacity-40 [animation-delay:0ms]",
	"h-3 opacity-70 [animation-delay:150ms]",
	"h-4 opacity-100 [animation-delay:300ms]",
	"h-3 opacity-70 [animation-delay:450ms]",
	"h-2 opacity-40 [animation-delay:600ms]",
];
