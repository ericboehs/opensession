import React, { useEffect, useRef, useState } from "react";
import { type WorkspaceOverview } from "../lib/api";
import {
	loadOverview,
	overviewCache,
	type OverviewChatRef,
} from "../lib/workspace-overview";
import { IconChevronDown } from "./icons";

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
}

export function WorkspaceInfo({
	workspaceId,
	workspaceName,
	chats,
	repo,
	liveMediaCount,
}: Props) {
	const chatsKey = chats.map((c) => c.id).join(",");
	const cacheKey = workspaceId || `chats:${chatsKey}`;
	const [data, setData] = useState<WorkspaceOverview | null>(
		() => overviewCache.get(cacheKey)?.data ?? null,
	);
	const [promptExpanded, setPromptExpanded] = useState(false);
	const [open, setOpenState] = useState(
		() => localStorage.getItem("michael-ws-info-open") !== "false",
	);
	function setOpen(next: boolean) {
		setOpenState(next);
		localStorage.setItem("michael-ws-info-open", String(next));
	}

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

	const hasBody = Boolean(data && (data.prompt || data.media.length > 0));

	return (
		<div className="border-b border-line px-3 pb-2.5 pt-2">
			<button
				className="flex w-full items-center gap-2 bg-transparent text-left"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				title={open ? "Collapse workspace info" : "Expand workspace info"}
			>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-semibold text-fg">
						{workspaceName || oldest?.title || "Workspace"}
					</span>
					{meta && (
						<span className="block truncate text-xs text-faint">{meta}</span>
					)}
				</span>
				<IconChevronDown
					size={15}
					className={`shrink-0 text-faint transition-transform ${open ? "" : "-rotate-90"}`}
				/>
			</button>
			{open && hasBody && data && (
				<div className="mt-2">
					{data.prompt && (
						<div
							className="cursor-pointer"
							onClick={() => {
								// Selecting text inside also fires click — don't collapse
								// the prompt out from under a selection.
								if (window.getSelection()?.isCollapsed !== false)
									setPromptExpanded((v) => !v);
							}}
							title={promptExpanded ? "Click to collapse" : "Click to expand"}
						>
							<div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
								Opening prompt
							</div>
							<div
								className={`selectable whitespace-pre-wrap text-sm leading-snug text-dim ${
									promptExpanded ? "" : "line-clamp-3"
								}`}
							>
								{data.prompt.content}
							</div>
						</div>
					)}
					{data.lastMessage && (
						<div className="mt-2">
							<div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
								Latest reply
							</div>
							<div className="selectable line-clamp-2 whitespace-pre-wrap text-sm leading-snug text-dim">
								{data.lastMessage.content}
							</div>
						</div>
					)}
					{data.media.length > 0 && (
						<div className="mt-2 grid max-h-44 grid-cols-4 gap-1.5 overflow-y-auto">
							{data.media.map((m, i) => (
								<a
									key={`${m.sessionId}:${m.at}:${i}`}
									href={m.src}
									target="_blank"
									rel="noopener noreferrer"
									className="relative block aspect-square overflow-hidden rounded-sm border border-line bg-surface"
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
								</a>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
