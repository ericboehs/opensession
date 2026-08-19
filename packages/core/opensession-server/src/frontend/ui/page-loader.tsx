import * as React from "react";
import {
	PAGE_LOADER_BAR,
	PAGE_LOADER_BARS,
	PAGE_LOADER_ROW,
} from "../lib/page-loader-classes";
import { cn } from "./cn";

/**
 * The page loader: the launch screen's own wave, for a whole region that has
 * nothing in it yet.
 *
 * The app now has three loading marks, and they are not interchangeable — each
 * says a different thing, and the size of what is waiting picks between them:
 *
 *  - `PageLoader` (this) — a whole page, pane or region is empty and waiting.
 *    It is the five bars from the launch splash, unchanged, so the first thing
 *    a person sees when the app opens is the same thing they see when a page
 *    inside it has not arrived. A ring here is correct and anonymous; this is
 *    the same statement in the product's own handwriting.
 *  - `Spinner` (ui/spinner) — a small element is working: a button mid-save, a
 *    row refreshing, a control that is fetching. At that size the bars would be
 *    illegible, and a ring is the clearer shape.
 *  - `PixelSpinner` (components/PixelSpinner) — a MODEL is generating. Never
 *    reach for it to mean "fetching": worn on a slow request it says an agent
 *    is working on something nobody asked for.
 *
 * Colour comes from `currentColor`, so the caller's text class sets it.
 */
export function PageLoader({
	className,
	...props
}: React.ComponentPropsWithoutRef<"span">) {
	return (
		<span aria-hidden className={cn(PAGE_LOADER_ROW, className)} {...props}>
			{PAGE_LOADER_BARS.map((bar) => (
				<span key={bar} className={cn(PAGE_LOADER_BAR, bar)} />
			))}
		</span>
	);
}
