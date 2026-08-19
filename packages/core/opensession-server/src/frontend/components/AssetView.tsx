/**
 * One scratch asset: how it renders, what you can do to it, and the overlay
 * that lifts it over the conversation.
 *
 * A file an agent wrote is reachable from three places — the chip on the turn
 * that wrote it, the Info panel's list, and the Assets tab — and all three use
 * this preview and action vocabulary, so the file behaves consistently.
 *
 * The overlay is the default way in: an artifact is something you glance at
 * mid-conversation, and an overlay costs nothing to dismiss. The Assets tab
 * stays for when you mean to sit with it — "Open as tab" in the header is the
 * promotion, and the way into the folder around the file.
 */

import React, { useEffect, useState } from "react";
import { marked } from "marked";
import {
	deleteSessionAssetApi,
	sessionAssetDownloadUrl,
	sessionAssetPreviewUrl,
	sessionAssetRawUrl,
	type SessionAssetFile,
} from "../lib/api";
import {
	ASSET_TEXT_CAP,
	adjacentAssetPath,
	assetFileFor,
	assetPreviewKind,
	formatAssetSize,
} from "../lib/asset-preview";
import {
	parseNewSessionLink,
	type NewSessionPrefill,
} from "../lib/new-session-link";
import {
	canUseNativeIOSShare,
	nativeShareWasCancelled,
	saveFileWithNativeShare,
	shareURL,
} from "../lib/native-file-save";
import { absoluteLink, copyToClipboard } from "../lib/share-link";
import { useIsPhone } from "../hooks/useIsPhone";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { ResponsiveDialog } from "../ui/sheet";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { MarkdownBody } from "./MarkdownBody";
import { openLightbox } from "./MediaLightbox";
import {
	IconArrowDown,
	IconArrowUpRight,
	IconChevronLeft,
	IconChevronRight,
	IconCopy,
	IconDotsHorizontal,
	IconTrash,
	IconX,
} from "./icons";

type AssetNavigation = {
	index: number;
	count: number;
	onPrevious: () => void;
	onNext: () => void;
	onSelect: (index: number) => void;
};

function AssetPager({
	navigation,
	arrows = false,
	onDark = false,
}: {
	navigation: AssetNavigation;
	arrows?: boolean;
	/** Desktop overlays sit directly on the dimmed backdrop, like the media lightbox. */
	onDark?: boolean;
}) {
	const { index, count, onPrevious, onNext, onSelect } = navigation;
	const positionLabel = `Asset ${index + 1} of ${count}`;
	return (
		<nav
			aria-label="Asset navigation"
			className="flex min-h-7 shrink-0 items-center justify-center gap-1"
		>
			{arrows && (
				<Tooltip label="Previous asset (Left arrow)">
					<Button
						variant="ghost"
						size="sm"
						icon={<IconChevronLeft size={16} />}
						aria-label="Previous asset"
						className="size-9"
						onClick={onPrevious}
					/>
				</Tooltip>
			)}
			<div
				aria-label={positionLabel}
				title={positionLabel}
				className="flex min-w-10 items-center justify-center px-1"
			>
				{count <= 10 ? (
					Array.from({ length: count }, (_, dot) => (
						<button
							key={dot}
							type="button"
							onClick={() => onSelect(dot)}
							aria-label={`Show ${dot + 1} of ${count}`}
							aria-current={dot === index ? "true" : undefined}
							className="group shrink-0 cursor-pointer border-0 bg-transparent p-1 leading-none"
						>
							<span
								className={cn(
									"block size-1.5 rounded-full transition-colors",
									dot === index
										? onDark
											? "bg-white"
											: "bg-fg"
										: onDark
											? "bg-white/35 group-hover:bg-white/70"
											: "bg-line-strong group-hover:bg-dim",
								)}
							/>
						</button>
					))
				) : (
					<span
						role="status"
						className={cn(
							"px-1 text-meta tabular-nums",
							onDark ? "text-white/60" : "text-faint",
						)}
					>
						{index + 1} / {count}
					</span>
				)}
			</div>
			{arrows && (
				<Tooltip label="Next asset (Right arrow)">
					<Button
						variant="ghost"
						size="sm"
						icon={<IconChevronRight size={16} />}
						aria-label="Next asset"
						className="size-9"
						onClick={onNext}
					/>
				</Tooltip>
			)}
		</nav>
	);
}

