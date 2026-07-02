import React, { useEffect, useRef, useState } from "react";
import {
	ApiError,
	fetchTranscript,
	fetchWorkspaceOverview,
	type WorkspaceMediaItem,
	type WorkspaceOverview,
} from "../lib/api";
import type { TranscriptEntry } from "../lib/types";
import { IconImage } from "./icons";
import { Tooltip } from "../ui/tooltip";

/**
 * Floating overview panel on the top-left of the conversation: the workspace's
 * opening prompt + every screenshot/video from its chats, so switching
 * workspaces gives instant "what is this about" context. Collapsible to a
 * small pill (persisted per browser); hidden entirely when there's nothing to
 * show yet.
 *
 * Data comes from /api/workspaces/:id/overview; until the server has restarted
 * onto that route (routes don't hot-apply) it falls back to assembling the
 * same overview client-side from each chat's /transcript.
 */

interface ChatRef {
	id: string;
	title: string;
	createdAt: string;
}

interface Props {
	/** The chat's workspace (projectId); null = workspace-less (fallback only). */
	workspaceId: string | null;
	workspaceName?: string;
	/** Sibling chats, oldest first (the tab strip's list). */
	chats: ChatRef[];
	/** Media items currently in the open chat's live entries — bumps refresh
	    the panel as new screenshots land during a run. */
	liveMediaCount: number;
}

// Session-lifetime cache so switching back to a workspace paints instantly;
// a background refetch replaces it. Keyed by workspace (or the chat set).
const overviewCache = new Map<string, { data: WorkspaceOverview; at: number }>();

function firstPrompt(entries: TranscriptEntry[]): TranscriptEntry | undefined {
	return entries.find((e) => {
		const t = e.content?.trim() || "";
		return e.type === "user" && t.length > 0 && !t.startsWith("/");
	});
}

/** Same shape the server endpoint returns, built from raw transcripts (the
 * pre-restart fallback — data URLs render directly). */
async function buildClientOverview(chats: ChatRef[]): Promise<WorkspaceOverview> {
	const transcripts = await Promise.all(
		chats.map((c) =>
			fetchTranscript(c.id).catch(() => null as TranscriptEntry[] | null),
		),
	);
	let prompt: WorkspaceOverview["prompt"] = null;
	const media: WorkspaceMediaItem[] = [];
	chats.forEach((chat, i) => {
		const entries = transcripts[i];
		if (!entries) return;
		if (!prompt) {
			const first = firstPrompt(entries);
			if (first)
				prompt = { content: first.content, sessionId: chat.id, at: first.timestamp };
		}
		for (const e of entries) {
			for (const src of e.images || [])
				media.push({ kind: "image", src, sessionId: chat.id, chatTitle: chat.title, at: e.timestamp });
			for (const src of e.videos || [])
				media.push({ kind: "video", src, sessionId: chat.id, chatTitle: chat.title, at: e.timestamp });
		}
	});
	media.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
	return { prompt, media: media.slice(0, 100) };
}

export function WorkspacePreview({
	workspaceId,
	workspaceName,
	chats,
	liveMediaCount,
}: Props) {
	const chatsKey = chats.map((c) => c.id).join(",");
	const cacheKey = workspaceId || `chats:${chatsKey}`;
	const [data, setData] = useState<WorkspaceOverview | null>(
		() => overviewCache.get(cacheKey)?.data ?? null,
	);
	const [promptExpanded, setPromptExpanded] = useState(false);
	// Mirrors the workspace panel's default: open on desktop, collapsed on
	// phones (where it would cover most of the chat).
	const [open, setOpenState] = useState(() => {
		const stored = localStorage.getItem("michael-ws-preview-open");
		if (stored !== null) return stored === "true" && window.innerWidth > 920;
		return window.innerWidth > 920;
	});
	function setOpen(next: boolean) {
		setOpenState(next);
		localStorage.setItem("michael-ws-preview-open", String(next));
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
		async function load() {
			try {
				let ov: WorkspaceOverview;
				if (workspaceId) {
					try {
						ov = await fetchWorkspaceOverview(workspaceId);
					} catch (e) {
						// Server not restarted onto the overview route yet → assemble
						// client-side from the (long-standing) transcript route.
						if (e instanceof ApiError && e.status === 404)
							ov = await buildClientOverview(chatsRef.current);
						else throw e;
					}
				} else {
					ov = await buildClientOverview(chatsRef.current);
				}
				if (!alive) return;
				overviewCache.set(cacheKey, { data: ov, at: Date.now() });
				setData(ov);
			} catch {
				// Keep whatever we had — the panel just doesn't refresh.
			}
		}
		// Fresh cache → refresh quietly in the background after a beat (also
		// debounces the liveMediaCount bumps during a streaming run).
		const t = setTimeout(load, cached ? 1200 : 0);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [cacheKey, chatsKey, workspaceId, liveMediaCount]);

	if (!data || (!data.prompt && data.media.length === 0)) return null;

	if (!open) {
		return (
			<Tooltip label="Show workspace overview" side="right">
				<button
					className="absolute left-3 top-3 z-30 flex items-center gap-1.5 rounded-full border border-line bg-panel/95 px-2.5 py-1.5 text-xs text-dim shadow-md backdrop-blur-sm hover:text-fg"
					onClick={() => setOpen(true)}
					aria-label="Show workspace overview"
				>
					<IconImage size={15} />
					{data.media.length > 0 && <span>{data.media.length}</span>}
				</button>
			</Tooltip>
		);
	}

	return (
		<div className="absolute left-3 top-3 z-30 flex max-h-[46%] w-[300px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-lg border border-line bg-panel/95 shadow-lg backdrop-blur-sm">
			<div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
				<IconImage size={14} className="shrink-0 text-faint" />
				<span className="min-w-0 flex-1 truncate text-xs font-semibold text-dim">
					{workspaceName || "Overview"}
				</span>
				<Tooltip label="Hide overview" side="bottom">
					<button
						className="shrink-0 rounded-sm px-1 text-sm leading-none text-faint hover:text-fg"
						onClick={() => setOpen(false)}
						aria-label="Hide workspace overview"
					>
						–
					</button>
				</Tooltip>
			</div>
			<div className="min-h-0 overflow-y-auto px-3 pb-3">
				{data.prompt && (
					<div
						className="cursor-pointer"
						onClick={() => setPromptExpanded((v) => !v)}
						title={promptExpanded ? "Click to collapse" : "Click to expand"}
					>
						<div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-faint">
							Opening prompt
						</div>
						<div
							className={`whitespace-pre-wrap text-sm leading-snug text-fg ${
								promptExpanded ? "" : "line-clamp-4"
							}`}
						>
							{data.prompt.content}
						</div>
					</div>
				)}
				{data.media.length > 0 && (
					<div className={`grid grid-cols-3 gap-1.5 ${data.prompt ? "mt-2.5" : ""}`}>
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
										<span className="pointer-events-none absolute inset-0 grid place-items-center text-base text-white drop-shadow">
											▶
										</span>
									</>
								)}
							</a>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
