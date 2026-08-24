import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import React, { useEffect, useRef } from "react";
import {
	loadTranscriptSizes,
	recordTranscriptSizes,
	seededBlockEstimate,
	type TranscriptSizes,
} from "../lib/transcript-sizes";
import {
	registerTranscriptVirtualNavigation,
	type TranscriptVirtualNavigation,
} from "../lib/transcript-virtual-navigation";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	relative: {
			position: "relative"
	},
	wFull: {
			width: "100%"
	},
	absolute: { position: "absolute" },
	left0: { left: 0 },
	top0: { top: 0 },
});

export interface VirtualTranscriptItem {
	key: string;
	anchorId: string;
	entryIds: string[];
	estimateSize: number;
	/** Keep the estimate until sparse payload content is available to measure. */
	measure?: boolean;
	className?: string;
	content: React.ReactNode;
}

interface Props {
	items: VirtualTranscriptItem[];
	/** Keep the live-edge tail mounted inside the same virtual coordinate space. */
	trailingMounted: number;
	onVisibleItems?: (items: VirtualTranscriptItem[]) => void;
	/** Range children reuse the renderer without nesting another virtualizer. */
	enabled?: boolean;
	/** Session identity for the measured-height cache. When present, block
	 *  heights recorded on an earlier look at this session seed the next one's
	 *  first estimates, so reopening a chat does not shift while estimates
	 *  correct. The cache is in-memory only and clears when the layer width
	 *  changes (see lib/transcript-sizes.ts). */
	sizeCacheKey?: string;
}

