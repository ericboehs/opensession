import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TodoItem, UnifiedSession, WSServerMessage } from "../lib/types";
import { BASE_PATH } from "../lib/base";
import { getCurrentUser } from "./UserPicker";
import { SideChatConversation } from "./SideChatConversation";
import { Modal } from "../ui/modal";
import { BottomSheet } from "../ui/sheet";
import {
	IconCheck,
	IconDesk,
	IconExpand,
	IconX,
} from "./icons";

/**
 * The Desk — a summonable overlay (⌘J / the floating desk button) on top of
 * whatever you're doing: your todo list up top, your standing concierge
 * session below. Quick capture, quick asks, then leave. The chat is a normal
 * durable session (desk: true, hidden from the session lists) driven through
 * SideChatConversation's scoped second socket; the todo list is the store
 * behind the opensession-todos tools every interactive session carries, so
 * items added from any conversation appear here live (todos_changed).
 */

interface DeskOverlayProps {
	open: boolean;
	onClose: () => void;
	phone: boolean;
	/** App's shared socket — Desk listens for todos_changed on it. */
	addHandler: (h: (msg: WSServerMessage) => void) => () => void;
	/** Open a session in the full viewer (expand button, todo provenance). */
	onOpenSession: (sessionId: string) => void;
}

function TodoRow({
	todo,
	onToggle,
	onDrop,
	onOpenSession,
}: {
	todo: TodoItem;
	onToggle: (t: TodoItem) => void;
	onDrop: (t: TodoItem) => void;
	onOpenSession: (sessionId: string) => void;
}) {
	const done = todo.status === "done";
	return (
		<div className="group flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface">
			<button
				className={
					"mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors " +
					(done
						? "border-green bg-green text-panel"
						: "border-line-strong text-transparent hover:border-fg/50")
				}
				onClick={() => onToggle(todo)}
				aria-label={done ? "Reopen" : "Mark done"}
			>
				<IconCheck size={20} className="h-[13px] w-[13px]" />
			</button>
			<div className="min-w-0 flex-1">
				<div
					className={
						"text-[13px] font-medium leading-snug " +
						(done ? "text-dim line-through" : "text-fg")
					}
				>
					{todo.text}
				</div>
				{(todo.note || todo.due || todo.source.sessionId) && (
					<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] font-medium text-faint">
						{todo.due && <span>due {todo.due}</span>}
						{todo.note && <span className="truncate">{todo.note}</span>}
						{todo.source.sessionId && (
							<button
								className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-dim"
								onClick={() => onOpenSession(todo.source.sessionId!)}
								title="Open the session that added this"
							>
								from session
							</button>
						)}
					</div>
				)}
			</div>
			{!done && (
				<button
					className="mt-[1px] shrink-0 rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
					onClick={() => onDrop(todo)}
					title="Drop (decided not to do this)"
				>
					<IconX size={20} className="h-[14px] w-[14px]" />
				</button>
			)}
		</div>
	);
}

