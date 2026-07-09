import { IconChevronLeft, IconChevronRight } from "./icons";
import { Tooltip } from "../ui/tooltip";

/**
 * Desktop PWA titlebar for Window Controls Overlay mode.
 *
 * When the app runs as an installed desktop PWA with
 * `display_override: window-controls-overlay`, the OS titlebar collapses to
 * just the window-control buttons overlaid on our own content — which also
 * takes the browser's back/forward buttons with it. This strip fills that
 * reclaimed band: it's a drag region (so the window still moves) and carries
 * in-app back/forward wired to the same history the router drives (pushState /
 * popstate). Rendered always but `display:none` outside WCO — the visibility +
 * the traffic-light inset live in the `(display-mode: window-controls-overlay)`
 * block in global.css.
 */
export function TitleBar() {
	return (
		<div className="wco-titlebar">
			<div className="wco-titlebar-nav">
				<Tooltip label="Back" side="bottom">
					<button
						className="wco-nav-btn"
						onClick={() => history.back()}
						aria-label="Back"
					>
						<IconChevronLeft size={20} />
					</button>
				</Tooltip>
				<Tooltip label="Forward" side="bottom">
					<button
						className="wco-nav-btn"
						onClick={() => history.forward()}
						aria-label="Forward"
					>
						<IconChevronRight size={20} />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}