function AssetSideButton({
	direction,
	onClick,
}: {
	direction: "previous" | "next";
	onClick: () => void;
}) {
	const previous = direction === "previous";
	const label = previous ? "Previous asset" : "Next asset";
	return (
		<Tooltip label={`${label} (${previous ? "Left" : "Right"} arrow)`}>
			<Button
				variant="default"
				size="lg"
				icon={
					previous ? (
						<IconChevronLeft size={22} />
					) : (
						<IconChevronRight size={22} />
					)
				}
				aria-label={label}
				className={cn(
					"absolute top-1/2 z-20 size-10 -translate-y-1/2 rounded-full bg-raised smooth-shadow-sm",
					previous ? "right-full mr-3" : "left-full ml-3",
				)}
				onClick={onClick}
			/>
		</Tooltip>
	);
}

function AssetMenu({
	sessionId,
	file,
	refresh,
	onClose,
}: {
	sessionId: string;
	file: SessionAssetFile;
	refresh?: () => void;
	onClose?: () => void;
}) {
	const rawUrl = sessionAssetPreviewUrl(sessionId, file);
	const stableUrl = sessionAssetRawUrl(sessionId, file.path);
	const nativeShare = canUseNativeIOSShare();
	const name = file.path.split("/").pop() || "asset";

	async function onDownload() {
		try {
			await saveFileWithNativeShare(sessionAssetDownloadUrl(sessionId, file), name);
		} catch (error) {
			if (!nativeShareWasCancelled(error)) toast("Could not save that file");
		}
	}

	async function onOpen() {
		try {
			await shareURL(rawUrl);
		} catch (error) {
			if (!nativeShareWasCancelled(error)) toast("Could not share that link");
		}
	}

	async function onDelete() {
		if (!confirm(`Delete ${file.path}?`)) return;
		try {
			await deleteSessionAssetApi(sessionId, file.path);
			refresh?.();
			onClose?.();
		} catch {
			toast("Could not delete that file");
		}
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label="Asset actions"
				className="flex size-7 shrink-0 items-center justify-center rounded-control border-0 bg-transparent text-dim hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg"
			>
				<IconDotsHorizontal size={16} />
			</Menu.Trigger>
			<Menu.Popup align="end">
				<Menu.Item
					{...(nativeShare
						? { onClick: onDownload }
						: { render: <a href={sessionAssetDownloadUrl(sessionId, file)} /> })}
				>
					<IconArrowDown size={18} className="text-faint" />
					Download
				</Menu.Item>
				<Menu.Item
					{...(nativeShare
						? { onClick: onOpen }
						: { render: <a href={rawUrl} target="_blank" rel="noreferrer" /> })}
				>
					<IconArrowUpRight size={18} className="text-faint" />
					{nativeShare ? "Open or share" : "Open in a browser tab"}
				</Menu.Item>
				<Menu.Item
					onClick={() =>
						copyToClipboard(absoluteLink(stableUrl), () => toast("Link copied"))
					}
				>
					<IconCopy size={18} className="text-faint" />
					Copy link
				</Menu.Item>
				<Menu.Separator />
				<Menu.Item onClick={onDelete} className="text-red">
					<IconTrash size={18} />
					Delete
				</Menu.Item>
			</Menu.Popup>
		</Menu.Root>
	);
}

/**
 * What you are looking at, under the file — name, then description, then the
 * pager. The same stack the media lightbox puts under a picture, because an
 * asset and a screenshot are the same gesture: glance at one thing lifted over
 * the conversation. Actions stay up top with Close, so nothing down here reads
 * as a control.
 */
function AssetOverlayFooter({
	file,
	navigation,
	phone,
}: {
	file: SessionAssetFile;
	navigation: AssetNavigation | null;
	phone: boolean;
}) {
	const name = file.path.split("/").pop() || file.path;
	return (
		<div
			className={cn(
				"z-20 flex shrink-0 flex-col items-center gap-1 px-3 py-2",
				phone
					? "border-t border-line"
					: "absolute left-0 right-0 top-full mt-2",
			)}
		>
			<div className="flex max-w-full flex-col items-center gap-0.5 text-center">
				<div
					className={cn(
						"max-w-full truncate font-medium",
						phone ? "text-label text-fg" : "text-sm text-white",
					)}
					title={file.path}
				>
					{name}
				</div>
				{file.description && (
					<div
						className={cn(
							"max-w-[min(720px,90vw)] line-clamp-2 leading-snug",
							phone ? "text-supporting text-dim" : "text-sm text-white/75",
						)}
					>
						{file.description}
					</div>
				)}
			</div>
			<div className="flex max-w-full items-center justify-center gap-2">
				{navigation && (
					<AssetPager navigation={navigation} arrows={phone} onDark={!phone} />
				)}
			</div>
		</div>
	);
}

