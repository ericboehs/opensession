import { useRef, useState } from "react";
import { PANEL_RESIZE } from "../lib/session-panel-classes";
import { suppressLayoutAnimations } from "../ui/motion";

/**
 * The right side panel's open state and width, shared by every surface that
 * shows one — the session viewer and the session-less workspace route.
 *
 * Both live in localStorage rather than in a session or workspace record, so
 * the panel is one browser-level preference: opening it in a session leaves it
 * open when you land on a workspace with no session yet, and a drag on either
 * resizes both. That sameness is the point — the panel is the same column in
 * the same place, whatever is in the pane beside it.
 *
 * Width is written to `--panel-w`, which PANEL_SHELL reads; 0 means "no stored
 * width", leaving the shell's own default. The handle drags from the panel's
 * LEFT edge, so the width it computes is the pointer's distance from the
 * container's right side.
 */
const OPEN_KEY = "opensession-panel-open";
const WIDTH_KEY = "opensession-panel-w";
/** Below this the panel stops being a column and overlays the pane, so it
    starts closed rather than covering a screen that has no room for both. */
const COLUMN_MIN_WIDTH = 920;
const MIN_W = 320;
const MAX_W = 2400;

export interface SidePanel {
	open: boolean;
	setOpen: (open: boolean) => void;
	/** `--panel-w` for PANEL_SHELL; undefined while no width is stored. */
	style: React.CSSProperties | undefined;
	/** The panel's left-edge drag handle — render it inside PANEL_SHELL. */
	resizeHandle: React.ReactNode;
}

export function useSidePanel(): SidePanel {
	const [open, setOpenState] = useState(() => {
		const stored = localStorage.getItem(OPEN_KEY);
		if (stored !== null)
			return stored === "true" && window.innerWidth > COLUMN_MIN_WIDTH;
		return window.innerWidth > COLUMN_MIN_WIDTH;
	});
	function setOpen(next: boolean) {
		setOpenState(next);
		localStorage.setItem(OPEN_KEY, String(next));
	}

	const [width, setWidth] = useState<number>(() => {
		const stored = Number(localStorage.getItem(WIDTH_KEY));
		return stored >= MIN_W && stored <= MAX_W ? stored : 0;
	});
	const widthRef = useRef(width);
	widthRef.current = width;

	function startResize(e: React.MouseEvent) {
		e.preventDefault();
		const right =
			(
				e.currentTarget.parentElement as HTMLElement | null
			)?.getBoundingClientRect().right ?? window.innerWidth;
		document.body.classList.add("resizing-panel");
		// Snap Motion layout morphs while dragging — the composer re-measures on
		// every step, so springing it reads as funky text (mirrors the sidebar).
		const restoreMotion = suppressLayoutAnimations();
		const onMove = (ev: MouseEvent) => {
			// Wide enough to review code side-by-side: only reserve room for the
			// left sidebar + a readable session column instead of a fixed cap.
			const max = Math.max(480, Math.round(window.innerWidth - 620));
			const next = Math.min(max, Math.max(MIN_W, Math.round(right - ev.clientX)));
			widthRef.current = next;
			setWidth(next);
		};
		const onUp = () => {
			document.body.classList.remove("resizing-panel");
			restoreMotion();
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			localStorage.setItem(WIDTH_KEY, String(Math.round(widthRef.current)));
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}

	return {
		open,
		setOpen,
		style: width
			? ({ "--panel-w": `${width}px` } as React.CSSProperties)
			: undefined,
		resizeHandle: (
			<div className={PANEL_RESIZE} onMouseDown={startResize} aria-hidden="true" />
		),
	};
}
