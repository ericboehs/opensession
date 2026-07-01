import React, { useEffect, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { TAB_COLORS, colorHex } from "../lib/tab-colors";

/**
 * The tab strip is scoped to ONE Project: it shows the sibling chats of the
 * currently-open chat (every session sharing its `projectId`). Standalone chats
 * (no project) render no tab strip at all — the parent passes an empty list.
 *
 * There is no pinning here anymore (pinning moved to the sidebar, where sessions
 * and notes can be pinned and mixed). Right-click colors a tab; double-click the
 * title renames the chat; the + button starts a new chat in this project.
 */
interface Props {
	/** Sibling chats in the current project, in display order. */
	tabs: UnifiedSession[];
	/** Session id of the active tab. */
	activeId: string | null;
	/** Map of session id → swatch key for colored tabs. */
	colors: Record<string, string>;
	onSelect: (session: UnifiedSession) => void;
	onSetColor: (key: string, color: string | null) => void;
	/** Start a new chat in this project (defaults to the shared worktree). */
	onNewChat: () => void;
	/** Rename a chat (double-click the title); empty title resets it. */
	onRename: (id: string, title: string) => void;
}

type Menu = { key: string; x: number; y: number };

export function SessionTabs({
	tabs,
	activeId,
	colors,
	onSelect,
	onSetColor,
	onNewChat,
	onRename,
}: Props) {
	const [menu, setMenu] = useState<Menu | null>(null);
	const [editKey, setEditKey] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	function commitRename() {
		if (editKey !== null) onRename(editKey, draft.trim());
		setEditKey(null);
	}

	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu]);

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
					</div>
				);
			})}
			<button
				type="button"
				className="session-tab session-tab-new"
				aria-label="New chat in this project"
				title="New chat in this project"
				onClick={onNewChat}
			>
				+
			</button>

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
