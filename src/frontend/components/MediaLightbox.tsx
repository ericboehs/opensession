import React, { useEffect, useRef, useState } from "react";
import { type WorkspaceMediaItem } from "../lib/api";
import { IconChevronLeft, IconChevronRight, IconX } from "./icons";

/**
 * Full-screen lightbox for all in-app media: workspace-media thumbnails (the
 * sidebar hover card, the mobile sheet, and the WorkspaceInfo panel) and any
 * chat media (markdown images, pasted-image attachments, tool-result
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
 * Chat media is wired through a delegated capture-phase click listener here
 * (rather than per-component onClicks) because markdown images are injected
 * via dangerouslySetInnerHTML and can't carry React handlers.
 */

export interface LightboxItem {
	kind: "image" | "video";
	src: string;
	chatTitle?: string;
	at?: string;
}

interface LightboxState {
	items: LightboxItem[];
	index: number;
}

let host: ((s: LightboxState) => void) | null = null;

export function openLightbox(
	items: (LightboxItem | WorkspaceMediaItem)[],
	index: number,
) {
	host?.({ items, index });
}

/** Every piece of chat media currently in the DOM, in document order —
 * markdown images/videos, pasted attachments, tool-result screenshots. */
const GALLERY_SELECTOR = "img.md-image, video.md-video";

/** Open the lightbox on `el`, with prev/next browsing across all chat media
 * currently on screen (a conversation-wide gallery). */
export function openGalleryFrom(el: Element) {
	const nodes = Array.from(document.querySelectorAll(GALLERY_SELECTOR));
	const items: LightboxItem[] = nodes.map((n) => ({
		kind: n.tagName === "VIDEO" ? "video" : "image",
		src: (n as HTMLImageElement | HTMLVideoElement).src,
	}));
	if (items.length === 0) return;
	openLightbox(items, Math.max(0, nodes.indexOf(el)));
}