/**
 * The Assets tab's file header and operations, in one row.
 *
 * The promotion into a tab earns a place on the surface. File operations
 * live behind the overflow, because a header of six
 * peer-looking text links makes the destructive one exactly as easy to hit as
 * the harmless ones. Omit `onOpenAsTab` where the tab IS the surface.
 */
export function AssetActions({
	sessionId,
	file,
	refresh,
	onOpenAsTab,
	onClose,
	showMenu = true,
	showSize = false,
	className,
}: {
	sessionId: string;
	file: SessionAssetFile;
	/** Re-list the folder after a delete. */
	refresh?: () => void;
	/** Optionally promote this file into the workspace's Assets tab. */
	onOpenAsTab?: () => void;
	/** Dismiss the surface — the overlay's ✕. Also called after a delete, since
	 *  there is nothing left to show. */
	onClose?: () => void;
	/** Hide this menu when another row owns the file actions. */
	showMenu?: boolean;
	/** False for a chip path whose folder listing has not caught up yet. */
	showSize?: boolean;
	className?: string;
}) {
	const name = file.path.split("/").pop() || file.path;
	const folder = file.path.includes("/")
		? file.path.slice(0, file.path.lastIndexOf("/"))
		: null;

	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2",
				className,
			)}
		>
			<div className="min-w-0 flex-1" title={file.path}>
				<div className="truncate text-label font-medium text-fg">{name}</div>
				{file.description && (
					<div className="line-clamp-2 text-supporting leading-snug text-dim">
						{file.description}
					</div>
				)}
				{folder && (
					<div className="truncate text-meta text-faint">{folder}</div>
				)}
			</div>
			{showSize && (
				<span className="shrink-0 text-meta text-faint">
					{formatAssetSize(file.size)}
				</span>
			)}
			{onOpenAsTab && (
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0"
					onClick={onOpenAsTab}
				>
					Open as tab
				</Button>
			)}
			{showMenu && (
				<AssetMenu
					sessionId={sessionId}
					file={file}
					refresh={refresh}
					onClose={onClose}
				/>
			)}
			{onClose && (
				<Button
					variant="ghost"
					size="sm"
					aria-label="Close"
					className="size-7 shrink-0 justify-center px-0"
					onClick={onClose}
				>
					<IconX size={16} />
				</Button>
			)}
		</div>
	);
}

/**
 * The file itself. HTML goes in an iframe served from the path-based raw
 * route, so a multi-file artifact's relative references (./style.css,
 * ./data.json) resolve to its siblings.
 */
