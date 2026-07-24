import React, { useMemo, useState } from "react";
import type { SessionWalkthrough } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { relativeTime } from "../lib/api";
import { cn } from "../ui/cn";

/** Stream server-side media (staged under the uploads dir) through the
 *  existing scoped media route — same URL shape MessageBubble uses. */
const mediaUrl = (path: string) => `/media?path=${encodeURIComponent(path)}`;

/**
 * The agent-published walkthrough (opensession-walkthrough): demo video +
 * before/after screenshot pairs + writeup. Rendered at the top of the PR info
 * column in the Review tab (`panel`), and inline in the chat where the agent
 * published it (`chat`) — the video plays right there instead of only living
 * behind a tab. Both are the inline counterpart of the link-only section
 * mirrored into the GitHub PR description.
 */
export function WalkthroughCard({
	walkthrough,
	variant = "panel",
}: {
	walkthrough: SessionWalkthrough;
	variant?: "panel" | "chat";
}) {
	const summaryHtml = useMemo(
		() => renderMarkdown(walkthrough.summary),
		[walkthrough.summary],
	);
	const [lightbox, setLightbox] = useState<string | null>(null);
	const chat = variant === "chat";

	return (
		<div
			className={cn(
				"rounded-lg border border-line bg-panel p-3",
				chat ? "my-2" : "mb-3",
			)}
		>
			<div className="mb-2 flex items-baseline gap-2">
				<span className="text-xs font-semibold uppercase tracking-wide text-dim">
					Walkthrough
				</span>
				{chat && walkthrough.publishedAt && (
					<span className="text-[11px] text-faint">
						{relativeTime(walkthrough.publishedAt)}
					</span>
				)}
			</div>
			{walkthrough.video && (
				<>
					<video
						className={cn(
							"w-full rounded-md border border-line bg-black",
							chat ? "max-h-[60vh] object-contain" : "",
						)}
						src={mediaUrl(walkthrough.video)}
						controls
						preload="metadata"
						title={walkthrough.videoTitle || "Demo video"}
					/>
					{chat && walkthrough.videoTitle ? (
						<div className="mb-2 mt-1 text-[11px] text-faint">
							{walkthrough.videoTitle}
						</div>
					) : (
						<div className="mb-2" />
					)}
				</>
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
											className={cn(
												"w-full cursor-zoom-in rounded-md border border-line",
												// In the chat the card sits in the message flow, so
												// cap the stills (full size lives one click away in
												// the lightbox) instead of pushing the conversation
												// down by a screenful per pair.
												chat && "max-h-52 object-contain object-top",
											)}
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
