import React, { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { useWebSocket } from "../hooks/useWebSocket";
import { getCurrentUser } from "./UserPicker";
import { renderMarkdown } from "../lib/markdown";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { IconChevronLeft, IconAtSign, IconArrowUp } from "./icons";

/** Reconcile incoming entries by id (mirror of SessionViewer's local helper). */
function mergeEntries(
	prev: TranscriptEntry[],
	incoming: TranscriptEntry[],
): TranscriptEntry[] {
	if (incoming.length === 0) return prev;
	const indexById = new Map(prev.map((e, i) => [e.id, i] as const));
	const next = [...prev];
	for (const entry of incoming) {
		const idx = indexById.get(entry.id);
		if (idx !== undefined) next[idx] = entry;
		else {
			indexById.set(entry.id, next.length);
			next.push(entry);
		}
	}
	return next;
}

interface SideChatConversationProps {
	sideChatId: string;
	/** Return to the list. */
	onBack: () => void;
	/** Insert @session:<id> into the MAIN composer. Omitted by hosts with no
	 *  main composer (the Desk overlay) — hides the Mention button. */
	onMention?: (sessionId: string) => void;
	/** The side chat's title (from the parent panel's list) — header label. */
	title?: string;
	/** Host renders its own chrome (the Desk overlay) — skip the header row. */
	hideHeader?: boolean;
	/** Replaces the side-chat empty-state copy. */
	emptyState?: React.ReactNode;
	/** Composer placeholder (default "Ask this side chat…"). */
	placeholder?: string;
	/** Reasoning effort sent with each prompt (default "high"). The Desk
	 *  passes "low" — concierge turns should feel instant. */
	effort?: string;
	/** Hide entries at or before this ISO timestamp (the Desk's "Clear"
	 *  marker). Display-only — the transcript itself is untouched. */
	hideBefore?: string;
}

/**
 * Live conversation view for ONE side chat, hosted inside the parent session's
 * right panel. Runs on its OWN useWebSocket() instance (a SECOND socket) so
 * watching the side chat never unwatches the main thread — the WS hub is
 * one-socket-one-session. Reuses TranscriptBlocks so markdown/tool rendering is
 * identical to the main view.
 */
export function SideChatConversation({
	sideChatId,
	onBack,
	onMention,
	title,
	hideHeader,
	emptyState,
	placeholder,
	effort,
	hideBefore,
}: SideChatConversationProps) {
	const { connected, send, addHandler } = useWebSocket();
	const [entries, setEntries] = useState<TranscriptEntry[]>([]);
	const [streamText, setStreamText] = useState("");
	const [isRunning, setIsRunning] = useState(false);
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState<string | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	// Stick to the live edge only while the reader is already there, so a
	// streaming reply doesn't yank them up from scrollback.
	const followRef = useRef(true);
	const streamSeqRef = useRef(0);

	// Second socket: watch this side chat only, and tear it down on unmount /
	// id change. transcript_init resets, everything else merges — all gated to
	// this sideChatId (the hub also tags session-scoped messages).
	useEffect(() => {
		if (!connected) return;
		setEntries([]);
		setStreamText("");
		setPending(null);
		followRef.current = true;
		send({ type: "watch", sessionId: sideChatId, user: getCurrentUser() });

		const unsubscribe = addHandler((msg) => {
			if ("sessionId" in msg && msg.sessionId && msg.sessionId !== sideChatId)
				return;
			switch (msg.type) {
				case "transcript_init":
					setEntries(msg.entries);
					break;
				case "transcript_append": {
					setEntries((prev) => mergeEntries(prev, msg.entries));
					if (msg.entries.some((e) => e.type === "user")) setPending(null);
					const landed = msg.entries.filter(
						(e) => e.type === "assistant" && e.content,
					);
					if (landed.length) {
						setStreamText((prev) => {
							let next = prev;
							for (const e of landed) next = next.replace(e.content, "");
							return next.trim() ? next : "";
						});
					}
					break;
				}
				case "session_status":
					setIsRunning(msg.isRunning);
					break;
				case "stream_start":
					streamSeqRef.current++;
					setIsRunning(true);
					setStreamText("");
					setPending(null);
					break;
				case "stream_text":
					setStreamText((prev) => prev + msg.text);
					break;
				case "stream_tool_use":
				case "stream_tool_result":
					setEntries((prev) => mergeEntries(prev, [msg.entry]));
					break;
				case "stream_done": {
					const seq = streamSeqRef.current;
					window.setTimeout(() => {
						if (streamSeqRef.current === seq) setStreamText("");
					}, 5000);
					break;
				}
				// A slash-command reply / server heads-up. Weave it in as a system
				// line so it reads inline with the conversation (mirrors SessionViewer).
				case "notice":
					setEntries((prev) => [
						...prev,
						{
							id: crypto.randomUUID(),
							type: "system",
							content: msg.message,
							timestamp: new Date().toISOString(),
						},
					]);
					break;
				// A failed/aborted run. Without this the panel just stops silently —
				// surface the error where the reply would have been and clear any
				// streaming/sending state so nothing sticks (mirrors SessionViewer).
				case "error":
					streamSeqRef.current++;
					setIsRunning(false);
					setStreamText("");
					setPending(null);
					if (msg.message) {
						setEntries((prev) => [
							...prev,
							{
								id: crypto.randomUUID(),
								type: "system",
								content: `⚠ Run failed: ${msg.message}`,
								timestamp: new Date().toISOString(),
							},
						]);
					}
					break;
			}
		});

		return () => {
			unsubscribe();
			send({ type: "unwatch", sessionId: sideChatId });
		};
	}, [connected, sideChatId, send, addHandler]);

	// Keep a following reader pinned to the live edge as content lands.
	useEffect(() => {
		const el = bodyRef.current;
		if (el && followRef.current) el.scrollTop = el.scrollHeight;
	}, [entries, streamText, pending]);

	function onScroll() {
		const el = bodyRef.current;
		if (!el) return;
		followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	}

	function handleSend() {
		const content = draft.trim();
		if (!content || !connected) return;
		// Slash commands (/model, /loop, /goal, …) are handled by the main
		// session's command system, which this compact composer deliberately
		// doesn't wire up. Sent as a plain prompt they produce no turn, so the
		// optimistic "sending…" bubble below would never reconcile and stick
		// forever. Surface an inline hint instead — the input isn't silently
		// eaten, and no bubble is left dangling.
		if (content.startsWith("/")) {
			setEntries((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					type: "system",
					content:
						"Slash commands aren't supported in side chats — run them from the main conversation.",
					timestamp: new Date().toISOString(),
				},
			]);
			setDraft("");
			return;
		}
		send({
			type: "prompt",
			sessionId: sideChatId,
			content,
			user: getCurrentUser(),
			effort: effort || "high",
		});
		setPending(content);
		setDraft("");
		followRef.current = true;
	}

	// The Desk's "Clear" marker: everything at/before it stays out of this view
	// (locally-minted system lines have fresh timestamps and survive).
	const visibleEntries = hideBefore
		? entries.filter((e) => !e.timestamp || e.timestamp > hideBefore)
		: entries;
	const hasContent = visibleEntries.length > 0 || !!streamText || !!pending;

	return (
		<div className="flex h-full min-h-0 flex-col">
			{!hideHeader && (
				<div className="flex items-center gap-2 border-b border-line px-3 py-2">
					<button
						className="flex items-center rounded-md p-1 text-dim hover:bg-surface hover:text-fg"
						onClick={onBack}
						aria-label="Back to side chats"
					>
						<IconChevronLeft size={20} />
					</button>
					<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">
						{title || "Side chat"}
					</span>
					{isRunning && (
						<span
							className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-green"
							title="Running"
						/>
					)}
					{onMention && (
						<button
							className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[12px] font-medium text-dim hover:bg-surface hover:text-fg"
							onClick={() => onMention(sideChatId)}
							title="Mention this side chat in the main thread"
						>
							<IconAtSign size={20} />
							Mention
						</button>
					)}
				</div>
			)}

			<div
				className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
				ref={bodyRef}
				onScroll={onScroll}
			>
				{!hasContent ? (
					<div className="mx-auto mt-6 max-w-[320px] text-center text-[13px] font-medium leading-relaxed text-dim">
						{emptyState ??
							"Ask this side chat anything — it shares this session's repo but runs read-only, and won't touch your main conversation."}
					</div>
				) : (
					<>
						<TranscriptBlocks entries={visibleEntries} live={isRunning} />
						{streamText && (
							<div className="msg msg-assistant msg-streaming">
								<div
									className="msg-body msg-body-assistant markdown"
									dangerouslySetInnerHTML={{ __html: renderMarkdown(streamText) }}
								/>
							</div>
						)}
						{/* Optimistic echo of the just-sent message — rendered as a normal
						    sent bubble (not the dimmed "sending" look) so it reads as
						    delivered the instant Enter lands; reconciles away when the
						    real user entry arrives. */}
						{pending && (
							<div className="msg msg-user">
								<div className="msg-body msg-body-user">{pending}</div>
							</div>
						)}
					</>
				)}
			</div>

			<div className="flex items-end gap-2 border-t border-line px-3 py-2">
				<textarea
					className="max-h-40 min-h-[36px] flex-1 resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] font-medium text-fg outline-none placeholder:text-dim focus:border-fg/30"
					rows={1}
					value={draft}
					placeholder={
						connected ? placeholder || "Ask this side chat…" : "Not connected"
					}
					disabled={!connected}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							handleSend();
						}
					}}
				/>
				<button
					className="flex shrink-0 items-center justify-center rounded-md bg-fg p-1.5 text-panel disabled:opacity-40"
					onClick={handleSend}
					disabled={!connected || !draft.trim()}
					aria-label="Send"
				>
					<IconArrowUp size={20} />
				</button>
			</div>
		</div>
	);
}
