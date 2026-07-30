import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TodoItem, WSServerMessage } from "../lib/types";
import { BASE_PATH } from "../lib/base";
import { getCurrentUser } from "./UserPicker";
import { DeskConversation } from "./DeskConversation";
import { ResponsiveDialog } from "../ui/sheet";
import { IconCheck, IconDesk, IconExpand, IconX } from "./icons";

/**
 * The Desk — a summonable overlay (⌘J / the floating desk button) on top of
 * whatever you're doing: your todo list up top, your standing concierge
 * session below. Quick capture, quick asks, then leave.
 *
 * Persistence is the point: after the first summon the body STAYS MOUNTED
 * (hidden, not unmounted) — the chat's scoped socket keeps watching and the
 * todo list keeps syncing in the background, so every later ⌘J is instant
 * with the transcript and list already in place. No enter/exit animations
 * either; summon-dismiss-summon should feel like toggling a HUD.
 *
 * The chat is a normal durable session (desk: true, hidden from the session
 * lists) pinned to a fast model+effort server-side; "Clear" sets a display
 * marker (server-stored) so the modal starts visually fresh while the full
 * transcript stays in the expanded session view.
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

/** Compact reminder stamp: time today, weekday+time within a week, else date. */
function formatRemind(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const now = new Date();
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === now.toDateString()) return time;
	if (Math.abs(d.getTime() - now.getTime()) < 6 * 86_400_000)
		return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
	return d.toLocaleDateString([], { month: "short", day: "numeric" });
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
		<div className="group flex items-center gap-2.5 rounded-md px-2 py-1 hover:bg-surface">
			<button
				className={
					"flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors " +
					(done
						? "border-green bg-green text-panel"
						: "border-line-strong text-transparent hover:border-fg/50")
				}
				onClick={() => onToggle(todo)}
				aria-label={done ? "Reopen" : "Mark done"}
			>
				<IconCheck size={20} className="h-[13px] w-[13px]" />
			</button>
			<span
				className={
					"min-w-0 flex-1 truncate text-[13px] font-medium " +
					(done ? "text-dim line-through" : "text-fg")
				}
				title={todo.note ? `${todo.text} — ${todo.note}` : todo.text}
			>
				{todo.text}
			</span>
			{todo.due && (
				<span className="shrink-0 text-[11.5px] font-medium text-faint">
					{todo.due}
				</span>
			)}
			{todo.remindAt && !done && (
				<span
					className={
						"shrink-0 text-[11.5px] font-medium " +
						(todo.remindedAt ? "text-faint line-through" : "text-dim")
					}
					title={todo.remindedAt ? "Reminder sent" : "Reminder scheduled"}
				>
					{formatRemind(todo.remindAt)}
				</span>
			)}
			{todo.source.sessionId && (
				<button
					className="shrink-0 text-[11.5px] font-medium text-faint underline decoration-dotted underline-offset-2 hover:text-dim"
					onClick={() => onOpenSession(todo.source.sessionId!)}
					title="Open the session that added this"
				>
					source
				</button>
			)}
			{!done && (
				<button
					className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
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
	active,
	phone,
	onClose,
	addHandler,
	onOpenSession,
}: Omit<DeskOverlayProps, "open"> & { active: boolean }) {
	const user = getCurrentUser();
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [clearedAt, setClearedAt] = useState<string | undefined>(undefined);
	const [ensureError, setEnsureError] = useState<string | null>(null);
	const [todos, setTodos] = useState<TodoItem[] | null>(null);
	const [draft, setDraft] = useState("");
	const [showDone, setShowDone] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
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

	// One-time boot (the body stays mounted after the first summon): resolve
	// the standing Desk session + the clear marker, and load the list.
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
					clearedAt: string | null;
				};
				if (cancelled) return;
				setSessionId(data.sessionId);
				if (data.clearedAt) setClearedAt(data.clearedAt);
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

	// On summon: drop the caret straight into the composer (desktop — a phone
	// keyboard popping open unasked is hostile).
	useEffect(() => {
		if (!active || phone) return;
		const ta = rootRef.current?.querySelector("textarea");
		(ta as HTMLTextAreaElement | null)?.focus();
	}, [active, phone]);

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

	async function clearChat() {
		try {
			const res = await fetch(`${BASE_PATH}/api/desk/clear`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ user }),
			});
			const data = (await res.json()) as { clearedAt?: string };
			if (data.clearedAt) setClearedAt(data.clearedAt);
		} catch {}
	}

	const open = (todos || []).filter((t) => t.status === "open");
	const done = (todos || []).filter((t) => t.status === "done");

	return (
		// flex-1 rather than h-full: on phone the sheet's drag grabber is a
		// sibling above us, so we take the remainder instead of the whole panel.
		<div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
			{/* Header */}
			<div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-2.5">
				<IconDesk size={22} className="text-dim" />
				<span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">
					Desk
				</span>
				<button
					className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-faint hover:bg-surface hover:text-fg"
					onClick={clearChat}
					title="Clear the chat here — the full transcript stays in the expanded session"
				>
					Clear
				</button>
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
			<div className="max-h-[38%] shrink-0 overflow-y-auto overscroll-contain border-b border-line px-2 py-1.5">
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
						<div className="mt-1 flex items-center gap-2 px-2 pb-0.5">
							<input
								className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[13px] font-medium text-fg outline-none placeholder:text-faint focus:border-fg/30"
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
					<DeskConversation
						sessionId={sessionId}
						effort="low"
						hideBefore={clearedAt}
						placeholder="Ask your Desk…"
						emptyState={
							<>
								Capture todos and kick off sessions: try "put reviewing
								Kent's PR on my list" or "start a session to fix the export
								bug".
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
	return (
		<ResponsiveDialog
			open={open}
			onClose={onClose}
			phone={phone}
			label="Desk"
			// The body stays mounted after the first summon — see the module doc.
			keepMounted
			// ⌘J is a HUD toggle, not a dialog: summon-dismiss-summon stays
			// instant on desktop. The phone sheet animates like every other
			// sheet, so its drag-to-dismiss has something to follow.
			desktopTransition="none"
			// bg-raised on both breakpoints, overriding the sheet's bg-surface:
			// the Desk's controls are recessed bg-surface inputs, which would
			// dissolve into a bg-surface panel.
			sheetClassName="h-[85dvh] bg-raised"
			modalClassName="h-[540px] max-h-[80vh] max-w-[560px]"
		>
			<DeskBody
				active={open}
				phone={phone}
				onClose={onClose}
				addHandler={addHandler}
				onOpenSession={onOpenSession}
			/>
		</ResponsiveDialog>
	);
}