export function MediaLightboxHost() {
	const [state, setState] = useState<LightboxState | null>(null);
	useEffect(() => {
		host = setState;
		return () => {
			if (host === setState) host = null;
		};
	}, []);
	// Delegated capture-phase listener: intercept plain left-clicks on any
	// chat image and open the gallery instead of following the wrapping
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
			const img = (e.target as HTMLElement).closest?.("img.md-image");
			if (!img) return;
			e.preventDefault();
			e.stopPropagation();
			openGalleryFrom(img);
		}
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, []);
	if (!state) return null;
	return (
		<MediaLightbox
			items={state.items}
			index={state.index}
			onIndex={(index) => setState({ ...state, index })}
			onClose={() => setState(null)}
		/>
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

function suggestedName(item: LightboxItem, mime: string): string {
	// Prefer the URL's own basename when it carries an extension.
	if (!item.src.startsWith("data:") && !item.src.startsWith("blob:")) {
		try {
			const base = decodeURIComponent(
				new URL(item.src, location.href).pathname.split("/").pop() || "",
			);
			if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
		} catch {}
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const ext = mime
		? extFromMime(mime)
		: item.kind === "video"
			? "mp4"
			: "png";
	return `${item.kind}-${stamp}.${ext}`;
}

/**
 * Save the current item to the device. fetch→blob→ObjectURL so it works for
 * data:/blob:/same-origin URLs alike (a plain <a download> on a cross-origin
 * URL is silently ignored); a cross-origin file without CORS falls back to
 * opening it in a new tab, where the browser's own save UI takes over.
 */
async function downloadItem(item: LightboxItem) {
	try {
		const res = await fetch(item.src);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = suggestedName(item, blob.type);
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch {
		window.open(item.src, "_blank", "noopener");
	}
}

const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Pinch/pan/zoom surface for one image. The wrapper (not the letterboxed img)
 * owns the gesture so pinches starting beside the photo still work; transforms
 * are written straight to the img style (no per-move re-render). A clean tap
 * on the backdrop area of the wrapper closes — unless it's the first half of a
 * double-tap on the image, which zooms instead.
 */
function ZoomableImage({
	src,
	onTapBackdrop,
}: {
	src: string;
	onTapBackdrop: () => void;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const t = useRef({ s: 1, tx: 0, ty: 0 });
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
	} | null>(null);
	const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
	const [zoomed, setZoomed] = useState(false);

	function apply() {
		const img = imgRef.current;
		if (!img) return;
		const { s, tx, ty } = t.current;
		img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
		setZoomed(s > 1);
	}

	/** The img's layout (untransformed) viewport rect — transform-origin is 0 0,
	 * so the rendered top-left is layout top-left + current translation. */
	function layoutOrigin() {
		const img = imgRef.current!;
		const r = img.getBoundingClientRect();
		const { s, tx, ty } = t.current;
		return { x: r.left - tx, y: r.top - ty, w: r.width / s, h: r.height / s };
	}

	/** Keep the scaled image covering the container (or centered when smaller). */
	function clamp(next: { s: number; tx: number; ty: number }) {
		const wrap = wrapRef.current;
		const img = imgRef.current;
		if (!wrap || !img) return next;
		const C = wrap.getBoundingClientRect();
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
	function zoomAt(p: { x: number; y: number }, sNew: number) {
		const o = layoutOrigin();
		const { s, tx, ty } = t.current;
		const ux = (p.x - o.x - tx) / s;
		const uy = (p.y - o.y - ty) / s;
		t.current = clamp({ s: sNew, tx: p.x - o.x - ux * sNew, ty: p.y - o.y - uy * sNew });
		if (t.current.s <= 1.02) t.current = { s: 1, tx: 0, ty: 0 };
		apply();
	}

	function onPointerDown(e: React.PointerEvent) {
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
			};
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
			const sNew = Math.min(MAX_SCALE, Math.max(1, (g.t0.s * d) / (g.d0 || 1)));
			const o = layoutOrigin();
			const ux = (g.m0.x - o.x - g.t0.tx) / g.t0.s;
			const uy = (g.m0.y - o.y - g.t0.ty) / g.t0.s;
			t.current = clamp({ s: sNew, tx: m.x - o.x - ux * sNew, ty: m.y - o.y - uy * sNew });
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
		// Last pointer up — settle and check for tap gestures.
		if (t.current.s <= 1.05) {
			t.current = { s: 1, tx: 0, ty: 0 };
			apply();
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
			zoomAt(p, t.current.s > 1 ? 1 : DOUBLE_TAP_SCALE);
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
			className={`flex min-h-0 min-w-0 flex-1 touch-none select-none items-center justify-center self-stretch overflow-hidden ${
				zoomed ? "cursor-grab" : "cursor-zoom-in"
			}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
		>
			<img
				ref={imgRef}
				src={src}
				alt=""
				draggable={false}
				className="min-h-0 min-w-0 max-h-full max-w-full rounded-md object-contain [transform-origin:0_0]"
			/>
		</div>
	);
}

function MediaLightbox({
	items,
	index,
	onIndex,
	onClose,
}: {
	items: LightboxItem[];
	index: number;
	onIndex: (i: number) => void;
	onClose: () => void;
}) {
	const item = items[index];
	const many = items.length > 1;
	const prev = () => onIndex((index - 1 + items.length) % items.length);
	const next = () => onIndex((index + 1) % items.length);

	// Capture-phase so the arrows/Escape don't also drive whatever is behind
	// the modal (composer, session viewer shortcuts).
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			} else if (e.key === "ArrowLeft" && many) {
				e.stopPropagation();
				e.preventDefault();
				prev();
			} else if (e.key === "ArrowRight" && many) {
				e.stopPropagation();
				e.preventDefault();
				next();
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});

	if (!item) return null;
	const caption = [
		item.chatTitle,
		item.at ? new Date(item.at).toLocaleString() : null,
	]
		.filter(Boolean)
		.join(" · ");
	const navBtn =
		"grid h-10 w-10 shrink-0 place-items-center rounded-full border-0 bg-white/10 p-0 text-white hover:bg-white/20";

	return (
		<div
			className="fixed inset-0 z-[400] flex flex-col bg-black/85"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<button
				type="button"
				className={`${navBtn} absolute right-3 top-3 z-10`}
				onClick={onClose}
				aria-label="Close"
			>
				<IconX size={22} />
			</button>

			<div
				className="flex min-h-0 flex-1 items-center justify-center gap-3 px-3 pb-2 pt-14 sm:px-4"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) onClose();
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
				{item.kind === "image" ? (
					<ZoomableImage key={item.src} src={item.src} onTapBackdrop={onClose} />
				) : (
					<video
						key={item.src}
						src={item.src}
						controls
						autoPlay
						muted
						playsInline
						className="min-h-0 min-w-0 max-h-full max-w-full rounded-md"
					/>
				)}
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

			<div
				className="flex items-center justify-center gap-3 px-4 pb-4 pt-1 text-xs text-white/70"
				onMouseDown={(e) => {
					if (e.target === e.currentTarget) onClose();
				}}
			>
				{many && (
					<span className="tabular-nums">
						{index + 1} / {items.length}
					</span>
				)}
				{caption && <span className="min-w-0 truncate">{caption}</span>}
				<button
					type="button"
					onClick={() => void downloadItem(item)}
					className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-white/70 hover:text-white hover:underline"
				>
					Download
				</button>
				{!item.src.startsWith("data:") && (
					<a
						href={item.src}
						target="_blank"
						rel="noopener noreferrer"
						className="shrink-0 text-white/70 hover:text-white hover:underline"
					>
						Open ↗
					</a>
				)}
			</div>
		</div>
	);
}
