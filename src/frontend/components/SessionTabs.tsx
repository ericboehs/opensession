import React, { useEffect, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { TAB_COLORS, colorHex } from "../lib/tab-colors";
import { hasDraft, onDraftsChanged } from "../lib/drafts";
import { IconPencil } from "./icons";

/**
 * The tab strip is scoped to ONE Workspace: it shows the sibling chats of the
 * currently-open chat (every session sharing its `projectId`/workspace). A
 * pre-migration standalone chat renders no strip — the parent passes an empty
 * list; post-migration every chat has a workspace, so the strip always shows
 * (a single tab plus the + button).
 *
 * There is no pinning here anymore (pinning moved to the sidebar). Right-click
 * colors a tab; double-click the title renames the chat. The + button starts a
 * new chat in this workspace sharing its worktree; right-clicking + offers the
 * other modes (stacked worktree / ask).
 */
interface Props {
	/** Sibling chats in the current workspace, in display order. */
	tabs: UnifiedSession[];
	/** Session id of the active tab. */
	activeId: string | null;
	/** Map of session id → swatch key for colored tabs. */
	colors: Record<string, string>;
	onSelect: (session: UnifiedSession) => void;
	onSetColor: (key: string, color: string | null) => void;
	/**
	 * Start a new chat in this workspace. share = reuse the workspace worktree
	 * (the + button's plain-click default), stack = new worktree branched off it,
	 * ask = no worktree.
	 */
	onNewChat: (mode: "share" | "stack" | "ask") => void;
	/** Rename a chat (double-click the title); empty title resets it. */
	onRename: (id: string, title: string) => void;
	/** Close (archive) a chat — the × revealed on hover. */
	onClose: (session: UnifiedSession) => void;
}

type Menu = { key: string; x: number; y: number };
type NewMenu = { x: number; y: number };

export function SessionTabs({
	tabs,
	activeId,
	colors,
	onSelect,
	onSetColor,
	onNewChat,
	onRename,
	onClose,
}: Props) {
	const [menu, setMenu] = useState<Menu | null>(null);
	const [newMenu, setNewMenu] = useState<NewMenu | null>(null);
	const [editKey, setEditKey] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	// Re-render when a composer draft appears/disappears — tabs check hasDraft()
	// during render to show the unsent-draft pencil on sibling chats.
	const [, setDraftsRev] = useState(0);
	useEffect(() => onDraftsChanged(() => setDraftsRev((v) => v + 1)), []);

	function commitRename() {
		if (editKey !== null) onRename(editKey, draft.trim());
		setEditKey(null);
	}

	useEffect(() => {
		if (!menu && !newMenu) return;
		const close = () => {
			setMenu(null);
			setNewMenu(null);
		};
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu, newMenu]);

	// No project (standalone chat) → no tab strip.
	if (tabs.length === 0) return null;

	return (
		<div className="session-tabs" role="tablist">
			{tabs.map((session) => {
				const key = session.id;
				const waiting = !!session.waitingForInput;
				const hex = colorHex(colors[key]);
				return (
					<div
						key={key}
						role="tab"
						aria-selected={key === activeId}
						className={`session-tab ${key === activeId ? "session-tab-active" : ""} ${
							waiting ? "session-tab-waiting" : ""
						} ${hex ? "session-tab-colored" : ""}`}
						style={
							hex ? ({ "--tab-color": hex } as React.CSSProperties) : undefined
						}
						onClick={() => onSelect(session)}
						onContextMenu={(e) => {
							e.preventDefault();
							setMenu({ key, x: e.clientX, y: e.clientY });
						}}
						title={session.title}
					>
						{waiting ? (
							<span className="session-tab-dot session-tab-dot-waiting" />
						) : (
							session.isRunning && <span className="session-tab-dot" />
						)}
						{editKey === key ? (
							<input
								className="session-tab-rename"
								value={draft}
								autoFocus
								onChange={(e) => setDraft(e.target.value)}
								onClick={(e) => e.stopPropagation()}
								onDoubleClick={(e) => e.stopPropagation()}
								onBlur={commitRename}
								onKeyDown={(e) => {
									if (e.key === "Enter") commitRename();
									else if (e.key === "Escape") setEditKey(null);
									e.stopPropagation();
								}}
							/>
						) : (
							<span
								className="session-tab-title"
								onDoubleClick={(e) => {
									e.stopPropagation();
									setDraft(session.title);
									setEditKey(key);
								}}
							>
								{session.title}
							</span>
						)}
						{/* Unsent draft in a sibling chat (the active tab's draft is
						    already on screen in the composer — no pencil needed). */}
						{key !== activeId && hasDraft(`chat:${key}`) && (
							<span className="session-tab-draft" title="Unsent draft">
								<IconPencil size={14} />
							</span>
						)}
						<button
							type="button"
							className="session-tab-close"
							aria-label="Close chat"
							title="Close chat"
							onClick={(e) => {
								e.stopPropagation();
								onClose(session);
							}}
						>
							×
						</button>
					</div>
				);
			})}
			<button
				type="button"
				className="session-tab session-tab-new"
				aria-label="New chat in this workspace"
				title="New chat — shares this workspace's worktree (right-click for options)"
				onClick={() => onNewChat("share")}
				onContextMenu={(e) => {
					e.preventDefault();
					setNewMenu({ x: e.clientX, y: e.clientY });
				}}
			>
				+
			</button>

			{newMenu && (
				<div
					className="tab-color-menu session-tab-new-menu"
					style={{ left: newMenu.x, top: newMenu.y }}
					onClick={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						className="session-tab-new-menu-item"
						onClick={() => {
							setNewMenu(null);
							onNewChat("share");
						}}
					>
						New chat — share worktree
					</button>
					<button
						type="button"
						className="session-tab-new-menu-item"
						onClick={() => {
							setNewMenu(null);
							onNewChat("stack");
						}}
					>
						New chat — stacked worktree
					</button>
					<button
						type="button"
						className="session-tab-new-menu-item"
						onClick={() => {
							setNewMenu(null);
							onNewChat("ask");
						}}
					>
						New chat — ask (no worktree)
					</button>
				</div>
			)}

			{menu && (
				<div
					className="tab-color-menu"
					style={{ left: menu.x, top: menu.y }}
					onClick={(e) => e.stopPropagation()}
				>
					{TAB_COLORS.map((c) => (
						<button
							key={c.key}
							type="button"
							className={`tab-color-swatch ${colors[menu.key] === c.key ? "tab-color-swatch-on" : ""}`}
							style={{ background: c.hex }}
							aria-label={c.label}
							title={c.label}
							onClick={() => {
								onSetColor(menu.key, c.key);
								setMenu(null);
							}}
						/>
					))}
					<button
						type="button"
						className="tab-color-swatch tab-color-swatch-none"
						aria-label="No color"
						title="No color"
						onClick={() => {
							onSetColor(menu.key, null);
							setMenu(null);
						}}
					/>
				</div>
			)}
		</div>
	);
}
