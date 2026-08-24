import { useEffect, useRef, useState } from "react";
import { PANEL_RESIZE } from "../lib/session-panel-classes";
import {
	SIDE_PANEL_OPEN_KEY,
	sidePanelOpen,
	storeSidePanelOpen,
} from "../lib/side-panel-open";
import { suppressLayoutAnimations } from "../ui/motion";

/**
 * The right side panel's open state and width, shared by every surface that
 * shows one: the session viewer and the session-less workspace route.
 *
 * Open state is a browser-wide view choice. The summary card is the default;
 * once the person opens the panel, it stays open as they move between
 * workspaces or reload. A window event keeps simultaneous panel hosts in sync,
 * while the storage event does the same across tabs.
 *
 * Width also remains in localStorage. The handle drags from the panel's left
 * edge, so its width is the pointer's distance from the container's right side.
 */
const OPEN_CHANGE_EVENT = "opensession-panel-open-changed";
const WIDTH_KEY = "opensession-panel-w";
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
	const [open, setOpenState] = useState(sidePanelOpen);
	useEffect(() => {
		const syncOpen = (event: Event) => {
			if (!(event instanceof CustomEvent) || typeof event.detail !== "boolean")
				return;
			setOpenState(event.detail);
		};
		const syncStorage = (event: StorageEvent) => {
			if (event.key === SIDE_PANEL_OPEN_KEY) setOpenState(sidePanelOpen());
		};
		window.addEventListener(OPEN_CHANGE_EVENT, syncOpen);
		window.addEventListener("storage", syncStorage);
		return () => {
			window.removeEventListener(OPEN_CHANGE_EVENT, syncOpen);
			window.removeEventListener("storage", syncStorage);
		};
	}, []);
	function setOpen(next: boolean) {
		setOpenState(next);
		storeSidePanelOpen(next);
		window.dispatchEvent(new CustomEvent(OPEN_CHANGE_EVENT, { detail: next }));
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
