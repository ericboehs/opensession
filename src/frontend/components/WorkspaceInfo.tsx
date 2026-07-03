import React, { useEffect, useRef, useState } from "react";
import { type WorkspaceMediaItem, type WorkspaceOverview } from "../lib/api";
import {
	loadOverview,
	overviewCache,
	type OverviewChatRef,
} from "../lib/workspace-overview";
import { openLightbox } from "./MediaLightbox";

/**
 * Workspace info block at the top of the right side panel (above the
 * Changes/Terminal/PR toolbar): name + meta (repo, chat count, who/when),
 * the opening prompt, the latest reply, and every screenshot/video from the
 * workspace's chats — so opening the panel answers "what is this workspace
 * about" at a glance. Collapsible to the header row (persisted per browser).
 *
 * Loading/caching lives in lib/workspace-overview (shared with the sidebar's
 * workspace hover card), including the pre-restart transcript fallbacks.
 */

interface Props {
	/** The chat's workspace (projectId); null = workspace-less (fallback only). */
	workspaceId: string | null;
	workspaceName?: string;
	/** Sibling chats, oldest first (the tab strip's list). */
	chats: Array<OverviewChatRef & { startedBy?: string | null }>;
	/** Primary repo the workspace's chats work in. */
	repo?: string;
	/** Media items currently in the open chat's live entries — bumps refresh
	    the panel as new screenshots land during a run. */
	liveMediaCount: number;
	/** Images visible in the chat UI before the transcript-backed overview catches up. */
	liveMedia?: WorkspaceMediaItem[];
}

export function WorkspaceInfo({
	workspaceId,
	workspaceName,
	chats,
	repo,
	liveMediaCount,
	liveMedia = [],
}: Props) {
	const chatsKey = chats.map((c) => c.id).join(",");
	const cacheKey = workspaceId || `chats:${chatsKey}`;
	const [data, setData] = useState<WorkspaceOverview | null>(
		() => overviewCache.get(cacheKey)?.data ?? null,
	);
	const [promptExpanded, setPromptExpanded] = useState(false);

	// The chats array is re-created every App render — read it through a ref so
	// the fetch effect keys on the stable chatsKey instead.
	const chatsRef = useRef(chats);
	chatsRef.current = chats;

	useEffect(() => {
		let alive = true;
		const cached = overviewCache.get(cacheKey);
		setData(cached?.data ?? null);
		setPromptExpanded(false);
		// Fresh cache → refresh quietly in the background after a beat (also
		// debounces the liveMediaCount bumps during a streaming run).
		const t = setTimeout(
			() => {
				loadOverview(cacheKey, workspaceId, chatsRef.current)
					.then((ov) => {
						if (alive) setData(ov);
					})
					.catch(() => {
						// Keep whatever we had — the block just doesn't refresh.
					});
			},
			cached ? 1200 : 0,
		);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [cacheKey, chatsKey, workspaceId, liveMediaCount]);

	const oldest = chats[0];
	const started = oldest?.createdAt
		? new Date(oldest.createdAt).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			})
		: null;
	const meta = [
		repo,
		`${chats.length} chat${chats.length === 1 ? "" : "s"}`,
		oldest?.startedBy ? `by ${oldest.startedBy}` : null,
		started,
	]
		.filter(Boolean)
		.join(" · ");

	const hasBody = Boolean(
		(data && (data.prompt || data.lastMessage || data.media.length > 0)) ||
			liveMedia.length > 0,
	);
	const title = workspaceName || oldest?.title || "Untitled chat";
	const media = [...liveMedia, ...(data?.media || [])].filter(
		(m, i, all) =>
			all.findIndex(
				(x) =>
					x.kind === m.kind &&
					x.src === m.src &&
					x.sessionId === m.sessionId,
			) === i,
	);

	return (
		<div className="workspace-info-panel">
			<div className="workspace-info-head">
				<div className="workspace-info-kicker">Info</div>
				<div className="workspace-info-title">{title}</div>
				{meta && <div className="workspace-info-meta">{meta}</div>}
			</div>
			{hasBody ? (
				<div className="workspace-info-body">
					{media.length > 0 && (
						<div className="workspace-info-media">
							{media.map((m, i) => (
								<button
									key={`${m.sessionId}:${m.at}:${i}`}
									type="button"
									onClick={() => openLightbox(media, i)}
									className="workspace-info-thumb"
									title={[m.chatTitle, new Date(m.at).toLocaleString()]
										.filter(Boolean)
										.join(" · ")}
								>
									{m.kind === "image" ? (
										<img
											src={m.src}
											alt=""
											loading="lazy"
											className="h-full w-full object-cover"
										/>
									) : (
										<>
											<video
												src={m.src}
												muted
												playsInline
												preload="metadata"
												className="h-full w-full object-cover"
											/>
											<span className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white drop-shadow">
												▶
											</span>
										</>
									)}
								</button>
							))}
						</div>
					)}
					{data?.prompt && (
						<div
							className="workspace-info-section cursor-pointer"
							onClick={() => {
								// Selecting text inside also fires click — don't collapse
								// the prompt out from under a selection.
								if (window.getSelection()?.isCollapsed !== false)
									setPromptExpanded((v) => !v);
							}}
							title={promptExpanded ? "Click to collapse" : "Click to expand"}
						>
							<div className="workspace-info-label">
								Opening prompt
							</div>
							<div
								className={`workspace-info-text selectable whitespace-pre-wrap ${
									promptExpanded ? "" : "line-clamp-3"
								}`}
							>
								{data.prompt.content}
							</div>
						</div>
					)}
					{data?.lastMessage && (
						<div className="workspace-info-section">
							<div className="workspace-info-label">Summary</div>
							<div className="workspace-info-text selectable line-clamp-4 whitespace-pre-wrap">
								{data.lastMessage.content}
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="workspace-info-empty">No overview yet.</div>
			)}
		</div>
	);
}