/** Loaded transcript blocks, windowed against their nearest message scroller. */
export function VirtualTranscriptList({
	items,
	trailingMounted,
	onVisibleItems,
	enabled = true,
	sizeCacheKey,
}: Props) {
	const rootRef = useRef<HTMLDivElement>(null);
	// Heights recorded on an earlier look at sizeCacheKey, resolved once per
	// session switch. estimateSize reads them before falling back to the
	// outline heuristic, so a reopened chat starts at its true size instead of
	// correcting visible content into place.
	const seededRef = useRef<{ session: string; sizes?: TranscriptSizes } | null>(
		null,
	);
	if (sizeCacheKey && seededRef.current?.session !== sizeCacheKey) {
		seededRef.current = {
			session: sizeCacheKey,
			sizes: loadTranscriptSizes(sizeCacheKey),
		};
	}
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: items.length,
		getScrollElement: () =>
			rootRef.current?.closest<HTMLDivElement>(".viewer-messages") ?? null,
		estimateSize: (index) => {
			const item = items[index];
			if (!item) return 96;
			return seededBlockEstimate(
				item.estimateSize,
				seededRef.current?.sizes,
				item.key,
			);
		},
		getItemKey: (index) => items[index]?.key ?? index,
		overscan: 8,
		rangeExtractor: (range) =>
			virtualTranscriptRange(
				defaultRangeExtractor(range),
				range.count,
				trailingMounted,
			),
		useAnimationFrameWithResizeObserver: true,
	});
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
		item,
		_delta,
		instance,
	) => shouldAdjustTranscriptScroll(item.end, instance.scrollOffset ?? 0);
	const virtualItems = virtualizer.getVirtualItems();
	const canVirtualize =
		enabled && typeof ResizeObserver !== "undefined" && items.length > 0;

	// The recording half of the size cache. Rows that really mount are observed
	// here alongside TanStack's own measurement; their stable block keys map to
	// the heights that become the next look's seeds. Writes land straight in
	// the in-memory cache — nothing to schedule or flush. Rows never mounted
	// carry no measurement and keep their heuristic, which is exactly right:
	// they are also the blocks whose content has not been seen.
	const rowObserverRef = useRef<ResizeObserver | null>(null);
	const observeRowNode = (key: string, node: HTMLElement) => {
		node.dataset.transcriptKey = key;
		if (!rowObserverRef.current) {
			// Resolve the cache per callback so the observer never holds a stale
			// session's store after a session switch.
			rowObserverRef.current = new ResizeObserver((entries) => {
				const cache = seededRef.current?.sizes;
				if (!cache || entries.length === 0) return;
				const measured: Array<readonly [string, number]> = [];
				let width = 0;
				for (const entry of entries) {
					const target = entry.target as HTMLElement;
					const entryKey = target.dataset.transcriptKey;
					const height =
						entry.borderBoxSize?.[0]?.blockSize ??
						target.getBoundingClientRect().height;
					if (entryKey && Number.isFinite(height) && height > 0) {
						measured.push([entryKey, height]);
					}
					// Rows span the column, so their inline size IS the width the
					// heights were measured at.
					width ||= entry.borderBoxSize?.[0]?.inlineSize ?? target.offsetWidth;
				}
				recordTranscriptSizes(cache, width, measured);
			});
		}
		rowObserverRef.current.observe(node);
	};
	// Stable per-row ref callbacks. An inline arrow would detach and reattach
	// on every render, re-running TanStack's measure cleanup for each visible
	// row; caching by block key keeps attach to real mounts.
	const rowRefsRef = useRef(
		new Map<string, (node: HTMLDivElement | null) => void>(),
	);
	const rowRef = (key: string) => {
		let callback = rowRefsRef.current.get(key);
		if (!callback) {
			callback = (node) => {
				virtualizer.measureElement(node);
				if (sizeCacheKey && node) observeRowNode(key, node);
			};
			if (rowRefsRef.current.size > 1_000) rowRefsRef.current.clear();
			rowRefsRef.current.set(key, callback);
		}
		return callback;
	};
	useEffect(() => {
		return () => {
			rowObserverRef.current?.disconnect();
			rowObserverRef.current = null;
		};
	}, []);

	useEffect(() => {
		const container = rootRef.current?.closest<HTMLDivElement>(
			".viewer-messages",
		);
		if (!container || items.length === 0) return;
		const indexByEntry = new Map<string, number>();
		for (let index = 0; index < items.length; index++) {
			for (const entryId of items[index]?.entryIds ?? []) {
				if (!indexByEntry.has(entryId)) indexByEntry.set(entryId, index);
			}
		}
		const navigation: TranscriptVirtualNavigation = {
			scrollToEntry(entryId) {
				const index = indexByEntry.get(entryId);
				if (index === undefined) return false;
				virtualizer.scrollToIndex(index, { align: "start" });
				return true;
			},
		};
		return registerTranscriptVirtualNavigation(container, navigation);
	}, [items, virtualizer]);

	useEffect(() => {
		if (!onVisibleItems || virtualItems.length === 0) return;
		const container = rootRef.current?.closest<HTMLDivElement>(
			".viewer-messages",
		);
		const top = container?.scrollTop ?? 0;
		const viewport = container?.clientHeight ?? 0;
		const bottom = top + viewport;
		const demand = virtualItems.filter(
			(item) =>
				!container ||
				(item.end >= top - viewport && item.start <= bottom + viewport),
		);
		const timer = window.setTimeout(() => {
			onVisibleItems(
				demand
					.map((virtualItem) => items[virtualItem.index])
					.filter((item): item is VirtualTranscriptItem => Boolean(item)),
			);
		}, 120);
		return () => window.clearTimeout(timer);
	}, [items, onVisibleItems, virtualItems]);

	// Server rendering and minimal test DOMs have no ResizeObserver. Keeping the
	// complete list there also makes transcript markup tests inspect real rows.
	if (!canVirtualize) {
		return <>{items.map(renderStaticItem)}</>;
	}

	return (
		<>
			<div
				ref={rootRef}
				{...stylex.props(sx.relative, sx.wFull)}
				style={{ height: virtualizer.getTotalSize() }}
				data-virtual-transcript
				data-virtual-count={items.length}
				data-transcript-blocks={items.length}
			>
				{virtualItems.map((virtualItem) => {
					const item = items[virtualItem.index];
					if (!item) return null;
					const rowStyles = stylex.props(sx.absolute, sx.left0, sx.top0, sx.wFull);
					return (
						<div
							key={item.key}
							ref={item.measure === false ? undefined : rowRef(item.key)}
							data-index={virtualItem.index}
							data-eid={item.anchorId}
							{...rowStyles}
							className={[rowStyles.className, item.className].filter(Boolean).join(" ")}
							style={{ ...rowStyles.style, transform: `translateY(${virtualItem.start}px)` }}
						>
							{item.content}
						</div>
					);
				})}
			</div>
		</>
	);
}

export function shouldAdjustTranscriptScroll(
	itemEnd: number,
	scrollOffset: number,
): boolean {
	return itemEnd <= scrollOffset + 1;
}

export function virtualTranscriptRange(
	visible: number[],
	count: number,
	trailingMounted: number,
): number[] {
	const indexes = new Set(visible);
	const start = Math.max(0, count - Math.max(0, trailingMounted));
	for (let index = start; index < count; index++) indexes.add(index);
	return [...indexes].sort((a, b) => a - b);
}

function renderStaticItem(item: VirtualTranscriptItem) {
	return (
		<div key={item.key} data-eid={item.anchorId} className={item.className}>
			{item.content}
		</div>
	);
}