export function AssetPreview({
	sessionId,
	file,
	onOpenNewSession,
	onBackdropClick,
	className,
}: {
	sessionId: string;
	file: SessionAssetFile;
	/** A link inside an HTML asset that spells out a new session — the artifact
	 *  can hand work back to the app it was written in. */
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
	/** Dismiss an overlay when the letterboxed image canvas is clicked. */
	onBackdropClick?: () => void;
	className?: string;
}) {
	const kind = assetPreviewKind(file.path);
	const rawUrl = sessionAssetPreviewUrl(sessionId, file);

	// Text-ish previews fetch the body themselves.
	const [text, setText] = useState<string | null>(null);
	const [textFailed, setTextFailed] = useState(false);
	useEffect(() => {
		setText(null);
		setTextFailed(false);
		if (kind !== "text" && kind !== "markdown") return;
		let alive = true;
		fetch(rawUrl)
			.then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
			.then((t) => {
				if (alive) setText(t.length > ASSET_TEXT_CAP ? t.slice(0, ASSET_TEXT_CAP) : t);
			})
			.catch(() => {
				if (alive) setTextFailed(true);
			});
		return () => {
			alive = false;
		};
	}, [rawUrl, kind]);

	return (
		<div className={cn("min-h-0 flex-1 overflow-auto", className)}>
			{kind === "html" ? (
				// allow-same-origin so the page can fetch() sibling assets
				// (./data.json); the sandbox still blocks top navigation. The
				// content is our own agents' output on a tailnet-only UI.
				<iframe
					key={rawUrl}
					title={file.path}
					src={rawUrl}
					sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-downloads"
					onLoad={(event) => {
						const document = event.currentTarget.contentDocument;
						if (!document) return;
						document.addEventListener("click", (clickEvent) => {
							const link = (clickEvent.target as Element | null)?.closest?.("a");
							const prefill = link ? parseNewSessionLink(link.href) : null;
							if (!prefill) return;
							clickEvent.preventDefault();
							onOpenNewSession(prefill);
						});
					}}
					className="h-full w-full border-0 bg-white"
				/>
			) : kind === "pdf" ? (
				// No sandbox: Chrome's built-in PDF viewer won't render in a
				// sandboxed iframe.
				<iframe
					key={rawUrl}
					title={file.path}
					src={rawUrl}
					className="h-full w-full border-0"
				/>
			) : kind === "image" ? (
				<div
					className="flex h-full items-center justify-center overflow-auto p-3"
					onClick={onBackdropClick}
				>
					<button
						type="button"
						className="flex max-h-full max-w-full cursor-zoom-in border-0 bg-transparent"
						onClick={(event) => {
							event.stopPropagation();
							openLightbox(
								[
									{
										kind: "image",
										src: rawUrl,
										sessionTitle: file.path,
										description: file.description,
									},
								],
								0,
								event.currentTarget,
							);
						}}
						aria-label={`Zoom ${file.path}`}
					>
						<img
							src={rawUrl}
							alt={file.path}
							className="max-h-full max-w-full object-contain"
						/>
					</button>
				</div>
			) : kind === "video" ? (
				<video src={rawUrl} controls className="h-full w-full" />
			) : kind === "audio" ? (
				<div className="p-4">
					<audio src={rawUrl} controls className="w-full" />
				</div>
			) : kind === "markdown" ? (
				textFailed ? (
					<div className="p-4 text-label text-faint">Could not load this file.</div>
				) : text === null ? (
					<div className="p-4 text-label text-faint">Loading…</div>
				) : (
					<MarkdownBody
						className="markdown px-4 py-3 text-label"
						html={marked.parse(text, { async: false }) as string}
					/>
				)
			) : kind === "text" ? (
				textFailed ? (
					<div className="p-4 text-label text-faint">Could not load this file.</div>
				) : text === null ? (
					<div className="p-4 text-label text-faint">Loading…</div>
				) : (
					<pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-label leading-[1.5] text-fg">
						{text}
						{file.size > ASSET_TEXT_CAP ? "\n… (truncated preview)" : ""}
					</pre>
				)
			) : (
				<div className="flex h-full items-center justify-center text-label text-faint">
					No inline preview for this file type. Use Download.
				</div>
			)}
		</div>
	);
}

/**
 * One asset, over the conversation.
 *
 * `path` null means closed; the last file stays rendered while the panel
 * animates away, so a dismissal doesn't blink to an empty box on its way out.
 */
