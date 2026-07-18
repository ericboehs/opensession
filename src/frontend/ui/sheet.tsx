import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

/**
 * iOS-style bottom sheet for phone surfaces (the account menu, Settings). Not
 * a Base UI wrapper: the popups it replaces already own their open state and
 * a route can drive it, so this is a plain portal that animates itself in on
 * mount and back out before telling the owner to unmount it.
 *
 * Dismissal (backdrop tap, Esc, dragging the grabber down, or a child calling
 * the render-prop `dismiss`) always plays the exit slide first, then fires
 * `onClose` — so owners just unmount on close and never manage animation.
 */
export function BottomSheet({
	onClose,
	label,
	className,
	children,
}: {
	/** Called after the exit animation — unmount the sheet here. */
	onClose: () => void;
	/** Accessible dialog label. */
	label: string;
	/** Extra classes for the sheet panel (e.g. a fixed height). */
	className?: string;
	children: React.ReactNode | ((dismiss: () => void) => React.ReactNode);
}) {
	// Mount hidden below the viewport, then slide in on the next frame.
	const [shown, setShown] = React.useState(false);
	const closingRef = React.useRef(false);
	const sheetRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		const raf = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(raf);
	}, []);

	const dismiss = React.useCallback(() => {
		if (closingRef.current) return;
		closingRef.current = true;
		setShown(false);
		setTimeout(onClose, 300);
	}, [onClose]);

	// Esc dismisses. Capture phase so it wins over page-level Esc handlers
	// (the app's palette/back handlers) while the sheet is up.
	React.useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				dismiss();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [dismiss]);

	// Drag the grabber down to dismiss: the sheet follows the finger (transition
	// suspended), and a decent pull flicks it away on release.
	const drag = React.useRef<{ startY: number; dy: number } | null>(null);
	function onTouchStart(e: React.TouchEvent) {
		drag.current = { startY: e.touches[0].clientY, dy: 0 };
		if (sheetRef.current) sheetRef.current.style.transition = "none";
	}
	function onTouchMove(e: React.TouchEvent) {
		if (!drag.current) return;
		const dy = Math.max(0, e.touches[0].clientY - drag.current.startY);
		drag.current.dy = dy;
		if (sheetRef.current)
			sheetRef.current.style.transform = `translateY(${dy}px)`;
	}
	function onTouchEnd() {
		const dy = drag.current?.dy ?? 0;
		drag.current = null;
		const el = sheetRef.current;
		if (el) {
			el.style.transition = "";
			el.style.transform = "";
		}
		if (dy > 80) dismiss();
	}

	return createPortal(
		<div
			className="fixed inset-0 z-[10000]"
			role="dialog"
			aria-modal="true"
			aria-label={label}
		>
			<div
				className={cn(
					"absolute inset-0 bg-black/45 transition-opacity duration-300",
					shown ? "opacity-100" : "opacity-0",
				)}
				onClick={dismiss}
			/>
			<div
				ref={sheetRef}
				className={cn(
					"absolute inset-x-0 bottom-0 flex max-h-[94dvh] flex-col overflow-hidden rounded-t-[22px] [corner-shape:squircle] bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-12px_40px_rgba(0,0,0,0.35)]",
					"transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
					shown ? "translate-y-0" : "translate-y-full",
					className,
				)}
			>
				<div
					className="flex shrink-0 touch-none justify-center pb-1.5 pt-2.5"
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
				>
					<div className="h-[5px] w-9 rounded-full bg-active" />
				</div>
				{typeof children === "function" ? children(dismiss) : children}
			</div>
		</div>,
		document.body,
	);
}
