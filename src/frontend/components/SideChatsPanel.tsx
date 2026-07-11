import React, { useCallback, useEffect, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { BASE_PATH } from "../lib/base";
import { relativeTime } from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { IconPlus, IconChevronRight } from "./icons";
import { SideChatConversation } from "./SideChatConversation";

interface SideChatsPanelProps {
	/** The MAIN session these side chats hang off. */
	sessionId: string;
	/** Insert @session:<id> into the MAIN composer. */
	onMention: (sessionId: string) => void;
	/** Non-zero → create (and open) a fresh side chat on show. The parent bumps
	 * this from its "New side chat" menu action; we call onCreateConsumed to
	 * reset it so a later tab remount doesn't create another. */
	createSeq?: number;
	onCreateConsumed?: () => void;
}

/**
 * The "Side chats" tab body. Lists a session's durable side chats and lets you
 * spawn new ones; opening one swaps the list for a live SideChatConversation
 * (breadcrumb-style, like the sub-agent panel). Side chats share the parent's
 * repo/model but run in ask mode and stay out of the main conversation until
 * @-mentioned back in.
 */
export function SideChatsPanel({
	sessionId,
	onMention,
	createSeq,
	onCreateConsumed,
}: SideChatsPanelProps) {
	const [chats, setChats] = useState<UnifiedSession[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [openId, setOpenId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(
				`${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/side-chats`,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { chats: UnifiedSession[] };
			setChats(data.chats || []);
			setError(null);
		} catch (e: any) {
			setError(e?.message || "Failed to load side chats");
			setChats([]);
		}
	}, [sessionId]);

	// Refetch on mount / session change. Reset any open conversation too.
	useEffect(() => {
		setOpenId(null);
		setChats(null);
		load();
	}, [sessionId, load]);

	async function createSideChat() {
		if (creating) return;
		setCreating(true);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/side-chat`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ user: getCurrentUser() }),
				},
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { id: string; session: UnifiedSession };
			await load();
			setOpenId(data.id);
		} catch (e: any) {
			setError(e?.message || "Failed to create side chat");
		} finally {
			setCreating(false);
		}
	}

	// Parent-requested creation (⋯ menu → "New side chat"). Consume the signal
	// before creating so a re-render or tab remount can't double-create.
	useEffect(() => {
		if (!createSeq) return;
		onCreateConsumed?.();
		void createSideChat();
		// createSideChat/onCreateConsumed are stable enough per mount; keying on
		// the seq alone keeps this from re-firing on unrelated renders.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [createSeq]);

	if (openId) {
		const open = chats?.find((c) => c.id === openId);
		return (
			<SideChatConversation
				sideChatId={openId}
				title={open?.title}
				onBack={() => {
					setOpenId(null);
					load();
				}}
				onMention={onMention}
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between border-b border-line px-3 py-2">
				<span className="text-[13px] font-semibold text-fg">Side chats</span>
				<button
					className="flex items-center gap-1 rounded-md bg-fg px-2 py-1 text-[12px] font-semibold text-panel disabled:opacity-40"
					onClick={createSideChat}
					disabled={creating}
				>
					<IconPlus size={20} />
					New side chat
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
				{error ? (
					<div className="mx-auto mt-6 max-w-[320px] text-center text-[13px] font-medium text-dim">
						{error}
					</div>
				) : chats === null ? (
					<div className="mt-6 text-center text-[13px] font-medium text-dim">
						Loading…
					</div>
				) : chats.length === 0 ? (
					<div className="mx-auto mt-6 max-w-[320px] text-center text-[13px] font-medium leading-relaxed text-dim">
						Ask questions and explore ideas without interrupting your main
						conversation. Side chats share this session's repo, and you can
						@-mention one to bring its context back into the main thread.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{chats.map((c) => (
							<button
								key={c.id}
								className="group flex items-center gap-2 rounded-md border border-line px-3 py-2 text-left hover:bg-surface"
								onClick={() => setOpenId(c.id)}
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">
											{c.title || "Side chat"}
										</span>
										{c.isRunning && (
											<span
												className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-green"
												title="Running"
											/>
										)}
									</div>
									<div className="mt-0.5 text-[12px] font-medium text-dim">
										{relativeTime(c.lastActivity || c.createdAt)}
									</div>
								</div>
								<IconChevronRight
									size={20}
									className="shrink-0 text-dim opacity-0 group-hover:opacity-100"
								/>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
