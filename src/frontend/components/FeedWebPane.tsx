import React from "react";
import type { ExternalRef } from "../lib/types";

/**
 * The generic web panel for feed-item workspaces (docs/feeds-design.md): a
 * full-width iframe of the item's embeddable page with escape-hatch links to
 * the real thing. Rendered as the Video view-tab of Tella-backed workspaces
 * (and by WorkspacePane on their chat-less route).
 *
 * Per-kind knowledge (which URL embeds, which links to offer) lives in
 * refWebPanel below — the Phase-1 panel registry candidate. Tella's view/edit
 * pages send `frame-ancestors 'none'`, so the embed page is what iframes;
 * Editor opens in a new tab until tella-fusion grows a frame-ancestors
 * carve-out for os.tella.dev.
 */

export interface RefWebPanel {
	/** Tab label ("Video"). */
	label: string;
	/** The iframe-able URL. */
	embedUrl: string;
	/** External links rendered in the pane header. */
	links: { label: string; href: string }[];
}

/** The web panel spec for a ref, or null when the kind has none. */
export function refWebPanel(ref: ExternalRef): RefWebPanel | null {
	if (ref.kind === "tella") {
		return {
			label: "Video",
			embedUrl: `https://www.tella.tv/video/${encodeURIComponent(ref.id)}/embed`,
			links: [
				{ label: "Open editor", href: `https://www.tella.tv/video/${encodeURIComponent(ref.id)}/edit` },
				{ label: "View page", href: ref.url || `https://www.tella.tv/video/${encodeURIComponent(ref.id)}/view` },
			],
		};
	}
	return null;
}

export function FeedWebPane({
	panel,
	title,
	className,
}: {
	panel: RefWebPanel;
	title?: string;
	className?: string;
}) {
	return (
		<div className={`flex h-full min-h-0 flex-col ${className || ""}`}>
			<div className="flex items-center gap-3 border-b border-line px-3 py-2">
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
					{title || panel.label}
				</span>
				{panel.links.map((l) => (
					<a
						key={l.href}
						href={l.href}
						target="_blank"
						rel="noreferrer"
						className="whitespace-nowrap text-xs font-medium text-dim hover:text-fg"
					>
						{l.label} ↗
					</a>
				))}
			</div>
			<iframe
				src={panel.embedUrl}
				title={title || panel.label}
				className="min-h-0 w-full flex-1 border-0 bg-black"
				allow="fullscreen; autoplay; clipboard-write"
			/>
		</div>
	);
}