function DeskBody({
	onClose,
	addHandler,
	onOpenSession,
}: Omit<DeskOverlayProps, "open" | "phone">) {
	const user = getCurrentUser();
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [ensureError, setEnsureError] = useState<string | null>(null);
	const [todos, setTodos] = useState<TodoItem[] | null>(null);
	const [draft, setDraft] = useState("");
	const [showDone, setShowDone] = useState(false);
	// Optimistic status flips layered over the last fetch.
	const loadSeq = useRef(0);

	const load = useCallback(async () => {
		const seq = ++loadSeq.current;
		try {
			const res = await fetch(
				`${BASE_PATH}/api/todos?status=all&user=${encodeURIComponent(user)}`,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { todos: TodoItem[] };
			if (seq === loadSeq.current) setTodos(data.todos || []);
		} catch {
			if (seq === loadSeq.current) setTodos((t) => t ?? []);
		}
	}, [user]);

	// The standing Desk session: get-or-create once per open.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`${BASE_PATH}/api/desk/ensure`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ user }),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as {
					sessionId: string;
					session: UnifiedSession | null;
				};
				if (!cancelled) setSessionId(data.sessionId);
			} catch (e: any) {
				if (!cancelled) setEnsureError(e?.message || "Failed to open the Desk");
			}
		})();
		void load();
		return () => {
			cancelled = true;
		};
	}, [user, load]);

	// Any surface mutating the list (this overlay, an agent tool call, another
	// tab) lands here via the app-wide broadcast.
	useEffect(
		() =>
			addHandler((msg) => {
				if (msg.type === "todos_changed") void load();
			}),
		[addHandler, load],
	);

	async function patchTodo(id: string, patch: Record<string, unknown>) {
		try {
			await fetch(`${BASE_PATH}/api/todos/${encodeURIComponent(id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...patch, user }),
			});
		} finally {
			void load();
		}
	}

	function toggle(t: TodoItem) {
		const status = t.status === "done" ? "open" : "done";
		setTodos(
			(prev) =>
				prev?.map((x) => (x.id === t.id ? { ...x, status } : x)) ?? prev,
		);
		void patchTodo(t.id, { status });
	}

	function drop(t: TodoItem) {
		setTodos((prev) => prev?.filter((x) => x.id !== t.id) ?? prev);
		void patchTodo(t.id, { status: "dropped" });
	}

	async function addFromDraft() {
		const text = draft.trim();
		if (!text) return;
		setDraft("");
		try {
			await fetch(`${BASE_PATH}/api/todos`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, user }),
			});
		} finally {
			void load();
		}
	}

	const open = (todos || []).filter((t) => t.status === "open");
	const done = (todos || []).filter((t) => t.status === "done");

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Header */}
			<div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
				<IconDesk size={22} className="text-dim" />
				<span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">
					Desk
				</span>
				{sessionId && (
					<button
						className="flex shrink-0 items-center rounded-md p-1 text-faint hover:bg-surface hover:text-fg"
						onClick={() => {
							onClose();
							onOpenSession(sessionId);
						}}
						title="Open as a full session"
					>
						<IconExpand size={20} />
					</button>
				)}
				<button
					className="flex shrink-0 items-center rounded-md p-1 text-faint hover:bg-surface hover:text-fg"
					onClick={onClose}
					aria-label="Close"
				>
					<IconX size={20} />
				</button>
			</div>

			{/* Todos */}
			<div className="max-h-[42%] shrink-0 overflow-y-auto overscroll-contain border-b border-line px-2 py-2">
				{todos === null ? (
					<div className="px-2 py-1 text-[13px] font-medium text-dim">
						Loading…
					</div>
				) : (
					<>
						{open.map((t) => (
							<TodoRow
								key={t.id}
								todo={t}
								onToggle={toggle}
								onDrop={drop}
								onOpenSession={(id) => {
									onClose();
									onOpenSession(id);
								}}
							/>
						))}
						{open.length === 0 && (
							<div className="px-2 py-1 text-[13px] font-medium text-dim">
								Nothing on your list.
							</div>
						)}
						<div className="mt-1 flex items-center gap-2 px-2">
							<input
								className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[13px] font-medium text-fg outline-none placeholder:text-faint focus:border-fg/30"
								value={draft}
								placeholder="Add a todo…"
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										void addFromDraft();
									}
								}}
							/>
							{done.length > 0 && (
								<button
									className="shrink-0 text-[12px] font-medium text-faint hover:text-dim"
									onClick={() => setShowDone((s) => !s)}
								>
									{showDone ? "Hide done" : `Done (${done.length})`}
								</button>
							)}
						</div>
						{showDone &&
							done.map((t) => (
								<TodoRow
									key={t.id}
									todo={t}
									onToggle={toggle}
									onDrop={drop}
									onOpenSession={(id) => {
										onClose();
										onOpenSession(id);
									}}
								/>
							))}
					</>
				)}
			</div>

			{/* Concierge chat */}
			<div className="min-h-0 flex-1">
				{ensureError ? (
					<div className="px-4 py-6 text-center text-[13px] font-medium text-dim">
						{ensureError}
					</div>
				) : sessionId ? (
					<SideChatConversation
						sideChatId={sessionId}
						onBack={onClose}
						hideHeader
						placeholder="Ask your Desk…"
						emptyState={
							<>
								This is your Desk — tell Michael what's on your plate, ask
								what to do next, or have it spin up sessions for you. Items
								you mention land on the list above.
							</>
						}
					/>
				) : (
					<div className="px-4 py-6 text-center text-[13px] font-medium text-dim">
						Opening…
					</div>
				)}
			</div>
		</div>
	);
}

export function DeskOverlay({
	open,
	onClose,
	phone,
	addHandler,
	onOpenSession,
}: DeskOverlayProps) {
	if (!open) return null;
	if (phone) {
		return (
			<BottomSheet onClose={onClose} label="Desk" className="h-[90dvh]">
				<DeskBody
					onClose={onClose}
					addHandler={addHandler}
					onOpenSession={onOpenSession}
				/>
			</BottomSheet>
		);
	}
	return (
		<Modal.Root open onOpenChange={(o) => !o && onClose()}>
			<Modal.Content
				widthClassName="max-w-[560px]"
				className="h-[72vh] gap-0 overflow-hidden p-0"
			>
				<DeskBody
					onClose={onClose}
					addHandler={addHandler}
					onOpenSession={onOpenSession}
				/>
			</Modal.Content>
		</Modal.Root>
	);
}
