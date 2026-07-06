import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { cn } from "./cn";
import { IconX } from "../components/icons";

/**
 * Centered modal dialog on Base UI parts, styled with Tailwind tokens. The
 * shared standard for confirm/edit dialogs — mirrors tella-fusion's UI__Dialog2
 * (soft squircle shell, icon + title/description header, top-right close, a
 * body, and a right-aligned footer of actions).
 *
 * Like ui/menu.tsx (and unlike ui/tooltip.tsx) this animates with CSS
 * transitions on Base UI's [data-starting-style]/[data-ending-style] lifecycle
 * attributes — never a Motion render prop, which drops the injected role/data-*
 * a focus-managed dialog needs. Enter AND exit both animate; keyboard nav +
 * focus trapping stay intact.
 *
 * Composable: assemble <Modal.Root>/<Modal.Content> yourself, or reach for the
 * <Modal.Header>/<Modal.Footer> helpers for the common shape.
 *
 *   <Modal.Root open={open} onOpenChange={setOpen}>
 *     <Modal.Content>
 *       <Modal.Header icon={<IconCrosshair />} title="Session goal"
 *         description="Rides along with every prompt." />
 *       <textarea … />
 *       <Modal.Footer>
 *         <Modal.Close render={<button className="…">Cancel</button>} />
 *         <button className="…">Set goal</button>
 *       </Modal.Footer>
 *     </Modal.Content>
 *   </Modal.Root>
 */

/** Portal + backdrop + centered, squircle-cornered popup. Children are the
 *  dialog body; pair with Modal.Header / Modal.Footer for the standard shape.
 *  (Backdrop-dismiss is on by default; pass `dismissible={false}` to Modal.Root
 *  for confirmations that demand an explicit choice.) */
function Content({
	className,
	children,
	/** Max content width (Tailwind width utility). Defaults to a comfortable
	 *  ~30rem — override with e.g. "max-w-[34rem]" for roomier forms. */
	widthClassName = "max-w-[30rem]",
	initialFocus,
}: {
	className?: string;
	children: React.ReactNode;
	widthClassName?: string;
	/** Element to focus when the dialog opens (Base UI otherwise focuses the
	 *  first tabbable). Pass the ref of the field you want the caret in. */
	initialFocus?: React.RefObject<HTMLElement | null>;
}) {
	return (
		<BaseDialog.Portal>
			<BaseDialog.Backdrop
				className={cn(
					"fixed inset-0 z-[10000] bg-black/45 backdrop-blur-[1px]",
					"transition-opacity duration-150 ease-out",
					"data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
				)}
			/>
			<BaseDialog.Popup
				// Centered via a single composed transform so the enter/exit
				// scale (Tailwind writes translate + scale into one transform) keeps
				// the dialog pinned to the middle while it pops.
				className={cn(
					"fixed left-1/2 top-1/2 z-[10001] w-[92vw] -translate-x-1/2 -translate-y-1/2",
					widthClassName,
					"max-h-[85vh] overflow-y-auto overscroll-contain outline-none",
					// Soft squircle shell — rounder than the menu/popover 14px since a
					// large surface reads flatter at the same radius.
					"rounded-[22px] [corner-shape:squircle] border border-line-strong bg-raised",
					"p-7 shadow-[0_24px_70px_rgba(0,0,0,0.45)]",
					"flex flex-col gap-4",
					"origin-center transition-[transform,opacity] duration-150 ease-out",
					"data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0",
					"data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
					className,
				)}
				initialFocus={initialFocus}
			>
				{children}
			</BaseDialog.Popup>
		</BaseDialog.Portal>
	);
}

/** Icon badge + title + one-line description on the left, a close (✕) on the
 *  right — the standard dialog header. */
function Header({
	icon,
	title,
	description,
	className,
}: {
	icon?: React.ReactNode;
	title: React.ReactNode;
	description?: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex items-start gap-3.5", className)}>
			{icon && (
				<span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
					{icon}
				</span>
			)}
			<div className="min-w-0 flex-1">
				{/* Base UI renders Title as <h2> and Description as <p>; preflight
				    isn't imported (global.css owns resets), so zero their UA margins
				    or the <h2> top margin reads as phantom padding above the head. */}
				<BaseDialog.Title className="m-0 text-[19px] font-semibold text-fg">
					{title}
				</BaseDialog.Title>
				{description && (
					<BaseDialog.Description className="m-0 mt-1 text-[13.5px] leading-snug text-dim">
						{description}
					</BaseDialog.Description>
				)}
			</div>
			<BaseDialog.Close
				aria-label="Close"
				className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-faint outline-none transition-colors hover:text-fg"
			>
				<IconX size={18} />
			</BaseDialog.Close>
		</div>
	);
}

/** Right-aligned action row (Cancel / confirm). Pass a leading element (e.g. a
 *  destructive "Clear") and it sits left of the spacer. */
function Footer({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("mt-1 flex items-center gap-2.5", className)}>
			{children}
		</div>
	);
}

export const Modal = {
	Root: BaseDialog.Root,
	Trigger: BaseDialog.Trigger,
	Close: BaseDialog.Close,
	Title: BaseDialog.Title,
	Description: BaseDialog.Description,
	Content,
	Header,
	Footer,
};
