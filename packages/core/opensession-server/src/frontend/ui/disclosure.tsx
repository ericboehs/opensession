import * as React from "react";
import { IconChevronRight } from "../components/icons";
import { cn } from "./cn";
import { Collapsible, collapsiblePanelClasses } from "./collapsible";

/**
 * Disclosure — a titled block that opens and closes in place.
 *
 * For reference material that a surface should offer without spending its
 * first screen on: a provider's setup recipe, a generated config snippet, the
 * long tail of options behind a form. The closed state is one quiet row, so
 * the thing the person actually came to do stays above the fold.
 *
 * Built on Base UI's Collapsible rather than a raw `<details>`: the panel's
 * height is measured, so the block animates open instead of snapping, and the
 * trigger keeps its aria-expanded/aria-controls wiring. Reduced motion is
 * handled globally in base.css, which flattens the transition to ~0ms.
 *
 * `actions` sits BESIDE the trigger, never inside it. A disclosure's shoulder
 * usually carries a link out to whatever it documents, and an `<a>` nested in
 * a `<button>` is neither valid nor clickable.
 */
export function Disclosure({
	title,
	actions,
	defaultOpen,
	className,
	panelClassName,
	children,
}: {
	title: React.ReactNode;
	/** Rendered on the trigger's right, outside its hit area. */
	actions?: React.ReactNode;
	defaultOpen?: boolean;
	className?: string;
	panelClassName?: string;
	children: React.ReactNode;
}) {
	return (
		<Collapsible.Root defaultOpen={defaultOpen} className={cn("min-w-0", className)}>
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
				{/* -mx-2 lets the row's hover wash bleed past the text without
				    indenting the title away from the content it labels. */}
				<Collapsible.Trigger className="focus-ring group -mx-2 flex min-w-0 items-center gap-1.5 rounded-control px-2 py-1 text-label font-semibold text-fg transition-colors hover:bg-hover">
					<IconChevronRight
						size={14}
						className="shrink-0 text-faint transition-transform duration-[var(--dur-micro)] ease-[var(--ease)] group-data-[panel-open]:rotate-90"
					/>
					<span className="min-w-0 truncate">{title}</span>
				</Collapsible.Trigger>
				{actions}
			</div>
			<Collapsible.Panel className={cn(collapsiblePanelClasses, panelClassName)}>
				<div className="pt-3">{children}</div>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
