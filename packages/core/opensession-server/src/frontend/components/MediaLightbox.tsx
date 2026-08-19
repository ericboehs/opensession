import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type WorkspaceMediaItem } from "../lib/api";
import {
	type DiagramMedia,
	diagramDataUrl,
	readDiagramSvg,
} from "../lib/diagram-media";
import {
	canUseNativeIOSShare,
	nativeShareWasCancelled,
	saveFileWithNativeShare,
	shareURL,
} from "../lib/native-file-save";
import { copyToClipboard } from "../lib/share-link";
import { fullTime } from "../lib/time";
import {
	WALKTHROUGH_LABEL_CLASS,
	WALKTHROUGH_LABEL_TEXT,
	WALKTHROUGH_LABEL_TONE,
	type WalkthroughMediaLabel,
} from "../lib/walkthrough-label";
import { cn } from "../ui/cn";
import { toast } from "../ui/toast";
import {
	IconArrowDown,
	IconArrowUpRight,
	IconCheck,
	IconChevronLeft,
	IconChevronRight,
	IconLink,
	IconX,
} from "./icons";

/**
 * Full-screen lightbox for all in-app media: workspace-media thumbnails (the
 * sidebar hover card, the mobile sheet, and the WorkspaceInfo panel) and any
 * session media (markdown images, pasted-image attachments, tool-result
 * screenshots and recordings), with prev/next browsing instead of jumping to
 * the raw file in a new tab — which for data:/blob URLs browsers block,
 * leaving an empty window.
 *
 * Images are zoomable: pinch on touch (iOS PWA included — pointer events +
 * touch-action:none, no native gesture dependence), double-tap/double-click
 * to toggle, wheel/trackpad on desktop, one-finger pan while zoomed.
 *
 * Global singleton: the thumbnails live inside transient popovers — the
 * hover card unmounts on mouseleave/scroll — so the modal is hosted once in
 * App and opened imperatively via openLightbox(), surviving its opener.
 * Session media is wired through a delegated capture-phase click listener here
 * (rather than per-component onClicks) because markdown images are injected
 * via dangerouslySetInnerHTML and can't carry React handlers.
 */

export interface LightboxItem {
	kind: "image" | "video" | "diagram";
	src: string;
	/** kind "diagram" only: the live SVG to draw, so that zooming a chart to
	 * read its labels keeps them sharp instead of magnifying pixels. `src` is
	 * the same diagram as a file, which is all Download needs — and being a
	 * data: URL, it also opts the link actions out (see below). */
	diagram?: DiagramMedia;
	walkthroughLabel?: WalkthroughMediaLabel;
	sessionTitle?: string;
	description?: string;
	at?: string;
}

interface LightboxState {
	items: LightboxItem[];
	index: number;
	id: number;
	origin?: HTMLElement;
	originIndex: number;
	useHeroTransition: boolean;
}

interface LightboxRequest {
	items: LightboxItem[];
	index: number;
	origin?: HTMLElement;
}

interface ViewTransitionHandle {
	finished: Promise<void>;
	skipTransition(): void;
}

/** `focusVisible` is honoured by Chromium/Firefox but not yet in TypeScript's
 * DOM lib; browsers without it just fall back to their own heuristic. */
type FocusOptionsWithVisible = FocusOptions & { focusVisible?: boolean };

type ViewTransitionDocument = Document & {
	startViewTransition?: (update: () => void) => ViewTransitionHandle;
};

const HERO_TRANSITION_NAME = "lightbox-media";
let nextLightboxId = 0;
let host: ((request: LightboxRequest) => void) | null = null;

const LIGHTBOX_TRANSITION_CSS = `
html[data-lightbox-transition="opening"]::view-transition-old(root),
html[data-lightbox-transition="closing"]::view-transition-new(root) {
  animation: none;
}

html[data-lightbox-transition="opening"]::view-transition-new(root) {
  animation: lightbox-root-in var(--dur) var(--ease) both;
}

/* Exit is a tier faster than the enter: opening is the deliberate act and can
   take its time, closing is the system getting out of the way. */
html[data-lightbox-transition="closing"]::view-transition-old(root) {
  animation: lightbox-root-out var(--dur-micro) var(--ease) both;
}

::view-transition-group(${HERO_TRANSITION_NAME}) {
  z-index: 11001;
  animation-duration: var(--dur-lg);
  animation-timing-function: var(--ease);
}

::view-transition-old(${HERO_TRANSITION_NAME}),
::view-transition-new(${HERO_TRANSITION_NAME}) {
  mix-blend-mode: normal;
}

@keyframes lightbox-root-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes lightbox-root-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
`;

function mediaElement(origin?: Element | null): HTMLElement | undefined {
	if (!(origin instanceof HTMLElement)) return undefined;
	if (origin.matches("img, video")) return origin;
	return origin.querySelector<HTMLElement>("img, video") || origin;
}

function canMorphFrom(origin?: HTMLElement): origin is HTMLElement {
	if (!origin?.isConnected) return false;
	const rect = origin.getBoundingClientRect();
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		rect.right > 0 &&
		rect.bottom > 0 &&
		rect.left < window.innerWidth &&
		rect.top < window.innerHeight
	);
}

function setTransitionName(element: HTMLElement, name: string): () => void {
	const previous = element.style.viewTransitionName;
	let restored = false;
	element.style.viewTransitionName = name;
	return () => {
		if (restored) return;
		restored = true;
		element.style.viewTransitionName = previous;
	};
}

