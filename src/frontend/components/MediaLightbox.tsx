import React, { useEffect, useState } from "react";
import { type WorkspaceMediaItem } from "../lib/api";
import { IconChevronLeft, IconChevronRight, IconX } from "./icons";

/**
 * Full-screen lightbox for workspace media thumbnails (the sidebar hover
 * card, the mobile sheet, and the WorkspaceInfo panel), with prev/next
 * browsing across the workspace's media instead of jumping to the raw file
 * in a new tab.
 *
 * Global singleton: the thumbnails live inside transient popovers — the
 * hover card unmounts on mouseleave/scroll — so the modal is hosted once in
 * App and opened imperatively via openLightbox(), surviving its opener.
 */

interface LightboxState {
	items: WorkspaceMediaItem[];
	index: number;
}

let host: ((s: LightboxState) => void) | null = null;

export function openLightbox(items: WorkspaceMediaItem[], index: number) {
	host?.({ items, index });
}

export function MediaLightboxHost() {
	const [state, setState] = useState<LightboxState | null>(null);
	useEffect(() => {
		host = setState;
		return () => {
			if (host === setState) host = null;
		};
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
	items: WorkspaceMediaItem[];
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
	const caption = [item.chatTitle, new Date(item.at).toLocaleString()]
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
				<IconX size={20} />
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
				<a
					href={item.src}
					target="_blank"
					rel="noopener noreferrer"
					className="shrink-0 text-white/70 hover:text-white hover:underline"
				>
					Open ↗
				</a>
			</div>
		</div>
	);
}
