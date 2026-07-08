import React, { useEffect, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { TAB_COLORS, colorHex } from "../lib/tab-colors";
import { hasDraft, onDraftsChanged } from "../lib/drafts";
import { relativeTime } from "../lib/api";
import { Menu, ContextMenu } from "../ui/menu";
import { chatPath, absoluteLink, copyToClipboard } from "../lib/share-link";
import { copySessionTranscript } from "../lib/transcript-copy";
import { IconHistory, IconPencil, IconRestore } from "./icons";

/**
 * The tab strip is scoped to ONE Workspace: it shows the sibling chats of the
 * currently-open chat (every session sharing its `projectId`/workspace). A
 * pre-migration standalone chat renders no strip — the parent passes an empty
 * list; post-migration every chat has a workspace, so the strip always shows
 * (a single tab plus the + button).
 *
 * There is no pinning here anymore (pinning moved to the sidebar). Right-click
 * opens a context menu (rename / copy concise or full transcript / copy link /
 * tab color / close); double-click the title also renames the chat. The +
 * button starts a new chat in this workspace sharing its worktree;
 * right-clicking + offers the other modes (stacked worktree / ask).
 */
interface Props {
	/** Sibling chats in the current workspace, in display order. */
	tabs: UnifiedSession[];
	/** Archived (closed) chats of this workspace, newest activity first. */
	archived: UnifiedSession[];
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
	/** Un-archive a chat from the history menu, back into the strip. */
	onRestore: (session: UnifiedSession) => void;
	/** Report a copy action's outcome ("Link copied", …). */
	onToast: (message: string) => void;
}

type NewMenu = { x: number; y: number };

const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Right-aligned keyboard-shortcut hint on a menu row. */
function MenuHint({ label }: { label: string }) {
	return <span className="shrink-0 pl-4 text-[12px] text-faint">{label}</span>;
}

export function SessionTabs({
	tabs,
	archived,
	activeId,
	colors,
	onSelect,
	onSetColor,
	onNewChat,
	onRename,
	onClose,
	onRestore,
	onToast,
}: Props) {
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
		if (!newMenu) return;
		const close = () => setNewMenu(null);
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [newMenu]);

	// No project (standalone chat) → no tab strip.
	if (tabs.length === 0) return null;

	return (
		<div className="session-tabs" role="tablist">
			<div className="session-tabs-scroll">
				{tabs.map((session) => {
					const key = session.id;
					const waiting = !!session.waitingForInput;
					const hex = colorHex(colors[key]);
					return (
						<ContextMenu.Root key={key}>
							<ContextMenu.Trigger
								render={
									<div
										role="tab"
										aria-selected={key === activeId}
										className={`session-tab ${key === activeId ? "session-tab-active" : ""} ${
											waiting ? "session-tab-waiting" : ""
										} ${hex ? "session-tab-colored" : ""}`}
										style={
											hex
												? ({ "--tab-color": hex } as React.CSSProperties)
												: undefined
										}
										onClick={() => onSelect(session)}
										title={session.title}
									/>
								}
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
									<IconPencil size={20} />
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
							</ContextMenu.Trigger>
							{/* finalFocus=false: "Rename chat" mounts the inline rename
							    input (autoFocus) — the closing menu must not steal focus
							    back to the tab. */}
							<ContextMenu.Popup className="min-w-[250px]" finalFocus={false}>
								<ContextMenu.Item
									onClick={() => {
										setDraft(session.title);
										setEditKey(key);
									}}
								>
									<span className="grow">Rename chat</span>
								</ContextMenu.Item>
								<ContextMenu.Separator />
								<ContextMenu.Item
									onClick={() =>
										void copySessionTranscript(session, "concise", onToast)
									}
								>
									<span className="grow">Copy concise transcript</span>
									{key === activeId && (
										<MenuHint label={isApple ? "⌘ ⌥ C" : "Ctrl+Alt+C"} />
									)}
								</ContextMenu.Item>
								<ContextMenu.Item
									onClick={() =>
										void copySessionTranscript(session, "full", onToast)
									}
								>
									<span className="grow">Copy full transcript</span>
								</ContextMenu.Item>
								<ContextMenu.Item
									onClick={() =>
										copyToClipboard(absoluteLink(chatPath(session)), () =>
											onToast("Link copied"),
										)
									}
								>
									<span className="grow">Copy link</span>
								</ContextMenu.Item>
								<ContextMenu.Separator />
								{/* Tab color. A swatch click bubbles to the Item, which
								    closes the menu — the Item itself does nothing. */}
								<ContextMenu.Item className="data-[highlighted]:bg-transparent">
									{TAB_COLORS.map((c) => (
										<button
											key={c.key}
											type="button"
											className={`tab-color-swatch ${colors[key] === c.key ? "tab-color-swatch-on" : ""}`}
											style={{ background: c.hex }}
											aria-label={c.label}
											title={c.label}
											onClick={() => onSetColor(key, c.key)}
										/>
									))}
									<button
										type="button"
										className="tab-color-swatch tab-color-swatch-none"
										aria-label="No color"
										title="No color"
										onClick={() => onSetColor(key, null)}
									/>
								</ContextMenu.Item>
								<ContextMenu.Separator />
								<ContextMenu.Item onClick={() => onClose(session)}>
									<span className="grow">Close tab</span>
									{key === activeId && (
										<MenuHint label={isApple ? "⌘ W" : "Ctrl+W"} />
									)}
								</ContextMenu.Item>
							</ContextMenu.Popup>
						</ContextMenu.Root>
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
			</div>
			<div className="session-tabs-actions">

				{/* History: every archived (closed) chat of this workspace, in one
				    list. Clicking a row opens the chat read-only-ish (it gets a tab
				    while viewed); the ⟲ restores it into the strip for good. */}
				{archived.length > 0 && (
					<Menu.Root>
						<Menu.Trigger
							className="session-tab session-tab-history"
							aria-label="Archived chats"
							title="Archived chats"
						>
							<IconHistory size={22} />
						</Menu.Trigger>
						<Menu.Popup align="end" sideOffset={4} className="min-w-[240px] max-w-[320px]">
							{archived.map((s) => (
								<Menu.Item key={s.id} onClick={() => onSelect(s)}>
									<span className="min-w-0 flex-1 truncate">{s.title}</span>
									<span className="shrink-0 text-[11.5px] text-faint">
										{relativeTime(s.lastActivity)}
									</span>
									<button
										type="button"
										className="flex shrink-0 cursor-pointer items-center rounded-sm border-0 bg-transparent p-0.5 text-dim hover:text-fg"
										aria-label="Restore chat"
										title="Restore to tabs"
										onClick={(e) => {
											e.stopPropagation();
											onRestore(s);
										}}
									>
										<IconRestore size={20} />
									</button>
								</Menu.Item>
							))}
						</Menu.Popup>
					</Menu.Root>
				)}
			</div>

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

		</div>
	);
}