function markTransition(phase: "opening" | "closing", id: number): () => void {
	const root = document.documentElement;
	const token = String(id);
	root.dataset.lightboxTransition = phase;
	root.dataset.lightboxTransitionId = token;
	return () => {
		if (root.dataset.lightboxTransitionId !== token) return;
		delete root.dataset.lightboxTransition;
		delete root.dataset.lightboxTransitionId;
	};
}

function supportsHeroTransition(): boolean {
	return (
		typeof (document as ViewTransitionDocument).startViewTransition === "function" &&
		!window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

export function openLightbox(
	items: (LightboxItem | WorkspaceMediaItem)[],
	index: number,
	origin?: Element | null,
) {
	host?.({ items, index, origin: mediaElement(origin) });
}

/** Every piece of session media currently in the DOM, in document order —
 * markdown images/videos, pasted attachments, tool-result screenshots. */
const GALLERY_SELECTOR = "img.md-image, video.md-video, .md-mermaid > svg";

/** One node as an item, or null when it cannot be shown: a diagram whose
 * markup never says how big it is has nothing to letterbox. */
function galleryItem(node: Element): LightboxItem | null {
	if (node.tagName === "IMG" || node.tagName === "VIDEO") {
		return {
			kind: node.tagName === "VIDEO" ? "video" : "image",
			src: (node as HTMLImageElement | HTMLVideoElement).src,
			// Markdown alt text is the only description these carry; captioning the
			// viewer with it beats a bare counter once you are paging through a
			// dozen screenshots.
			sessionTitle: (node as HTMLImageElement).alt?.trim() || undefined,
		};
	}
	const diagram = readDiagramSvg(node.outerHTML);
	return diagram
		? { kind: "diagram", src: diagramDataUrl(diagram.svg), diagram }
		: null;
}

/** Open the lightbox on `el`, with prev/next browsing across all session media
 * currently on screen (a conversation-wide gallery). */
export function openGalleryFrom(el: Element) {
	const shown = Array.from(document.querySelectorAll(GALLERY_SELECTOR)).flatMap(
		(node) => {
			const item = galleryItem(node);
			return item ? [{ node, item }] : [];
		},
	);
	if (shown.length === 0) return;
	openLightbox(
		shown.map((entry) => entry.item),
		Math.max(
			0,
			shown.findIndex((entry) => entry.node === el),
		),
		el,
	);
}

/** The diagram a click is about: anywhere on the rendered chart, or the expand
 * button beside it (which is also what Enter and Space on that button
 * dispatch). Diagram labels are real text, so a click that ends a selection is
 * someone copying a node name, not asking for a viewer — the button stays
 * unambiguous either way. */
function diagramFor(target: Element): Element | null {
	const svg = target
		.closest?.(".md-mermaid-wrap")
		?.querySelector(".md-mermaid > svg");
	if (!svg) return null;
	if (target.closest?.("button.md-diagram-expand")) return svg;
	const selection = window.getSelection();
	const selecting =
		selection &&
		!selection.isCollapsed &&
		selection.anchorNode &&
		svg.contains(selection.anchorNode);
	return selecting ? null : svg;
}

export function MediaLightboxHost() {
	const [state, setState] = useState<LightboxState | null>(null);
	const activeTransition = useRef<ViewTransitionHandle | null>(null);
	const activeSourceCleanup = useRef<(() => void) | null>(null);
	useEffect(() => {
		const open = (request: LightboxRequest) => {
			const id = ++nextLightboxId;
			const origin = mediaElement(request.origin);
			const next: LightboxState = {
				...request,
				id,
				origin,
				originIndex: request.index,
				useHeroTransition: false,
			};
			const item = request.items[request.index];
			if (item?.kind !== "image" || !canMorphFrom(origin) || !supportsHeroTransition()) {
				setState(next);
				return;
			}

			activeTransition.current?.skipTransition();
			activeSourceCleanup.current?.();
			const restoreOrigin = setTransitionName(origin, HERO_TRANSITION_NAME);
			activeSourceCleanup.current = restoreOrigin;
			const clearTransitionMark = markTransition("opening", id);
			try {
				const transition = (document as ViewTransitionDocument).startViewTransition!(() => {
					// The source belongs only to the old snapshot. Removing its name before
					// React mounts the destination avoids duplicate named elements.
					restoreOrigin();
					if (activeSourceCleanup.current === restoreOrigin) {
						activeSourceCleanup.current = null;
					}
					flushSync(() => setState({ ...next, useHeroTransition: true }));
				});
				activeTransition.current = transition;
				const finish = () => {
					if (activeTransition.current === transition) activeTransition.current = null;
					clearTransitionMark();
				};
				void transition.finished.then(finish, finish);
			} catch {
				restoreOrigin();
				if (activeSourceCleanup.current === restoreOrigin) {
					activeSourceCleanup.current = null;
				}
				clearTransitionMark();
				setState(next);
			}
		};
		host = open;
		return () => {
			if (host === open) host = null;
			activeTransition.current?.skipTransition();
			activeSourceCleanup.current?.();
		};
	}, []);
	// Delegated capture-phase listener: intercept plain left-clicks on any
	// session image and open the gallery instead of following the wrapping
	// <a target="_blank"> (kept for cmd/middle-click open-in-tab). Videos are
	// not intercepted — clicks there drive the native controls.
	useEffect(() => {
		function onClick(e: MouseEvent) {
			if (
				e.defaultPrevented ||
				e.button !== 0 ||
				e.metaKey ||
				e.ctrlKey ||
				e.shiftKey ||
				e.altKey
			)
				return;
			const target = e.target as HTMLElement;
			// Enter on the focused link dispatches a click whose target is the
			// wrapping <a>, not the <img> inside it — match both, or keyboard
			// activation falls through to the raw file in a new tab.
			const media =
				target.closest?.("img.md-image") ||
				target.closest?.("a.md-image-link")?.querySelector("img.md-image") ||
				diagramFor(target);
			if (!media) return;
			e.preventDefault();
			e.stopPropagation();
			openGalleryFrom(media);
		}
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);

	function close(current: LightboxState, allowHeroTransition = true) {
		const item = current.items[current.index];
		const origin = current.origin;
		const canReturn =
			allowHeroTransition &&
			current.useHeroTransition &&
			current.index === current.originIndex &&
			item?.kind === "image" &&
			canMorphFrom(origin) &&
			supportsHeroTransition();

		if (!canReturn) {
			// Native transitions don't need Motion's lifecycle. If the source has
			// disappeared (for example, a hover card closed), opt back into the
			// fallback for one frame so the viewer still leaves gracefully.
			activeTransition.current?.skipTransition();
			activeTransition.current = null;
			activeSourceCleanup.current?.();
			activeSourceCleanup.current = null;
			if (document.documentElement.dataset.lightboxTransitionId === String(current.id)) {
				delete document.documentElement.dataset.lightboxTransition;
				delete document.documentElement.dataset.lightboxTransitionId;
			}
			setState({ ...current, useHeroTransition: false });
			requestAnimationFrame(() => {
				setState((latest) => (latest?.id === current.id ? null : latest));
			});
			return;
		}

		activeTransition.current?.skipTransition();
		activeSourceCleanup.current?.();
		activeSourceCleanup.current = null;
		const clearTransitionMark = markTransition("closing", current.id);
		let restoreOrigin: (() => void) | undefined;
		try {
			const transition = (document as ViewTransitionDocument).startViewTransition!(() => {
				// The target belongs only to the old snapshot; name the source after
				// that capture so it becomes the destination in the new snapshot.
				restoreOrigin = setTransitionName(origin, HERO_TRANSITION_NAME);
				activeSourceCleanup.current = restoreOrigin;
				flushSync(() => setState(null));
			});
			activeTransition.current = transition;
			const finish = () => {
				restoreOrigin?.();
				if (activeSourceCleanup.current === restoreOrigin) {
					activeSourceCleanup.current = null;
				}
				if (activeTransition.current === transition) activeTransition.current = null;
				clearTransitionMark();
			};
			void transition.finished.then(finish, finish);
		} catch {
			restoreOrigin?.();
			if (activeSourceCleanup.current === restoreOrigin) {
				activeSourceCleanup.current = null;
			}
			clearTransitionMark();
			setState(null);
		}
	}

	const lightbox = state ? (
		<MediaLightbox
			key={state.id}
			items={state.items}
			index={state.index}
			onIndex={(index) =>
				setState((latest) =>
					latest?.id === state.id ? { ...latest, index } : latest,
				)
			}
			onClose={(allowHeroTransition) => close(state, allowHeroTransition)}
			useHeroTransition={state.useHeroTransition}
			heroTransitionName={
				state.useHeroTransition && state.index === state.originIndex
					? HERO_TRANSITION_NAME
					: undefined
			}
		/>
	) : null;

	return (
		<>
			<style>{LIGHTBOX_TRANSITION_CSS}</style>
			{state?.useHeroTransition ? (
				lightbox
			) : (
				<AnimatePresence initial={false}>{lightbox}</AnimatePresence>
			)}
		</>
	);
}

function extFromMime(mime: string): string {
	const sub = mime.split("/")[1]?.split(";")[0] || "";
	const special: Record<string, string> = {
		jpeg: "jpg",
		"svg+xml": "svg",
		quicktime: "mov",
		"x-matroska": "mkv",
	};
	return special[sub] || sub || "bin";
}

function suggestedName(item: LightboxItem): string {
	if (!item.src.startsWith("data:") && !item.src.startsWith("blob:")) {
		try {
			const url = new URL(item.src, location.href);
			// The media route carries the real file in `?path=`, so its basename
			// is the name the file actually has — the route's own basename is
			// just "media".
			const from = url.searchParams.get("path") || url.pathname;
			const base = decodeURIComponent(from.split("/").pop() || "");
			if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
		} catch {}
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const mime = /^data:([^;,]+)/.exec(item.src)?.[1];
	const ext = mime ? extFromMime(mime) : item.kind === "video" ? "mp4" : "png";
	return `${item.kind}-${stamp}.${ext}`;
}

/**
 * Where Download points. It is a real link, not a fetch→blob→ObjectURL dance:
 * the blob route buffered whole videos in memory, lost the file's own name,
 * and on any failure fell back to window.open(), which a popup blocker eats
 * silently — leaving a Download button that does nothing. `?download=1` asks
 * our own routes for an attachment disposition, so the file saves instead of
 * opening in a tab. Do not also put the `download` attribute on server-backed
 * links: installed iOS PWAs route those through their preview controller
 * instead of the browser's attachment handling.
 */
function downloadHref(item: LightboxItem): string {
	if (item.src.startsWith("data:") || item.src.startsWith("blob:"))
		return item.src;
	try {
		const url = new URL(item.src, location.href);
		if (url.origin === location.origin) url.searchParams.set("download", "1");
		return url.href;
	} catch {
		return item.src;
	}
}

/** The item's own URL, absolute, for pasting somewhere outside the app. */
function shareableSrc(item: LightboxItem): string {
	try {
		return new URL(item.src, location.href).href;
	} catch {
		return item.src;
	}
}

const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;

/** Air between a diagram and its own edge, so the drawing is not flush against
 * the corner of the surface it sits on. */
const DIAGRAM_PADDING = 16;

/**
 * Pinch/pan/zoom surface for one image, or for one diagram — a mermaid chart
 * keeps its vector markup here rather than arriving as a picture, so the
 * labels stay sharp all the way up. The wrapper (not the letterboxed media)
 * owns the gesture so pinches starting beside the photo still work; transforms
 * are written straight to the media's style (no per-move re-render). A clean
 * tap on the backdrop area of the wrapper closes — unless it's the first half
 * of a double-tap on the media, which zooms instead.
 *
 * At the fit scale a horizontal drag pages to the neighbouring item instead:
 * the picture follows the finger and either carries on to the next one or
 * springs back, which is how every photo viewer on a phone behaves. It only
 * arms once the drag is decidedly horizontal, so a pinch or a vertical flick
 * never steals a page turn, and zoomed in the same drag pans the photo.
 */
function ZoomableMedia({
	src,
	diagram,
	onTapBackdrop,
	onZoomChange,
	onSwipe,
	enterFrom = 0,
	viewTransitionName,
}: {
	src: string;
	/** Present for a diagram: draw this markup instead of loading `src`. */
	diagram?: DiagramMedia;
	onTapBackdrop: () => void;
	onZoomChange: (zoomed: boolean) => void;
	/** Page to the previous (-1) / next (+1) item; absent when there is one. */
	onSwipe?: (direction: -1 | 1) => void;
	/** Direction the previous item left in, so this one enters from the far
	 * side; 0 for the first item shown. */
	enterFrom?: -1 | 0 | 1;
	viewTransitionName?: string;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	/** The element the transform is written to, whichever kind is on screen. */
	const mediaEl = () => (diagram ? boxRef.current : imgRef.current);
	/** Cached layoutOrigin(), see there. Null means "measure on next read". */
	const layout = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
	const t = useRef({ s: 1, tx: 0, ty: 0 });
	const swipeX = useRef(0);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const gesture = useRef<{
		moved: boolean;
		downTarget: EventTarget | null;
		downAt: number;
		p0: { x: number; y: number };
		t0: { s: number; tx: number; ty: number };
		d0: number;
		m0: { x: number; y: number };
		pinched: boolean;
		/** null while the drag's intent is still undecided. */
		swiping: boolean | null;
	} | null>(null);
	const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
	const [zoomed, setZoomed] = useState(false);
	const zoomedRef = useRef(false);
	/** A diagram's box, fitted to the surface. Unlike a photo, a chart has no
	 * natural pixel size to hold it back — its viewBox is arbitrary units — so
	 * it fills the room available rather than stopping at 1:1. Sized here in JS
	 * rather than by CSS on the svg because the gesture code needs a real box
	 * to measure the zoom and pan bounds against. */
	const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
	useLayoutEffect(() => {
		if (!diagram) return;
		const measure = () => {
			const wrap = wrapRef.current;
			if (!wrap) return;
			const room = {
				w: wrap.clientWidth - DIAGRAM_PADDING * 2,
				h: wrap.clientHeight - DIAGRAM_PADDING * 2,
			};
			const scale = Math.min(room.w / diagram.size.w, room.h / diagram.size.h);
			if (!(scale > 0) || !Number.isFinite(scale)) return;
			setFit({
				w: Math.round(diagram.size.w * scale) + DIAGRAM_PADDING * 2,
				h: Math.round(diagram.size.h * scale) + DIAGRAM_PADDING * 2,
			});
			layout.current = null;
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [diagram]);

	function apply(animate = false) {
		const img = mediaEl();
		if (!img) return;
		const { s, tx, ty } = t.current;
		img.style.transition = animate ? "transform 0.18s ease-out" : "none";
		img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
		const nextZoomed = s > 1;
		if (nextZoomed !== zoomedRef.current) {
			zoomedRef.current = nextZoomed;
			setZoomed(nextZoomed);
			onZoomChange(nextZoomed);
		}
	}

	/** The page-drag offset, written to the wrapper so it composes with the
	 * img's own zoom transform instead of fighting it. */
	function applySwipe(dx: number, animate = false) {
		swipeX.current = dx;
		const wrap = wrapRef.current;
		if (!wrap) return;
		wrap.style.transition = animate
			? "transform 0.24s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.24s ease-out"
			: "none";
		wrap.style.transform = dx ? `translateX(${dx}px)` : "";
		// A touch of fade sells the hand-off; the picture stays legible enough
		// to see what you are dragging towards.
		wrap.style.opacity = dx ? String(1 - Math.min(Math.abs(dx) / 900, 0.3)) : "1";
	}

	// The item is keyed by src, so a page turn mounts a fresh surface: slide it
	// in from the side the drag was heading, which is the only cue that the
	// picture changed rather than reloaded.
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!enterFrom || !wrap) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		// The wrapper is translated for the length of this, so the img's rect is
		// in motion and must not be cached from it.
		layout.current = null;
		applySwipe(enterFrom * Math.min(140, window.innerWidth * 0.25));
		const frame = requestAnimationFrame(() => applySwipe(0, true));
		return () => cancelAnimationFrame(frame);
	}, [enterFrom, src]);

	/** The img's layout (untransformed) viewport rect — transform-origin is 0 0,
	 * so the rendered top-left is layout top-left + current translation.
	 *
	 * Cached, because reading it is a layout read and the callers sit between
	 * transform writes: measuring per pointer event forces a synchronous reflow
	 * on every frame of a pinch or pan, at up to the pointer's rate. The value
	 * it returns is by construction independent of the transform, so nothing
	 * a gesture does can invalidate it — only a real layout change can. */
	function layoutOrigin() {
		if (layout.current) return layout.current;
		const img = mediaEl()!;
		const r = img.getBoundingClientRect();
		const { s, tx, ty } = t.current;
		return (layout.current = {
			x: r.left - tx,
			y: r.top - ty,
			w: r.width / s,
			h: r.height / s,
		});
	}
	// The picture's box moves with the viewport, and moves again when a new src
	// decodes at a different aspect. Each gesture also re-measures on its first
	// press: the wrapper carries the page-turn translation, so a box read while
	// that is running describes where the picture was, not where it settles.
	useEffect(() => {
		const forget = () => {
			layout.current = null;
		};
		window.addEventListener("resize", forget);
		return () => window.removeEventListener("resize", forget);
	}, []);
	useEffect(() => {
		layout.current = null;
	}, [src]);

	/** Keep the scaled image covering the viewport (or centered when smaller).
	 * Bounds are the full screen, not the letterboxed wrapper — a zoomed photo
	 * should spread under the floating chrome like a native photo viewer, not
	 * clip at the wrapper edges. */
	function clamp(next: { s: number; tx: number; ty: number }) {
		if (!mediaEl()) return next;
		const C = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
		const o = layoutOrigin();
		const clampAxis = (
			pos: number, // desired translation on this axis
			origin: number,
			size: number,
			cStart: number,
			cSize: number,
		) => {
			const scaled = size * next.s;
			if (scaled <= cSize) return cStart + (cSize - scaled) / 2 - origin;
			const min = cStart + cSize - scaled - origin;
			const max = cStart - origin;
			return Math.min(max, Math.max(min, pos));
		};
		return {
			s: next.s,
			tx: clampAxis(next.tx, o.x, o.w, C.left, C.width),
			ty: clampAxis(next.ty, o.y, o.h, C.top, C.height),
		};
	}

	/** Rescale to `sNew` keeping the viewport point `p` fixed on the image. */
	function zoomAt(p: { x: number; y: number }, sNew: number, animate = false) {
		const o = layoutOrigin();
		const { s, tx, ty } = t.current;
		const ux = (p.x - o.x - tx) / s;
		const uy = (p.y - o.y - ty) / s;
		t.current = clamp({ s: sNew, tx: p.x - o.x - ux * sNew, ty: p.y - o.y - uy * sNew });
		if (t.current.s <= 1.02) t.current = { s: 1, tx: 0, ty: 0 };
		apply(animate);
	}

	function onPointerDown(e: React.PointerEvent) {
		// One measurement per gesture: nothing that happens between here and the
		// last finger up can move the picture's layout box.
		layout.current = null;
		wrapRef.current?.setPointerCapture(e.pointerId);
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const pts = [...pointers.current.values()];
		if (pts.length === 2) {
			gesture.current = {
				...(gesture.current || {
					moved: false,
					downTarget: e.target,
					downAt: performance.now(),
				}),
				moved: gesture.current?.moved || false,
				downTarget: gesture.current?.downTarget ?? e.target,
				downAt: gesture.current?.downAt ?? performance.now(),
				p0: pts[0],
				t0: { ...t.current },
				d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
				m0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
				pinched: true,
				swiping: false,
			};
			// A second finger means this was never a page turn.
			if (swipeX.current) applySwipe(0, true);
		} else if (pts.length === 1) {
			gesture.current = {
				moved: false,
				downTarget: e.target,
				downAt: performance.now(),
				p0: pts[0],
				t0: { ...t.current },
				d0: 0,
				m0: pts[0],
				pinched: false,
				swiping: null,
			};
		}
	}

	function onPointerMove(e: React.PointerEvent) {
		if (!pointers.current.has(e.pointerId) || !gesture.current) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const g = gesture.current;
		const pts = [...pointers.current.values()];
		if (g.pinched && pts.length >= 2) {
			const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
			const m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
			// No clamping mid-pinch — fighting the fingers makes the image slide
			// away from the focal point. Bounds are re-imposed on release.
			const sNew = Math.min(MAX_SCALE, Math.max(0.5, (g.t0.s * d) / (g.d0 || 1)));
			const o = layoutOrigin();
			const ux = (g.m0.x - o.x - g.t0.tx) / g.t0.s;
			const uy = (g.m0.y - o.y - g.t0.ty) / g.t0.s;
			t.current = { s: sNew, tx: m.x - o.x - ux * sNew, ty: m.y - o.y - uy * sNew };
			apply();
			g.moved = true;
		} else if (pts.length === 1) {
			const p = pts[0];
			const dx = p.x - g.p0.x;
			const dy = p.y - g.p0.y;
			if (Math.hypot(dx, dy) > 6) g.moved = true;
			if (t.current.s > 1 && !g.pinched) {
				t.current = clamp({ s: g.t0.s, tx: g.t0.tx + dx, ty: g.t0.ty + dy });
				apply();
			} else if (onSwipe && !g.pinched && t.current.s === 1) {
				// Decide once, at the threshold: a drag that starts out mostly
				// sideways pages, anything else is left alone (a vertical flick
				// on the backdrop, a hesitant press) so the intent can't flip
				// mid-gesture.
				if (g.swiping === null && Math.hypot(dx, dy) > 8) {
					g.swiping = Math.abs(dx) > Math.abs(dy) * 1.2;
				}
				if (g.swiping) applySwipe(dx);
			}
		}
	}

	function onPointerEnd(e: React.PointerEvent) {
		if (!pointers.current.has(e.pointerId)) return;
		const p = { x: e.clientX, y: e.clientY };
		pointers.current.delete(e.pointerId);
		const g = gesture.current;
		if (!g) return;
		const remaining = [...pointers.current.values()];
		if (remaining.length === 1) {
			// Pinch → one finger left: re-anchor so it pans from here.
			g.p0 = remaining[0];
			g.t0 = { ...t.current };
			g.pinched = false;
			g.moved = true;
			return;
		}
		if (remaining.length > 0) return;
		// A page drag resolves on its own terms: past a fifth of the screen, or
		// a flick of any size, hands over to the neighbouring item — otherwise
		// the picture slides back and nothing changed.
		if (g.swiping) {
			const dx = p.x - g.p0.x;
			const speed = Math.abs(dx) / Math.max(1, performance.now() - g.downAt);
			gesture.current = null;
			if (
				Math.abs(dx) > Math.min(120, window.innerWidth * 0.2) ||
				(speed > 0.45 && Math.abs(dx) > 24)
			) {
				onSwipe?.(dx < 0 ? 1 : -1);
			} else {
				applySwipe(0, true);
			}
			return;
		}
		// Last pointer up — settle back inside bounds (animated) and check taps.
		if (t.current.s <= 1.05) {
			t.current = { s: 1, tx: 0, ty: 0 };
			apply(true);
		} else {
			t.current = clamp({ ...t.current });
			apply(true);
		}
		const isTap =
			!g.moved && e.pointerType !== "mouse"
				? performance.now() - g.downAt < 400
				: !g.moved; // mouse: any clean click counts
		gesture.current = null;
		if (!isTap) return;
		const prevTap = lastTap.current;
		lastTap.current = { at: performance.now(), x: p.x, y: p.y };
		const isDouble =
			prevTap &&
			performance.now() - prevTap.at < 300 &&
			Math.hypot(p.x - prevTap.x, p.y - prevTap.y) < 40;
		if (isDouble) {
			lastTap.current = null;
			zoomAt(p, t.current.s > 1 ? 1 : DOUBLE_TAP_SCALE, true);
			return;
		}
		// Single tap on the backdrop (not the photo itself) closes, like the
		// rest of the modal chrome. On the photo it's a no-op (double-tap arms).
		if (g.downTarget === wrapRef.current && t.current.s === 1) onTapBackdrop();
	}

	// Wheel/trackpad zoom. Native non-passive listener — React's onWheel can be
	// passive, and preventDefault must win or the page behind rubber-bands.
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		function onWheel(e: WheelEvent) {
			e.preventDefault();
			const sNew = Math.min(
				MAX_SCALE,
				Math.max(1, t.current.s * Math.exp(-e.deltaY * 0.0022)),
			);
			zoomAt({ x: e.clientX, y: e.clientY }, sNew);
		}
		wrap.addEventListener("wheel", onWheel, { passive: false });
		return () => wrap.removeEventListener("wheel", onWheel);
	}, []);

	return (
		<div
			ref={wrapRef}
			className={`flex min-h-0 min-w-0 flex-1 touch-none select-none items-center justify-center self-stretch ${
				zoomed ? "cursor-grab" : "cursor-zoom-in"
			}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
		>
			{diagram ? (
				<div
					ref={boxRef}
					role="img"
					aria-label="Diagram"
					// The same hairline and corner the photo takes, over the well
					// the diagram is drawn on in the transcript: a light-theme
					// chart is near-black ink, which would be unreadable straight
					// on the scrim.
					className="box-border shrink-0 rounded-2xl border border-white/20 bg-[var(--diagram-canvas)] p-4 [transform-origin:0_0] [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
					style={{ width: fit?.w, height: fit?.h, viewTransitionName }}
					// The markup is mermaid's own output, already rendered into the
					// transcript by MarkdownBody; this is the same SVG, resized.
					dangerouslySetInnerHTML={{ __html: diagram.svg }}
				/>
			) : (
				<img
					ref={imgRef}
					src={src}
					alt=""
					draggable={false}
					// object-contain sizes the box from the decoded picture, so the
					// box before load is not the box after it.
					onLoad={() => {
						layout.current = null;
					}}
					// The scrim is near-black in both themes, so a dark screenshot
					// opened full size has no edge of its own and bleeds into it.
					// A white hairline rather than border-line-strong: this surface
					// is always dark, like the rest of the lightbox chrome.
					// The top of the radius scale, because this is the largest
					// floating surface in the app and a card-sized corner on a
					// screen-sized photo reads as a crop rather than a shape.
					// Anything rounder would leave the scale, and it starts
					// clipping content that sits in a screenshot's own corner.
					className="min-h-0 min-w-0 max-h-full max-w-full rounded-2xl border border-white/20 object-contain [transform-origin:0_0]"
					style={{ viewTransitionName }}
				/>
			)}
		</div>
	);
}

// Apple's page control keeps a small moving window for long galleries instead
// of dropping the dots entirely. Edge dots shrink to hint that more lie beyond.
const MAX_VISIBLE_DOTS = 7;

// Download / Open: quiet pills in the top action cluster, matching the asset
// preview's separation between actions above and descriptions below.
const lightboxAction =
	"inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs text-white/60 no-underline transition-colors hover:bg-white/15 hover:text-white";

const PREVIEW_LABEL: Record<LightboxItem["kind"], string> = {
	image: "Image preview",
	video: "Video preview",
	diagram: "Diagram preview",
};

function MediaLightbox({
	items,
	index,
	onIndex,
	onClose,
	useHeroTransition,
	heroTransitionName,
}: {
	items: LightboxItem[];
	index: number;
	onIndex: (i: number) => void;
	onClose: (allowHeroTransition?: boolean) => void;
	useHeroTransition: boolean;
	heroTransitionName?: string;
}) {
	const item = items[index];
	const many = items.length > 1;
	const dotStart = Math.min(
		Math.max(0, index - Math.floor(MAX_VISIBLE_DOTS / 2)),
		Math.max(0, items.length - MAX_VISIBLE_DOTS),
	);
	const dotIndexes = Array.from(
		{ length: Math.min(items.length, MAX_VISIBLE_DOTS) },
		(_, offset) => dotStart + offset,
	);
	const [imageZoomed, setImageZoomed] = useState(false);
	// Which file the copy receipt belongs to, so a page turn shows the fresh
	// "Copy link" for the item now on screen rather than a stale "Copied".
	const [copiedSrc, setCopiedSrc] = useState<string | null>(null);
	const copied = !!item && copiedSrc === item.src;
	const [savingSrc, setSavingSrc] = useState<string | null>(null);
	const nativeShare = canUseNativeIOSShare();
	const saving = savingSrc === item.src;
	// Which way the last page turn went, so the arriving item slides in from
	// the side it came from — set by the arrows and the keyboard too, not just
	// by the drag, so every route through the gallery reads the same.
	const [direction, setDirection] = useState<-1 | 0 | 1>(0);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const reduceMotion = useReducedMotion();
	const prev = () => {
		setImageZoomed(false);
		setDirection(-1);
		onIndex((index - 1 + items.length) % items.length);
	};
	const next = () => {
		setImageZoomed(false);
		setDirection(1);
		onIndex((index + 1) % items.length);
	};
	const go = (i: number) => {
		if (i === index) return;
		setImageZoomed(false);
		setDirection(i > index ? 1 : -1);
		onIndex(i);
	};
	const requestClose = () => onClose(!imageZoomed);
	const saveItem = async () => {
		if (saving) return;
		setSavingSrc(item.src);
		try {
			await saveFileWithNativeShare(downloadHref(item), suggestedName(item));
		} catch (error) {
			if (!nativeShareWasCancelled(error)) toast("Could not save that file");
		} finally {
			setSavingSrc(null);
		}
	};
	const openItem = async () => {
		try {
			await shareURL(item.src);
		} catch (error) {
			if (!nativeShareWasCancelled(error)) toast("Could not share that link");
		}
	};

	useEffect(() => {
		if (!copiedSrc) return;
		const t = setTimeout(() => setCopiedSrc(null), 1600);
		return () => clearTimeout(t);
	}, [copiedSrc]);

	useEffect(() => {
		const previousFocus = document.activeElement as HTMLElement | null;
		// Focus returns to whatever opened the viewer, but the ring only comes
		// back if it was there to begin with: a mouse click on a session image
		// focuses its wrapping <a> silently, and closing with Escape puts the
		// browser in keyboard modality, so a plain focus() would leave an
		// outline around an image nobody deliberately focused.
		const restore: FocusOptionsWithVisible = {
			preventScroll: true,
			focusVisible: !!previousFocus?.matches?.(":focus-visible"),
		};
		const frame = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
		return () => {
			cancelAnimationFrame(frame);
			if (previousFocus?.isConnected) previousFocus.focus(restore);
		};
	}, []);

	// Capture-phase so the arrows/Escape don't also drive whatever is behind
	// the modal (composer, session viewer shortcuts).
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				requestClose();
			} else if (e.key === "ArrowLeft" && many) {
				e.stopPropagation();
				e.preventDefault();
				prev();
			} else if (e.key === "ArrowRight" && many) {
				e.stopPropagation();
				e.preventDefault();
				next();
			} else if (e.key === "Tab") {
				const focusable = Array.from(
					dialogRef.current?.querySelectorAll<HTMLElement>(
						'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])',
					) || [],
				).filter((element) => element.getClientRects().length > 0);
				if (focusable.length === 0) {
					e.preventDefault();
					return;
				}
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				const active = document.activeElement;
				if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
					e.preventDefault();
					first.focus();
				}
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});

	if (!item) return null;
	// When it was taken, the way the rest of the app says it — "Today at 14:32",
	// "Jul 12 at 09:05" — rather than a raw locale stamp with seconds in it.
	const caption = [item.sessionTitle, item.at ? fullTime(item.at) : null]
		.filter(Boolean)
		.join(" · ");
	const description = item.description?.trim();
	// z-10 keeps the chrome floating above a zoomed image, which is free to
	// spread under it across the whole viewport (z-index applies to flex items
	// without needing position).
	const navBtn =
		"z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border-0 bg-white/10 p-0 text-white hover:bg-white/20";

	return (
		<motion.div
			ref={dialogRef}
			data-media-lightbox=""
			className="fixed inset-0 z-[11000] flex flex-col bg-black/85"
			role="dialog"
			aria-modal="true"
			aria-label={PREVIEW_LABEL[item.kind]}
			initial={useHeroTransition ? false : { opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={useHeroTransition ? { opacity: 1 } : { opacity: 0 }}
			transition={useHeroTransition ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) requestClose();
			}}
		>
			<div className="absolute right-[calc(12px+env(safe-area-inset-right))] top-[calc(12px+env(safe-area-inset-top))] z-10 flex items-center gap-1">
				{nativeShare ? (
					<button type="button" className={lightboxAction} onClick={saveItem} disabled={saving}>
						<IconArrowDown size={14} />
						{saving ? "Preparing…" : "Download"}
					</button>
				) : (
					<a
						href={downloadHref(item)}
						download={
							item.src.startsWith("data:") || item.src.startsWith("blob:")
								? suggestedName(item)
								: undefined
						}
						className={lightboxAction}
					>
						<IconArrowDown size={14} />
						Download
					</a>
				)}
				{!item.src.startsWith("data:") && (
					<>
						{/* The file's own URL — what you paste into a Tella upload, a
						    ticket, or a message to someone else on the tailnet. */}
						<button
							type="button"
							onClick={() =>
								copyToClipboard(shareableSrc(item), () =>
									setCopiedSrc(item.src),
								)
							}
							className={lightboxAction}
						>
							{copied ? <IconCheck size={14} /> : <IconLink size={14} />}
							{copied ? "Copied" : "Copy link"}
						</button>
						{nativeShare ? (
							<button type="button" onClick={openItem} className={lightboxAction}>
								<IconArrowUpRight size={14} />
								Open or share
							</button>
						) : (
							<a
								href={item.src}
								target="_blank"
								rel="noopener noreferrer"
								className={lightboxAction}
							>
								<IconArrowUpRight size={14} />
								Open
							</a>
						)}
					</>
				)}
				<button
					ref={closeRef}
					type="button"
					className={navBtn}
					onClick={requestClose}
					aria-label="Close"
				>
					<IconX size={22} />
				</button>
			</div>

			<div
				className="flex min-h-0 flex-1 items-center justify-center gap-3 px-3 pb-2 pt-[calc(56px+env(safe-area-inset-top))] sm:px-4"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) requestClose();
				}}
			>
				{many && (
					<button
						type="button"
						className={navBtn}
						onClick={prev}
						aria-label="Previous"
					>
						<IconChevronLeft size={24} />
					</button>
				)}
				<motion.div
					className="flex min-h-0 min-w-0 flex-1 self-stretch"
					initial={
						useHeroTransition
							? false
							: { opacity: 0, scale: reduceMotion ? 1 : 0.96 }
					}
					animate={{ opacity: 1, scale: 1 }}
					exit={
						useHeroTransition
							? { opacity: 1, scale: 1 }
							: { opacity: 0, scale: reduceMotion ? 1 : 0.985 }
					}
					transition={
						useHeroTransition
							? { duration: 0 }
							: reduceMotion
								? { duration: 0.14, ease: "easeOut" }
								: { type: "spring", duration: 0.28, bounce: 0 }
					}
				>
					{item.kind !== "video" ? (
						<ZoomableMedia
							key={item.src}
							src={item.src}
							diagram={item.diagram}
							onTapBackdrop={requestClose}
							onZoomChange={setImageZoomed}
							onSwipe={many ? (d) => (d === 1 ? next() : prev()) : undefined}
							enterFrom={direction}
							viewTransitionName={heroTransitionName}
						/>
					) : (
						<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center self-stretch">
							<video
								key={item.src}
								src={item.src}
								controls
								autoPlay
								muted
								playsInline
								// Same hairline as the photo: a dark first frame needs
								// an edge against the scrim just as much.
								className="min-h-0 min-w-0 max-h-full max-w-full rounded-2xl border border-white/20"
							/>
						</div>
					)}
				</motion.div>
				{many && (
					<button
						type="button"
						className={navBtn}
						onClick={next}
						aria-label="Next"
					>
						<IconChevronRight size={24} />
					</button>
				)}
			</div>

			{/* What you are looking at gets its own line directly under the
			    picture, in plain white. Actions live above with Close, so a
			    "Before"/"After" label cannot read as another link. */}
			<div
				className={cn(
					"z-10 flex flex-col items-center gap-1.5 px-4 pb-4 pt-4",
					!item.walkthroughLabel && !caption && !description && !many && "hidden",
				)}
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) requestClose();
				}}
			>
				{(item.walkthroughLabel || caption || description) && (
					<div className="flex max-w-full flex-col items-center gap-0.5 text-center">
						<div className="flex max-w-full items-center justify-center gap-2">
							{caption && (
								<div className="min-w-0 max-w-full truncate text-sm font-medium text-white">
									{caption}
								</div>
							)}
							{item.walkthroughLabel && (
								<span
									className={cn(
										WALKTHROUGH_LABEL_CLASS,
										WALKTHROUGH_LABEL_TONE[item.walkthroughLabel],
									)}
								>
									{WALKTHROUGH_LABEL_TEXT[item.walkthroughLabel]}
								</span>
							)}
						</div>
						{description && (
							<div className="max-w-[min(720px,90vw)] line-clamp-2 text-sm leading-snug text-white/75">
								{description}
							</div>
						)}
					</div>
				)}
				<div className="flex items-center gap-1.5">
					{many && (
						// Dots provide direct jumps; the counter beside them gives the
						// exact position without making the reader count circles.
						<div className="flex items-center">
							{dotIndexes.map((dot, position) => (
								<button
									key={`${dot}-${items[dot].src}`}
									type="button"
									onClick={() => go(dot)}
									aria-label={`Show ${dot + 1} of ${items.length}`}
									aria-current={dot === index ? "true" : undefined}
									className="group shrink-0 cursor-pointer border-0 bg-transparent p-1 leading-none"
								>
									<span
										className={cn(
											"block size-1.5 rounded-full transition-[scale,background-color]",
											((position === 0 && dotStart > 0) ||
												(position === dotIndexes.length - 1 &&
													dotStart + dotIndexes.length < items.length)) &&
												"scale-[0.67]",
											dot === index
												? "bg-white"
												: "bg-white/30 group-hover:bg-white/60",
										)}
									/>
								</button>
							))}
						</div>
					)}
					{many && (
						<span className="text-meta font-medium tabular-nums text-white/50">
							{index + 1} of {items.length}
						</span>
					)}
				</div>
			</div>
		</motion.div>
	);
}
