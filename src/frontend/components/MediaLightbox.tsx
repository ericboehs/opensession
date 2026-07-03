import React, { useEffect, useState } from "react";
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
					<img
						key={item.src}
						src={item.src}
						alt=""
						className="min-h-0 min-w-0 max-h-full max-w-full rounded-md object-contain"
					/>
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
