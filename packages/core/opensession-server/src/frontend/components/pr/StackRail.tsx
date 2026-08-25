import { cn } from "../../ui/cn";

/**
 * The rail a stack is drawn on: a node per layer, threaded by a vertical line,
 * top layer first with the trunk as the last node — the way github.com draws a
 * stack.
 *
 * Kept separate from the popover's row composition so the state glyphs and
 * line geometry remain one focused piece.
 */

/** A node on the rail: the layer's state, as a ring rather than a filled dot —
 *  filled circles read as check results, and these are places in a chain. */
export function StackNode({
	state,
	isDraft,
}: {
	state?: string;
	isDraft?: boolean;
}) {
	if (state === "MERGED")
		return (
			<svg className="block size-4 text-purple" viewBox="0 0 16 16" aria-hidden>
				<circle cx="8" cy="8" r="7" fill="currentColor" />
				<path
					d="M4.6 8.2l2.2 2.2 4.6-4.6"
					fill="none"
					stroke="var(--bg-panel)"
					strokeWidth="1.7"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		);
	if (state === "CLOSED")
		return (
			<svg className="block size-4 text-red" viewBox="0 0 16 16" aria-hidden>
				<circle
					cx="8"
					cy="8"
					r="7"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
				/>
				<path
					d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
				/>
			</svg>
		);
	// A draft can't merge, so it gets no check — and neither does the trunk,
	// which is a destination rather than a layer.
	if (isDraft || !state)
		return (
			<svg className="block size-4 text-faint" viewBox="0 0 16 16" aria-hidden>
				<circle
					cx="8"
					cy="8"
					r="7"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
				/>
			</svg>
		);
	return (
		<svg className="block size-4 text-green" viewBox="0 0 16 16" aria-hidden>
			<circle
				cx="8"
				cy="8"
				r="7"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			/>
			<path
				d="M4.9 8.2l2.1 2.1 4.2-4.2"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/**
 * The vertical line through the nodes, drawn as a segment above and below each
 * one so it breaks cleanly around the glyph instead of running behind it (a
 * node punched through with its own background can't sit on a row that changes
 * colour on hover).
 *
 * The rail is a 22px slot, matching the sidebar's leading column, so a stack
 * row's title lands on the same rhythm as other railed rows in the app.
 */
export function StackRail({
	first,
	last,
	children,
}: {
	first?: boolean;
	last?: boolean;
	children: React.ReactNode;
}) {
	return (
		<span className="flex w-[22px] shrink-0 flex-col items-center self-stretch">
			<span className={cn("w-px flex-1 bg-line", first && "invisible")} />
			<span className="my-[3px] shrink-0">{children}</span>
			<span className={cn("w-px flex-1 bg-line", last && "invisible")} />
		</span>
	);
}
