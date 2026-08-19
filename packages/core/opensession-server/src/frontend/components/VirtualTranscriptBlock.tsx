import React, { useEffect, useRef, useState } from "react";
import { cn } from "../ui/cn";

/**
 * Turn-level windowing with measured placeholders. Recent turns stay mounted;
 * older settled turns render within a 1.5-viewport overscan and preserve their
 * exact measured height outside it, so scroll anchors remain stable.
 *
 * `content-visibility: auto` brings layout and paint containment with it, so
 * this box CLIPS anything its block reaches outside of: a negative margin onto
 * the block above, an overhanging shadow. Nothing inside a block may do that.
 * A block that overlaps its neighbour says so with `className`, which lands on
 * this wrapper, where a margin is a margin rather than overflow.
 */
export const VirtualTranscriptBlock = React.memo(function VirtualTranscriptBlock({
	children,
	enabled,
	anchorId,
	className,
}: {
	children: React.ReactNode;
	enabled: boolean;
	anchorId: string;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	// A history page can extend one old turn by hundreds of steps. Start an
	// offscreen block as its placeholder so that prepend never constructs the
	// growing subtree once just to have the observer hide it on the next frame.
	// SSR and browsers without IntersectionObserver keep the complete content.
	const [visible, setVisible] = useState(
		() => !enabled || typeof IntersectionObserver === "undefined",
	);
	const heightRef = useRef(96);

	useEffect(() => {
		const node = ref.current;
		if (!node || !enabled || typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const root = node.closest(".viewer-messages");
		const resize = new ResizeObserver(([entry]) => {
			if (entry?.contentRect.height) heightRef.current = entry.contentRect.height;
		});
		resize.observe(node);
		const intersection = new IntersectionObserver(
			([entry]) => setVisible(Boolean(entry?.isIntersecting)),
			{ root, rootMargin: "150% 0px" },
		);
		intersection.observe(node);
		return () => {
			resize.disconnect();
			intersection.disconnect();
		};
	}, [enabled]);

	if (enabled && !visible) {
		return (
			<div
				ref={ref}
				className={cn("pointer-events-none", className)}
				data-eid={anchorId}
				aria-hidden
				style={{ height: heightRef.current }}
			/>
		);
	}

	return (
		<div
			ref={ref}
			// Settled turns get skipped during layout/paint while off-screen, at
			// their measured height.
			className={cn(
				enabled && "[content-visibility:auto] [contain-intrinsic-size:auto_96px]",
				className
			)}
		>
			{children}
		</div>
	);
});
