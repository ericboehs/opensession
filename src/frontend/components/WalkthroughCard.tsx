import React, { useMemo, useState } from "react";
import type { SessionWalkthrough } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";

/** Stream server-side media (staged under the uploads dir) through the
 *  existing scoped media route — same URL shape MessageBubble uses. */
const mediaUrl = (path: string) => `/media?path=${encodeURIComponent(path)}`;

/**
 * The agent-published walkthrough (opensession-walkthrough): demo video +
 * before/after screenshot pairs + writeup. Rendered at the top of the PR info
 * column in the Review tab — the inline counterpart of the link-only section
 * mirrored into the GitHub PR description.
 */
export function WalkthroughCard({ walkthrough }: { walkthrough: SessionWalkthrough }) {
	const summaryHtml = useMemo(
		() => renderMarkdown(walkthrough.summary),
		[walkthrough.summary],
	);
	const [lightbox, setLightbox] = useState<string | null>(null);

	return (
		<div className="mb-3 rounded-lg border border-line bg-panel p-3">
			<div className="mb-2 text-xs font-semibold uppercase tracking-wide text-dim">
				Walkthrough
			</div>
			{walkthrough.video && (
				<video
					className="mb-2 w-full rounded-md border border-line bg-black"
					src={mediaUrl(walkthrough.video)}
					controls
					preload="metadata"
					title={walkthrough.videoTitle || "Demo video"}
				/>
			)}
			<div
				className="markdown text-[13px]"
				dangerouslySetInnerHTML={{ __html: summaryHtml }}
			/>
			{(walkthrough.shots || []).map((shot, i) => (
				<div className="mt-3" key={i}>
					{shot.caption && (
						<div className="mb-1 text-xs text-dim">{shot.caption}</div>
					)}
					<div className="flex gap-2">
						{(["before", "after"] as const).map(
							(side) =>
								shot[side] && (
									<figure className="m-0 min-w-0 flex-1" key={side}>
										<figcaption className="mb-1 text-[11px] font-medium uppercase tracking-wide text-dim">
											{side === "before" ? "Before" : "After"}
										</figcaption>
										<img
											className="w-full cursor-zoom-in rounded-md border border-line"
											src={mediaUrl(shot[side]!)}
											alt={`${shot.caption || "change"} — ${side}`}
											loading="lazy"
											onClick={() => setLightbox(shot[side]!)}
										/>
									</figure>
								),
						)}
					</div>
				</div>
			))}
			{lightbox && (
				<div
					className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-8"
					onClick={() => setLightbox(null)}
				>
					<img
						className="max-h-full max-w-full rounded-md shadow-lg"
						src={mediaUrl(lightbox)}
						alt="walkthrough screenshot"
					/>
				</div>
			)}
		</div>
	);
}