export function AssetOverlay({
	sessionId,
	path,
	files,
	refresh,
	onClose,
	onSelectPath,
	onOpenAsTab,
	onOpenNewSession,
}: {
	sessionId: string;
	path: string | null;
	files: SessionAssetFile[];
	refresh: () => void;
	onClose: () => void;
	/** Show another file in this overlay. */
	onSelectPath: (path: string) => void;
	/** Promote the open file into the Assets tab (and dismiss). */
	onOpenAsTab?: (path: string) => void;
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
	const isPhone = useIsPhone();
	// Survives `path` going null so the exit animation has something to show.
	// While open, render directly from the controlled path so repeated arrow
	// presses never paint the previous asset for a frame.
	const [lastPath, setLastPath] = useState<string | null>(path);
	const [listedPath, setListedPath] = useState<string | null>(null);
	const [missingPath, setMissingPath] = useState<string | null>(null);
	useEffect(() => {
		if (path) {
			setLastPath(path);
			setMissingPath(null);
		}
	}, [path]);
	useEffect(() => {
		if (!path) return;
		if (files.some((candidate) => candidate.path === path)) {
			setListedPath(path);
			setMissingPath(null);
			return;
		}
		if (listedPath === path) {
			onClose();
			return;
		}
		const timeout = window.setTimeout(() => setMissingPath(path), 1_500);
		return () => window.clearTimeout(timeout);
	}, [path, files, listedPath, onClose]);
	useEffect(() => {
		if (!path || files.length < 2) return;
		const paths = files.map((file) => file.path);
		const onKey = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey ||
				(event.key !== "ArrowLeft" && event.key !== "ArrowRight")
			)
				return;
			// Menus and controls use these keys themselves. Embedded HTML/PDF content
			// lives in its own document and keeps its own keyboard interactions too.
			if (document.querySelector(".app-menu-popup")) return;
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					Boolean(
						target.closest(
							"input, textarea, select, audio, video, [contenteditable='true']",
						),
					))
			)
				return;
			const next = adjacentAssetPath(
				paths,
				path,
				event.key === "ArrowLeft" ? -1 : 1,
			);
			if (!next) return;
			event.preventDefault();
			event.stopPropagation();
			onSelectPath(next);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [path, files, onSelectPath]);
	const shown = path ?? lastPath;
	if (!shown) return null;
	const file = assetFileFor(shown, files);
	const name = file.path.split("/").pop() || file.path;
	const listed = files.some((candidate) => candidate.path === shown);
	const listedIndex = files.findIndex((candidate) => candidate.path === shown);
	const navigate = (direction: -1 | 1) => {
		const next = adjacentAssetPath(
			files.map((candidate) => candidate.path),
			shown,
			direction,
		);
		if (next) onSelectPath(next);
	};
	const navigation: AssetNavigation | null =
		listedIndex >= 0 && files.length > 1
			? {
					index: listedIndex,
					count: files.length,
					onPrevious: () => navigate(-1),
					onNext: () => navigate(1),
					onSelect: (index) => {
						const selected = files[index]?.path;
						if (selected) onSelectPath(selected);
					},
				}
			: null;
	const footer = (
		<AssetOverlayFooter
			file={file}
			navigation={navigation}
			phone={isPhone}
		/>
	);

	return (
		<ResponsiveDialog
			open={Boolean(path)}
			onClose={onClose}
			phone={isPhone}
			label={`Preview ${name}`}
			// The default modal is a 30rem confirm box; an artifact needs the
			// room a page or a chart was drawn for. `max-w-none` first, or the
			// default clamp wins.
			modalClassName="h-[min(820px,78vh)] w-[min(1120px,84vw)] max-w-none overflow-visible"
			sheetClassName="h-[94dvh]"
			backdropClassName={!isPhone ? "bg-black/65" : undefined}
		>
			<div
				className={cn(
					"flex min-h-0 flex-1 flex-col overflow-hidden",
					!isPhone && "rounded-[inherit]",
				)}
			>
				{/* Actions only: the file's name reads under it, in the footer. */}
				<div
					className="flex min-h-10 shrink-0 items-center justify-end gap-1 px-3 pr-12"
				>
					{listed && (
						<span className="shrink-0 text-meta text-faint">
							{formatAssetSize(file.size)}
						</span>
					)}
					{onOpenAsTab && (
						<Button
							variant="ghost"
							size="sm"
							icon={<IconArrowUpRight size={15} />}
							className="shrink-0"
							onClick={() => onOpenAsTab(file.path)}
						>
							Open
						</Button>
					)}
					<AssetMenu
						sessionId={sessionId}
						file={file}
						refresh={refresh}
						onClose={onClose}
					/>
				</div>
				<div className="relative flex min-h-0 flex-1">
					{missingPath === file.path ? (
						<div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-label text-faint">
							This file is no longer available.
						</div>
					) : (
						<AssetPreview
							sessionId={sessionId}
							file={file}
							onBackdropClick={onClose}
							onOpenNewSession={(prefill) => {
								onClose();
								onOpenNewSession(prefill);
							}}
						/>
					)}
				</div>
				{isPhone && footer}
			</div>
			{!isPhone && footer}
			<Tooltip label="Close">
				<Button
					variant="ghost"
					size="md"
					icon={<IconX size={18} />}
					aria-label="Close"
					className="absolute right-2 top-2 z-20 size-8"
					onClick={onClose}
				/>
			</Tooltip>
			{!isPhone && navigation && (
				<>
					<AssetSideButton direction="previous" onClick={navigation.onPrevious} />
					<AssetSideButton direction="next" onClick={navigation.onNext} />
				</>
			)}
		</ResponsiveDialog>
	);
}
