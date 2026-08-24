import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import React, { useEffect, useRef } from "react";
import {
	registerTranscriptVirtualNavigation,
	type TranscriptVirtualNavigation,
} from "../lib/transcript-virtual-navigation";
import { cn } from "../ui/cn";

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
}

/** Loaded transcript blocks, windowed against their nearest message scroller. */
export function VirtualTranscriptList({
	items,
	trailingMounted,
	onVisibleItems,
	enabled = true,
}: Props) {
	const rootRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: items.length,
		getScrollElement: () =>
			rootRef.current?.closest<HTMLDivElement>(".viewer-messages") ?? null,
		estimateSize: (index) => items[index]?.estimateSize ?? 96,
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
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
				data-virtual-transcript
				data-virtual-count={items.length}
				data-transcript-blocks={items.length}
			>
				{virtualItems.map((virtualItem) => {
					const item = items[virtualItem.index];
					if (!item) return null;
					return (
						<div
							key={item.key}
							ref={item.measure === false ? undefined : virtualizer.measureElement}
							data-index={virtualItem.index}
							data-eid={item.anchorId}
							className={cn("absolute left-0 top-0 w-full", item.className)}
							style={{ transform: `translateY(${virtualItem.start}px)` }}
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
