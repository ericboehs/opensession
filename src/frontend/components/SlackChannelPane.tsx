import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useRef, useState } from "react";

interface ChannelMessage {
	ts: string;
	userName: string;
	avatarUrl?: string;
	text: string;
	isBot: boolean;
	replyCount?: number;
}

/**
 * The Conversation pane for slack-channel feed workspaces (the Plain-thread
 * sibling): channel messages newest page first with "Load earlier" pagination
 * (same affordance as the transcript's Load history), 20s poll for new ones,
 * and a composer that posts AS THE SIGNED-IN USER via their Slack grant
 * (routes/slack-channels.ts; no grant → the composer explains how to
 * connect). Top-level messages only for now — threads via Slack ↗.
 */
export function SlackChannelPane({
	channelId,
	className,
}: {
	channelId: string;
	className?: string;
}) {
	const [messages, setMessages] = useState<ChannelMessage[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [asUser, setAsUser] = useState(true);
	const [loading, setLoading] = useState(true);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const aliveRef = useRef(true);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const stickBottomRef = useRef(true);

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	const loadNewest = useCallback(async () => {
		try {
			const res = await fetch(
				`${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages`,
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			if (!aliveRef.current) return;
			setAsUser(!!body.asUser);
			setHasMore((prev) => prev || !!body.hasMore);
			setMessages((prev) => {
				// Merge: keep already-loaded older pages, replace the newest span.
				const incoming: ChannelMessage[] = body.messages || [];
				if (!prev.length) return incoming;
				const oldestIncoming = incoming[0]?.ts;
				const olders = prev.filter(
					(m) => oldestIncoming && m.ts < oldestIncoming,
				);
				return [...olders, ...incoming];
			});
			setError(null);
		} catch (e: any) {
			if (aliveRef.current) setError(e.message);
		} finally {
			if (aliveRef.current) setLoading(false);
		}
	}, [channelId]);

	useEffect(() => {
		setMessages([]);
		setLoading(true);
		void loadNewest();
		const t = setInterval(loadNewest, 20_000);
		return () => clearInterval(t);
	}, [loadNewest]);

	// Stick to the bottom on new messages unless the user scrolled up.
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
	}, [messages]);

	async function loadOlder() {
		if (!messages.length || loadingOlder) return;
		setLoadingOlder(true);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages?before=${encodeURIComponent(messages[0].ts)}`,
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			const el = scrollRef.current;
			const prevHeight = el?.scrollHeight || 0;
			stickBottomRef.current = false;
			setMessages((prev) => [...(body.messages || []), ...prev]);
			setHasMore(!!body.hasMore);
			// Keep the viewport anchored on the previously-oldest message.
			requestAnimationFrame(() => {
				if (el) el.scrollTop = el.scrollHeight - prevHeight;
			});
		} catch (e: any) {
			setError(e.message);
		} finally {
			setLoadingOlder(false);
		}
	}

	async function send() {
		const text = draft.trim();
		if (!text || sending) return;
		setSending(true);
		setError(null);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setDraft("");
			stickBottomRef.current = true;
			void loadNewest();
		} catch (e: any) {
			setError(e.message);
		} finally {
			setSending(false);
		}
	}

	const timeOf = (ts: string) => {
		const d = new Date(Number(ts) * 1000);
		const today = new Date().toDateString() === d.toDateString();
		return today
			? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: d.toLocaleDateString([], { month: "short", day: "numeric" }) +
					" " +
					d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	};

	return (
		<div className={`flex h-full min-h-0 flex-col ${className || ""}`}>
			<div
				ref={scrollRef}
				className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
				onScroll={(e) => {
					const el = e.currentTarget;
					stickBottomRef.current =
						el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				{hasMore && (
					<div className="mb-3 flex justify-center">
						<button
							className="rounded-md border border-line px-3 py-1 text-xs font-medium text-dim hover:border-faint hover:text-fg disabled:opacity-50"
							onClick={loadOlder}
							disabled={loadingOlder}
						>
							{loadingOlder ? "Loading…" : "Load earlier messages"}
						</button>
					</div>
				)}
				{loading ? (
					<div className="py-8 text-center text-sm text-faint">
						Loading channel…
					</div>
				) : messages.length === 0 ? (
					<div className="py-8 text-center text-sm text-faint">
						No recent messages.
					</div>
				) : (
					messages.map((m) => (
						<div key={m.ts} className="mb-3 flex gap-2.5">
							{m.avatarUrl ? (
								<img
									src={m.avatarUrl}
									alt=""
									className="mt-0.5 h-7 w-7 flex-shrink-0 rounded-md"
								/>
							) : (
								<span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-active text-xs font-semibold text-dim">
									{m.userName.charAt(0).toUpperCase()}
								</span>
							)}
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline gap-2">
									<span className="text-[13px] font-semibold text-fg">
										{m.userName}
									</span>
									<span className="text-[11px] text-faint">{timeOf(m.ts)}</span>
								</div>
								<div className="whitespace-pre-wrap break-words text-[13.5px] leading-snug text-fg">
									{m.text}
								</div>
								{(m.replyCount || 0) > 0 && (
									<div className="mt-0.5 text-[11.5px] text-dim">
										{m.replyCount} repl{m.replyCount === 1 ? "y" : "ies"} — open
										in Slack to view
									</div>
								)}
							</div>
						</div>
					))
				)}
			</div>
			{error && (
				<div className="border-t border-line px-4 py-2 text-xs text-red">
					{error}
				</div>
			)}
			<div className="border-t border-line p-3">
				<div className="flex items-end gap-2">
					<textarea
						className="max-h-32 min-h-[38px] w-full resize-none rounded-md border border-line bg-surface px-3 py-2 text-[13.5px] text-fg outline-none focus:border-faint"
						placeholder={
							asUser
								? "Message the channel as yourself…"
								: "Connect Slack in Settings → My accounts to post as yourself"
						}
						value={draft}
						disabled={!asUser || sending}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void send();
							}
						}}
						rows={1}
					/>
					<button
						className="flex-shrink-0 rounded-md bg-accent px-4 py-2 text-[13.5px] font-semibold text-white disabled:opacity-40"
						onClick={send}
						disabled={!asUser || !draft.trim() || sending}
					>
						Send
					</button>
				</div>
			</div>
		</div>
	);
}
