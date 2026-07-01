import React, { useEffect, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { TAB_COLORS, colorHex } from "../lib/tab-colors";

/**
 * A tab is either a session or a (collaborative) note. Both ride the same
 * per-user pins array; their stable key is the pin entry — a bare session id,
 * or `note:<id>` for a note — used for pinning, coloring, and the active mark.
 */
export type TabItem =
	| { kind: "session"; session: UnifiedSession }
	| { kind: "note"; id: string; title: string };

export function tabKey(tab: TabItem): string {
	return tab.kind === "session" ? tab.session.id : `note:${tab.id}`;
}
function tabTitle(tab: TabItem): string {
	return tab.kind === "session" ? tab.session.title : tab.title;
}

interface Props {
	tabs: TabItem[];
	/** Pin-key of the active tab. */
	activeKey: string | null;
	/** Pin-keys that are pinned; the rest are transient (current route only). */
	pinnedKeys: Set<string>;
	/** Map of pin-key → swatch key for colored tabs. */
	colors: Record<string, string>;
	onSelect: (tab: TabItem) => void;
	onTogglePin: (key: string) => void;
	onSetColor: (key: string, color: string | null) => void;
	/**
	 * The + button. When `newChatMode` is set (a session is open) it starts a
	 * fresh chat in the current session (stay put); otherwise it opens the
	 * new-session palette.
	 */
	onNewSession: () => void;
	newChatMode?: boolean;
	/** Persist a new pinned-tab order after a drag. */
	onReorder: (keys: string[]) => void;
	/** Rename a session tab (double-click the title); empty title resets it. */
	onRename: (key: string, title: string) => void;
}

type Menu = { key: string; x: number; y: number };

/**
 * Horizontal strip of tabs above the title, on every view. Pinned tabs persist
 * (the pins store — sessions and notes alike); the currently-open session/note
 * also shows as a *transient* tab even when unpinned (Chrome-style), promotable
 * with the ☆. Right-click colors a tab; pinned tabs can be dragged to reorder.
 */
export function SessionTabs({
	tabs,
	activeKey,
	pinnedKeys,
	colors,
	onSelect,
	onTogglePin,
	onSetColor,
	onNewSession,
	newChatMode,
	onReorder,
	onRename,
}: Props) {
	const [menu, setMenu] = useState<Menu | null>(null);
	const [dragKey, setDragKey] = useState<string | null>(null);
	const [overKey, setOverKey] = useState<string | null>(null);
	// Inline rename: the pin-key being edited and its draft text.
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

	if (tabs.length === 0) return null;

	function handleDrop(targetKey: string) {
		if (!dragKey || dragKey === targetKey) {
			setDragKey(null);
			setOverKey(null);
			return;
		}
		// Reorder only among pinned tabs (the transient tab can't be dropped onto).
		const pinned = tabs.map(tabKey).filter((k) => pinnedKeys.has(k));
		const from = pinned.indexOf(dragKey);
		const to = pinned.indexOf(targetKey);
		if (from !== -1 && to !== -1) {
			pinned.splice(to, 0, pinned.splice(from, 1)[0]);
			onReorder(pinned);
		}
		setDragKey(null);
		setOverKey(null);
	}

	return (
		<div className="session-tabs" role="tablist">
			{tabs.map((tab) => {
				const key = tabKey(tab);
				const pinned = pinnedKeys.has(key);
				const session = tab.kind === "session" ? tab.session : null;
				const waiting = !!session?.waitingForInput;
				const hex = colorHex(colors[key]);
				return (
					<div
						key={key}
						role="tab"
						aria-selected={key === activeKey}
						draggable={pinned}
						onDragStart={() => pinned && setDragKey(key)}
						onDragOver={(e) => {
							if (dragKey && pinned) {
								e.preventDefault();
								setOverKey(key);
							}
						}}
						onDrop={() => handleDrop(key)}
						onDragEnd={() => {
							setDragKey(null);
							setOverKey(null);
						}}
						className={`session-tab ${key === activeKey ? "session-tab-active" : ""} ${
							pinned ? "" : "session-tab-transient"
						} ${waiting ? "session-tab-waiting" : ""} ${hex ? "session-tab-colored" : ""} ${
							tab.kind === "note" ? "session-tab-note" : ""
						} ${dragKey === key ? "session-tab-dragging" : ""} ${
							overKey === key && dragKey ? "session-tab-dragover" : ""
						}`}
						style={
							hex ? ({ "--tab-color": hex } as React.CSSProperties) : undefined
						}
						onClick={() => onSelect(tab)}
						onContextMenu={(e) => {
							e.preventDefault();
							setMenu({ key, x: e.clientX, y: e.clientY });
						}}
						title={tabTitle(tab)}
					>
						{tab.kind === "note" ? (
							<span className="session-tab-glyph">📝</span>
						) : waiting ? (
							<span className="session-tab-dot session-tab-dot-waiting" />
						) : (
							session?.isRunning && <span className="session-tab-dot" />
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
									// Only sessions are renameable; notes keep their own title.
									if (tab.kind !== "session") return;
									e.stopPropagation();
									setDraft(tabTitle(tab));
									setEditKey(key);
								}}
							>
								{tabTitle(tab)}
							</span>
						)}
						<span
							className={`session-tab-pin ${pinned ? "session-tab-pin-on" : ""}`}
							role="button"
							aria-label={pinned ? "Unpin (remove tab)" : "Pin tab"}
							title={pinned ? "Unpin" : "Pin tab"}
							onClick={(e) => {
								e.stopPropagation();
								onTogglePin(key);
							}}
						>
							{pinned ? "★" : "☆"}
						</span>
					</div>
				);
			})}
			<button
				type="button"
				className="session-tab session-tab-new"
				aria-label={newChatMode ? "New chat in this session" : "New session"}
				title={
					newChatMode ? "New chat (stays in this session)" : "New session"
				}
				onClick={onNewSession}
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
