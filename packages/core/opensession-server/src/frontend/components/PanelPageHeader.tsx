import type { ReactNode } from "react";
import { IconChevronLeft } from "./icons";

/**
 * The header of a page one level deeper than the workspace panel's overview:
 * back chevron, the page's name, and whatever the page wants to report about
 * itself on the right (a live count, a diff total).
 *
 * It is sticky because the pages behind it are not all short. Portals fits on
 * a screen; a diff does not, and a back chevron you have to scroll up to reach
 * is a page you feel stuck on. `bg-panel-surface` is PANEL_SHELL's own fill,
 * so the row stays opaque over whatever scrolls under it.
 *
 * z-3 sits above DiffPanel's own sticky bars (z-2 for the repo tabs, z-1 for
 * the summary line), which stick to the same scroll container and would
 * otherwise ride over this one on the way past.
 */
export function PanelPageHeader({
	title,
	onBack,
	trailing,
}: {
	title: string;
	onBack: () => void;
	trailing?: ReactNode;
}) {
	return (
		<div className="sticky top-0 z-3 flex items-center gap-1 bg-panel-surface px-2 pt-3 pb-2">
			<button
				type="button"
				onClick={onBack}
				aria-label="Back to workspace"
				className="focus-ring inline-flex size-7 shrink-0 items-center justify-center rounded-control text-dim transition-colors hover:bg-hover hover:text-fg"
			>
				<IconChevronLeft size={16} />
			</button>
			<span className="min-w-0 flex-1 truncate text-supporting font-semibold text-fg">
				{title}
			</span>
			{trailing}
		</div>
	);
}
