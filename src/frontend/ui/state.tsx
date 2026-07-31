import * as React from "react";
import { IconX } from "../components/icons";
import { PixelSpinner } from "../components/PixelSpinner";
import { cn } from "./cn";

/**
 * Async-state primitives — one language for "nothing here yet", "fetching"
 * and "that went wrong".
 *
 * These three states were saying the same thing four different ways: the
 * `.loading`/`.empty` classes (centred, faint, 40px of air), one-off inline
 * divs (`px-4 py-3 text-dim text-supporting`), the `.form-error` box, and
 * bespoke bordered panels. Same meaning, four appearances — so a surface
 * looked different depending on which one its author reached for.
 *
 * The shapes are unchanged; what's shared now is the vocabulary:
 *
 *  - `placement` decides the frame, not the meaning. A state that stands in
 *    for a whole region gets air and centring (`block`); one standing in for
 *    a card draws that card's surface (`card`); one living *inside* a card's
 *    row list just takes the row's padding and stays left-aligned (`row`), so
 *    it lines up with the rows it replaces instead of floating in the middle.
 *  - loading is the quietest register (faint label + the house PixelSpinner),
 *    empty sits one step up (dim, with an optional title/icon/action when
 *    there's something to *do* about it), and alerts are the only state that
 *    gets a surface and a hue.
 *
 * `ui/notice.tsx` (ErrorNotice + its own LoadingState) is the earlier, partial
 * take on this; prefer these.
 */

/** Where the state sits — decides padding, alignment and whether it draws its
 * own surface. Never the meaning: the same state reads the same everywhere. */
export type StatePlacement = "block" | "card" | "row";

const placements: Record<StatePlacement, string> = {
	// Stands in for a whole region: the `.loading`/`.empty` look (40px of air,
	// centred) so it reads as "this area is empty", not "this row is".
	block: "flex flex-col items-center justify-center gap-2 py-10 text-center",
	// Stands in for a card: borrows SettingCard's surface so the page's rhythm
	// survives the emptiness.
	card: "rounded-lg bg-raised px-4 py-3",
	// Lives inside a card's row list: matches SettingRow's padding so it lands
	// on the same left edge as the rows it replaces.
	row: "px-4 py-3",
};

export function EmptyState({
	icon,
	title,
	action,
	placement = "block",
	className,
	children,
	...props
}: Omit<React.ComponentPropsWithoutRef<"div">, "title"> & {
	/** 22px glyph from components/icons.tsx. Block placement only — in a row
	 *  or card it would out-weigh the sentence beside it. */
	icon?: React.ReactNode;
	title?: React.ReactNode;
	/** Usually a <Button size="sm">: the one thing that fills the emptiness. */
	action?: React.ReactNode;
	placement?: StatePlacement;
}) {
	const block = placement === "block";
	return (
		<div className={cn(placements[placement], className)} {...props}>
			{block && icon && <span className="text-faint">{icon}</span>}
			{title && <div className="text-control-label font-medium text-fg">{title}</div>}
			{children && (
				<div className={cn("text-supporting leading-snug text-dim", block && "max-w-[46ch]")}>
					{children}
				</div>
			)}
			{action && <div className={cn(block ? "mt-1" : "mt-2")}>{action}</div>}
		</div>
	);
}

export function LoadingState({
	placement = "block",
	spinner = true,
	className,
	children,
	...props
}: React.ComponentPropsWithoutRef<"div"> & {
	placement?: StatePlacement;
	spinner?: boolean;
}) {
	return (
		<div
			role="status"
			aria-live="polite"
			className={cn(placements[placement], className)}
			{...props}
		>
			{/* div, not span: PixelSpinner renders a grid div. */}
			<div className="inline-flex items-center gap-2 text-supporting text-faint">
				{spinner && <PixelSpinner className="shrink-0" />}
				{children}
			</div>
		</div>
	);
}

type AlertVariant = "error" | "warn" | "info";

// Border at 40% of the hue over its soft fill — the `.form-error` recipe,
// generalised. (There is no --yellow-soft, hence the mix.)
const alertVariants: Record<AlertVariant, string> = {
	error: "border-[color-mix(in_srgb,var(--red)_40%,transparent)] bg-red-soft text-red",
	warn: "border-[color-mix(in_srgb,var(--yellow)_40%,transparent)] bg-[color-mix(in_srgb,var(--yellow)_12%,transparent)] text-yellow",
	info: "border-[color-mix(in_srgb,var(--blue)_40%,transparent)] bg-blue-soft text-blue",
};

export function InlineAlert({
	variant = "error",
	title,
	onDismiss,
	onRetry,
	retryLabel = "Try again",
	className,
	children,
	onClick,
	...props
}: Omit<React.ComponentPropsWithoutRef<"div">, "title"> & {
	variant?: AlertVariant;
	title?: React.ReactNode;
	/** Renders a × and, preserving how these boxes have always behaved, makes
	 *  the whole box dismiss on click — the × is what makes that discoverable
	 *  and reachable from the keyboard. */
	onDismiss?: () => void;
	onRetry?: () => void;
	retryLabel?: string;
}) {
	return (
		<div
			role="alert"
			className={cn(
				"flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm",
				alertVariants[variant],
				onDismiss && "cursor-pointer",
				className,
			)}
			onClick={(e) => {
				onClick?.(e);
				onDismiss?.();
			}}
			{...props}
		>
			<div className="min-w-0 flex-1">
				{title && <div className="font-medium">{title}</div>}
				<div className={cn("min-w-0", title && "mt-0.5 opacity-90")}>{children}</div>
			</div>
			{onRetry && (
				<button
					type="button"
					className="focus-ring shrink-0 self-center whitespace-nowrap text-supporting font-medium underline underline-offset-2 opacity-80 transition-opacity hover:opacity-100"
					onClick={(e) => {
						e.stopPropagation();
						onRetry();
					}}
				>
					{retryLabel}
				</button>
			)}
			{onDismiss && (
				<button
					type="button"
					aria-label="Dismiss"
					// Visually 24px so it sits inside the box's 10px padding; the
					// pseudo-element takes the hit area out to 40px.
					className="focus-ring relative -mr-1 flex size-6 shrink-0 items-center justify-center rounded-control opacity-60 transition-opacity hover:opacity-100 before:absolute before:-inset-2 before:content-['']"
					onClick={(e) => {
						e.stopPropagation();
						onDismiss();
					}}
				>
					<IconX size={20} />
				</button>
			)}
		</div>
	);
}
