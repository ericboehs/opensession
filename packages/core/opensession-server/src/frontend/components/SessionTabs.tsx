import React, { useEffect, useRef, useState } from "react";
import { useShortcutLabel } from "../hooks/useShortcutBindings";
import { Reorder } from "motion/react";
import type { UnifiedSession } from "../lib/types";
import { TAB_COLORS, colorHex } from "../lib/tab-colors";
import { hasDraft, onDraftsChanged } from "../lib/drafts";
import { relativeTime } from "../lib/api";
import { Menu, ContextMenu } from "../ui/menu";
import { sessionPath, absoluteLink, copyToClipboard } from "../lib/share-link";
import { copySessionTranscript } from "../lib/transcript-copy";
import { IconChevronRight, IconHistory, IconPencil, IconPlus, IconRestore, IconRobot } from "./icons";
import { isAutomationSession } from "../lib/landing-session";
import { ArchivedSessionItems } from "./ArchivedSessionItems";
import { useIsPhone } from "../hooks/useIsPhone";
import { UserAvatar } from "./UserAvatar";
import {
	NEW_MENU,
	NEW_MENU_ITEM,
	PANEL_TAB_DOT,
	TAB_ACTIONS,
	TAB_DRAFT,
	TAB_DROP_SLOT,
	TAB_FACE,
	TAB_FACES,
	TAB_FACES_MORE,
	TAB_GROUP,
	TAB_HISTORY,
	TAB_ITEM,
	TAB_ITEM_DRAGGING,
	TAB_NEW,
	TAB_RENAME,
	TAB_SCROLL,
	TAB_STRIP,
	TAB_SWATCH,
	TAB_SWATCH_NONE,
	TAB_SWATCH_ON,
	TAB_TITLE,
	TAB_VICON,
	tabClass,
	tabCloseClass,
	tabDotClass,
} from "../lib/session-tab-classes";
import { cn } from "../ui/cn";

/**
 * The tab strip is scoped to ONE Workspace: it shows the sibling sessions of the
 * currently-open session (every session sharing its `workspaceId`/workspace). It
 * renders once a workspace has TWO or more sessions, or has a pane or a closed
 * session to offer. A lone session with nothing else needs no strip, so the
 * "+ New tab" affordance moves next to the session title in SessionViewer's
 * header instead (and ⌘⌥N does the same thing). A pre-migration standalone
 * session (empty list) likewise renders nothing.
 *
 * There is no pinning here anymore (pinning moved to the sidebar). Right-click
 * opens a context menu (rename / copy concise or full transcript / copy link /
 * tab color / close); double-click the title also renames the session. The +
 * button starts a new session in this workspace sharing its worktree;
 * right-clicking + offers the other modes (stacked worktree / ask).
 *
 * Sessions and view panes (Review, Assets, …) are ONE draggable row: every tab is
 * a Reorder.Item, so a pane can be dragged among the sessions and the whole
 * arrangement is what the parent persists per workspace.
 */
/**
 * A non-session pane (Review, …) surfaced in the strip. It starts after the session
 * tabs and is draggable from there like any session tab.
 */
export type ViewTab = {
	/** Stable id, e.g. `review:<sessionId>`. */
	id: string;
	/** Tab label ("Review"). Also the tooltip/aria label when `icon` is set. */
	label: string;
	/** Whether this pane is the foregrounded tab. */
	active: boolean;
	/** Optional status-dot class (e.g. PR state) shown before the label. */
	dotClass?: string | null;
	/**
	 * Optional glyph shown INSTEAD of the text label — the tab reads as just the
	 * icon (e.g. Staging → a globe). `label` still supplies the tooltip/aria.
	 */
	icon?: React.ReactNode;
	/**
	 * Whether the tab carries a ×. Defaults to true; the workspace home sets it
	 * false, because it only exists when it is the strip's last tab and closing
	 * it would leave the workspace with none.
	 */
	closable?: boolean;
};

interface Props {
	/** Sibling sessions in the current workspace, in display order. */
	tabs: UnifiedSession[];
	/** Archived (closed) sessions of this workspace, newest activity first. */
	archived: UnifiedSession[];
	/** Session id of the active tab. */
	activeId: string | null;
	/** Map of session id → swatch key for colored tabs. */
	colors: Record<string, string>;
	/**
	 * Teammates currently in each session, by session id — one entry per person,
	 * with your own devices already filtered out (see lib/presence). The sidebar
	 * shows the same faces per WORKSPACE, which says someone is in this strip but
	 * not which tab; this is that second half.
	 */
	viewers?: Record<string, string[]>;
	onSelect: (session: UnifiedSession) => void;
	onSetColor: (key: string, color: string | null) => void;
	/**
	 * The strip's left-to-right arrangement — session ids and view-tab ids in ONE
	 * list, so a pane (Review, Assets, …) can sit in front of a session. Ids the
	 * list doesn't mention keep their natural place at the end.
	 */
	tabOrder: string[];
	/**
	 * Commit a new left-to-right order for this bar's tabs (desktop drag-drop).
	 * Receives the reordered ids — sessions and view tabs alike; the parent splices
	 * them back into the workspace's order and persists it.
	 */
	onReorderTabs: (orderedIds: string[]) => void;
	/**
	 * This bar is one column of a split. It renders even when it holds a single
	 * tab (each column keeps its "+" however few tabs it has), and its tabs stay
	 * draggable at any count — the drop target is the other column, so a bar
	 * holding one tab must still be able to hand it over.
	 */
	inSplit?: boolean;
	/** Show the archived-sessions menu — only the rightmost bar does. */
	showHistory?: boolean;
	/** Dragging below the strip previews a left/right split over the content. */
	onSplitDrag?: (id: string | null, point?: { x: number; y: number }) => void;
	/** Return true when the drop created a split instead of committing a reorder. */
	onSplitDrop?: (id: string, point: { x: number; y: number }) => boolean;
	/**
	 * Hand a tab to the split's other column (the tab context menu's spelling of
	 * the cross-bar drag). Only set on a bar that is part of a split.
	 */
	onMoveAcross?: (id: string) => void;
	/** Where `onMoveAcross` lands — it names the menu item. */
	moveAcrossSide?: "left" | "right";
	/**
	 * Non-session "view" tabs (Review, Preview, …), in their natural order — they
	 * follow the session tabs until dragged elsewhere (see `tabOrder`). Each is
	 * bound to a session; selecting one foregrounds that pane, its × dismisses
	 * it. Generalized so more panes (diff, terminal, …) can drop in later.
	 */
	viewTabs: ViewTab[];
	/** Foreground a view tab (show its pane). */
	onSelectView: (id: string) => void;
	/** Dismiss a view tab from the strip. */
	onCloseView: (id: string) => void;
	/**
	 * Start a new session in this workspace. share = reuse the workspace worktree
	 * (the + button's plain-click default), stack = new worktree branched off it,
	 * ask = no worktree.
	 */
	onNewSession: (mode: "share" | "stack" | "ask") => void;
	/** Rename a session (double-click the title); empty title resets it. */
	onRename: (id: string, title: string) => void;
	/** Close (archive) a session — the × revealed on hover. */
	onClose: (session: UnifiedSession) => void;
	/** Un-archive a session from the history menu, back into the strip. */
	onRestore: (session: UnifiedSession) => void;
	/** Report a copy action's outcome ("Link copied", …). */
	onToast: (message: string) => void;
}

type NewMenu = { x: number; y: number };
type TabMember =
	| { kind: "session"; id: string; session: UnifiedSession }
	| { kind: "view"; id: string; view: ViewTab };

export function SessionTabs({
	tabs,
	archived,
	activeId,
	colors,
	viewers,
	onSelect,
	onSetColor,
	tabOrder,
	onReorderTabs,
	inSplit,
	showHistory = true,
	onSplitDrag,
	onSplitDrop,
	onMoveAcross,
	moveAcrossSide,
	viewTabs,
	onSelectView,
	onCloseView,
	onNewSession,
	onRename,
	onClose,
	onRestore,
	onToast,
}: Props) {
	const copyTranscriptLabel = useShortcutLabel("session-copy-transcript");
	const closeLabel = useShortcutLabel("session-close");
	const [newMenu, setNewMenu] = useState<NewMenu | null>(null);
	const [editKey, setEditKey] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	// Re-render when a composer draft appears/disappears — tabs check hasDraft()
	// during render to show the unsent-draft pencil on sibling sessions.
	const [, setDraftsRev] = useState(0);
	useEffect(() => onDraftsChanged(() => setDraftsRev((v) => v + 1)), []);
	// On phones the +/history controls ride INSIDE the scroll (see below) so the
	// tab strip claims the full width instead of losing it to pinned chrome; on
	// desktop they stay pinned after the last tab. Icons run a touch bigger on
	// touch for an easier hit.
	const isPhone = useIsPhone();
	const ctrlIconSize = isPhone ? 25 : 22;

	// Drag-to-reorder the session tabs (desktop only — an x-drag would fight touch
	// scrolling / the phone swipe gestures). `orderDraft` holds the in-flight
	// order during a drag so the strip stays smooth; it's cleared on drop once
	// the parent's reordered `tabs` come back. `justDragged` swallows the click
	// that fires synchronously after a drop so it doesn't select the tab.
	const [orderDraft, setOrderDraft] = useState<string[] | null>(null);
	const orderDraftRef = useRef<string[] | null>(null);
	const justDragged = useRef(false);
	const dragPoint = useRef<{ x: number; y: number } | null>(null);
	const stopPointerTracking = useRef<(() => void) | null>(null);
	// The frame the split preview is waiting on, so both ends of the drag can
	// drop it: a queued preview must never land after the drag has cleared it.
	const splitDragFrame = useRef(0);
	function cancelSplitDragFrame() {
		if (!splitDragFrame.current) return;
		cancelAnimationFrame(splitDragFrame.current);
		splitDragFrame.current = 0;
	}
	// A lone tab has nowhere to go WITHIN its own bar — but in a split it can
	// still be dragged into the other column, so the count only gates a single
	// unsplit strip.
	const canDragTabs = !isPhone && (inSplit || tabs.length + viewTabs.length > 1);

	// Where the dragged tab will land. Desktop tabs are flat text on the strip's
	// own background, so a dragged one has no surface to separate it from the
	// labels it passes — it lifts into a chip (`TAB_ITEM_DRAGGING`) and this ghost
	// marks the gap it left behind. Reorder already opens that gap live; the
	// ghost just makes an otherwise invisible hole readable.
	const [dropSlot, setDropSlot] = useState<{
		key: string;
		left: number;
		width: number;
	} | null>(null);
	const groupRef = useRef<HTMLDivElement | null>(null);
	// Unit widths + inter-tab gap, measured once at drag start: they can't change
	// mid-drag, so the slot's x is arithmetic from the live key order rather than
	// a re-measure of siblings that are still spring-animating into place.
	const dragMetrics = useRef<{
		widths: Map<string, number>;
		gap: number;
		key: string;
	} | null>(null);

	/** Position the ghost at `key`'s slot in the given left-to-right unit order. */
	function placeDropSlot(keys: string[]) {
		const metrics = dragMetrics.current;
		if (!metrics) return;
		const index = keys.indexOf(metrics.key);
		if (index < 0) return setDropSlot(null);
		let left = 0;
		for (let i = 0; i < index; i++) left += (metrics.widths.get(keys[i]) ?? 0) + metrics.gap;
		setDropSlot({ key: metrics.key, left, width: metrics.widths.get(metrics.key) ?? 0 });
	}

	function beginDrag(key: string) {
		const group = groupRef.current;
		if (!group) return;
		// offsetWidth/offsetLeft (layout box) rather than rects: whileDrag's scale
		// is already applied to the dragged item and would inflate its width.
		const items = [...group.children].filter(
			(el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.tabKey,
		);
		const widths = new Map(items.map((el) => [el.dataset.tabKey!, el.offsetWidth] as const));
		const gap =
			items.length > 1
				? Math.max(0, items[1].offsetLeft - (items[0].offsetLeft + items[0].offsetWidth))
				: 0;
		dragMetrics.current = { widths, gap, key };
		placeDropSlot(items.map((el) => el.dataset.tabKey!));
	}

	function endDrag() {
		dragMetrics.current = null;
		setDropSlot(null);
	}

	/**
	 * Follow the pointer for the whole drag so the split preview can track it.
	 * The drop itself is handled in the item's `onDragEnd`, which reads the last
	 * point from `dragPoint` — this only keeps that ref (and the preview) fresh.
	 */
	function trackPointer(id: string, event: React.PointerEvent) {
		stopPointerTracking.current?.();
		dragPoint.current = { x: event.clientX, y: event.clientY };
		// The ref follows every pointer event, because the drop reads it
		// synchronously. The PREVIEW only needs the position the next frame is
		// drawn with, and it costs a parent state update, so it takes one per
		// frame and only when the point has actually moved.
		let sent: { x: number; y: number } | null = null;
		const flush = () => {
			splitDragFrame.current = 0;
			const point = dragPoint.current;
			if (!point || (sent && sent.x === point.x && sent.y === point.y)) return;
			sent = point;
			onSplitDrag?.(id, point);
		};
		const move = (pointer: PointerEvent) => {
			dragPoint.current = { x: pointer.clientX, y: pointer.clientY };
			if (!splitDragFrame.current)
				splitDragFrame.current = requestAnimationFrame(flush);
		};
		const finish = () => {
			cancelSplitDragFrame();
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			stopPointerTracking.current = null;
			onSplitDrag?.(null);
		};
		const up = () => finish();
		const cancel = () => finish();
		stopPointerTracking.current = cancel;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
	}

	useEffect(() => () => stopPointerTracking.current?.(), []);

	// Sessions and view panes are one draggable row: the same drag that moves a
	// session moves Review or Assets, and a pane can end up anywhere among the
	// sessions. Natural order (sessions, then panes in the order the parent built
	// them) is the fallback; the arrangement is the in-flight drag draft while
	// dragging, else the parent's saved `tabOrder`. A tab that arrives mid-drag
	// — or that no order mentions yet — keeps its natural place at the end
	// rather than being dropped.
	const members: TabMember[] = [
		...tabs.map((session): TabMember => ({ kind: "session", id: session.id, session })),
		...viewTabs.map((view): TabMember => ({ kind: "view", id: view.id, view })),
	];
	const rank = new Map((orderDraft ?? tabOrder).map((id, i) => [id, i] as const));
	const orderedMembers = members
		.map((member, natural) => ({ member, natural }))
		.sort((a, b) => {
			const ra = rank.get(a.member.id);
			const rb = rank.get(b.member.id);
			if (ra === rb) return a.natural - b.natural;
			if (ra === undefined) return 1;
			if (rb === undefined) return -1;
			return ra - rb;
		})
		.map((entry) => entry.member);
	const orderedKeys = orderedMembers.map((member) => member.id);
	const activeTopId = activeId ?? viewTabs.find((tab) => tab.active)?.id ?? null;

	// With enough tabs the strip overflows and scrolls, so the tab that just
	// became active can sit outside the visible window — opening a Review pane
	// would foreground a tab you can't see. Nudge it just inside the edge (not
	// centered) so its neighbours stay as context. Keyed on the selection only:
	// re-running as sibling tabs come and go would yank the strip back while
	// someone is scrolled away reading it.
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const box = scrollRef.current;
		if (!box || !activeTopId) return;
		const tab = box.querySelector<HTMLElement>('[aria-selected="true"]');
		if (!tab) return;
		const view = box.getBoundingClientRect();
		const rect = tab.getBoundingClientRect();
		// Clear the edge fade so the tab doesn't come to rest under it.
		const pad = 28;
		const shortLeft = rect.left - (view.left + pad);
		const shortRight = rect.right - (view.right - pad);
		const by = shortLeft < 0 ? shortLeft : shortRight > 0 ? shortRight : 0;
		if (!by) return;
		box.scrollBy({
			left: by,
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
	}, [activeTopId]);

	// Flag whether the strip actually has anywhere to scroll, which gates its
	// edge fades. Those are driven by a CSS scroll timeline, and a timeline that
	// goes INACTIVE (closing a tab, widening the pane until everything fits)
	// holds its last value instead of reverting — without this gate a strip that
	// no longer scrolls keeps a stale fade dimming its first tab. Written
	// straight to the DOM rather than through state: it's presentation only, and
	// re-rendering the strip on every step of a pane drag would be wasteful.
	useEffect(() => {
		const box = scrollRef.current;
		if (!box) return;
		const sync = () =>
			box.toggleAttribute("data-overflow", box.scrollWidth - box.clientWidth > 1);
		// The box catches pane resizes; its children catch the content growing
		// (a tab added, or a title that got longer).
		const observer = new ResizeObserver(sync);
		observer.observe(box);
		for (const child of box.children) observer.observe(child);
		sync();
		return () => observer.disconnect();
	}, [tabs.length, viewTabs.length]);

	// Drop: hand the new order to the parent (which persists it and feeds it back
	// as the next `tabs`), swallow the trailing click, then release the draft.
	function commitReorder() {
		justDragged.current = true;
		setTimeout(() => {
			justDragged.current = false;
		}, 0);
		const order = orderDraftRef.current;
		orderDraftRef.current = null;
		setOrderDraft(null);
		endDrag();
		if (order) onReorderTabs(order);
	}

	function reorderTabs(keys: string[]) {
		orderDraftRef.current = keys;
		setOrderDraft(keys);
		placeDropSlot(keys);
	}

	/**
	 * The drag wiring every tab in the strip shares — sessions and view panes are
	 * the same kind of draggable item, differing only in what they render.
	 * A drag that ends over the pane hands the tab to the other split column
	 * (`onSplitDrop`) instead of committing a reorder.
	 */
	function reorderItemProps(key: string) {
		const draggable = canDragTabs && editKey !== key;
		return {
			as: "div" as const,
			value: key,
			"data-tab-key": key,
			dragListener: draggable,
			onPointerDown: (event: React.PointerEvent) => {
				if (draggable) trackPointer(key, event);
			},
			onDragStart: () => beginDrag(key),
			onDragEnd: () => {
				cancelSplitDragFrame();
				onSplitDrag?.(null);
				const point = dragPoint.current;
				dragPoint.current = null;
				if (point && onSplitDrop?.(key, point)) {
					orderDraftRef.current = null;
					setOrderDraft(null);
					endDrag();
					justDragged.current = true;
					setTimeout(() => (justDragged.current = false), 0);
					return;
				}
				commitReorder();
			},
			whileDrag: { scale: 1.02, zIndex: 3 },
			onClickCapture: (e: React.MouseEvent) => {
				if (justDragged.current) {
					e.stopPropagation();
					e.preventDefault();
				}
			},
			className: dropSlot?.key === key ? `${TAB_ITEM} ${TAB_ITEM_DRAGGING}` : TAB_ITEM,
		};
	}

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

	// Closed sessions of this workspace, if there are any to offer.
	const hasHistory = showHistory && archived.length > 0;

	// One session and no view tabs → no strip. A bar holding a single tab is a
	// row of chrome that names what the header already names, so it goes: the
	// lone workspace's "+ New tab" button lives next to the session title in the
	// header instead, and its closed sessions move to the header's ⋯ menu. But
	// once a non-session pane (Review) is open, the strip appears so it has
	// somewhere to live — a lone code session then reads as [session][Review].
	if (!inSplit && tabs.length <= 1 && viewTabs.length === 0) return null;

	// New-tab "+" — plain-click shares the workspace worktree; right-click offers
	// the stacked/ask modes.
	const newTabButton = (
		<button
			type="button"
			className={TAB_NEW}
			data-menu-open={newMenu ? "" : undefined}
			aria-label="New session in this workspace"
			title="New session. Shares this workspace's worktree (right-click for options)"
			onClick={() => onNewSession("share")}
			onContextMenu={(e) => {
				e.preventDefault();
				setNewMenu({ x: e.clientX, y: e.clientY });
			}}
		>
			<IconPlus size={ctrlIconSize} />
		</button>
	);

	// History: every archived (closed) session of this workspace, in one list.
	// Clicking a row opens the session read-only-ish (it gets a tab while viewed);
	// the ⟲ restores it into the strip for good.
	const historyMenu = hasHistory && (
		<Menu.Root>
			<Menu.Trigger className={TAB_HISTORY} aria-label="Archived sessions" title="Archived sessions">
				<IconHistory size={ctrlIconSize} />
			</Menu.Trigger>
			<Menu.Popup align="end" sideOffset={4} className="min-w-[240px] max-w-[320px]">
				<ArchivedSessionItems sessions={archived} onSelect={onSelect} onRestore={onRestore} />
			</Menu.Popup>
		</Menu.Root>
	);

	return (
		<div className={cn(TAB_STRIP, !inSplit && "desktop:-mt-[5px]")} role="tablist">
			<div className={TAB_SCROLL} ref={scrollRef}>
				<Reorder.Group
					as="div"
					axis="x"
					ref={groupRef}
					className={TAB_GROUP}
					values={orderedKeys}
					onReorder={reorderTabs}
				>
					{/* First child so the tabs sliding over it paint on top. */}
					{dropSlot && (
						<div
							className={TAB_DROP_SLOT}
							style={{ left: dropSlot.left, width: dropSlot.width }}
							aria-hidden="true"
						/>
					)}
					{orderedMembers.map((member) => {
						const key = member.id;
						// A view pane (Review, Assets, …): the same draggable item as a
						// session, minus the rename/color/transcript menu it has no use for.
						if (member.kind === "view") {
							const v = member.view;
							return (
								<Reorder.Item key={key} {...reorderItemProps(key)}>
									<div
										role="tab"
										aria-selected={v.active}
										aria-label={v.icon ? v.label : undefined}
										className={`session-tab-view group/tab ${tabClass({ active: v.active, waiting: false, colored: false })}`}
										onClick={() => onSelectView(v.id)}
										title={v.label}
									>
										{v.dotClass && <span className={`${PANEL_TAB_DOT} ${v.dotClass}`} />}
										{v.icon ? (
											<span className={TAB_VICON} aria-hidden="true">
												{v.icon}
											</span>
										) : (
											<span className={TAB_TITLE}>{v.label}</span>
										)}
										{v.closable !== false && (
											<button
												type="button"
												className={tabCloseClass(v.active)}
												aria-label={`Close ${v.label}`}
												title={`Close ${v.label}`}
												onClick={(e) => {
													e.stopPropagation();
													onCloseView(v.id);
												}}
											>
												×
											</button>
										)}
									</div>
								</Reorder.Item>
							);
						}
						const session = member.session;
						const waiting = !!session.waitingForInput;
						const hex = colorHex(colors[key]);
						return (
							<Reorder.Item key={key} {...reorderItemProps(key)}>
								<ContextMenu.Root>
									<ContextMenu.Trigger
										render={
											<div
												role="tab"
												aria-selected={key === activeId}
												className={`group/tab ${tabClass({
													active: key === activeId,
													waiting,
													colored: !!hex,
												})}`}
												style={hex ? ({ "--tab-color": hex } as React.CSSProperties) : undefined}
												onClick={() => onSelect(session)}
												title={session.title}
											/>
										}
									>
										{waiting ? (
											<span className={tabDotClass(true)} />
										) : (
											session.isRunning && <span className={tabDotClass(false)} />
										)}
										{editKey === key ? (
											<input
												className={TAB_RENAME}
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
												className={TAB_TITLE}
												onDoubleClick={(e) => {
													e.stopPropagation();
													setDraft(session.title);
													setEditKey(key);
												}}
											>
												{session.title}
											</span>
										)}
										{/* Who else is in this tab. The sidebar's workspace row shows
							    the same faces for the whole strip, which says a teammate
							    is in here somewhere; on the tab it says where. Shown on
							    the open tab too — being in the same session as someone is
							    exactly what you want to know. */}
										{(() => {
											const here = viewers?.[key] || [];
											if (!here.length) return null;
											const shown = here.slice(0, 2);
											const rest = here.length - shown.length;
											const label = `${here.join(", ")} ${here.length > 1 ? "are" : "is"} here`;
											return (
												<span className={TAB_FACES} aria-label={label} title={label}>
													{shown.map((viewer) => (
														<UserAvatar
															key={viewer}
															name={viewer}
															size={14}
															className={TAB_FACE}
														/>
													))}
													{rest > 0 && (
														<span className={TAB_FACES_MORE} aria-hidden="true">
															+{rest}
														</span>
													)}
												</span>
											);
										})()}
										{/* Unsent draft in a sibling session (the active tab's draft is
							    already on screen in the composer — no pencil needed). */}
										{key !== activeId && hasDraft(`session:${key}`) && (
											<span className={TAB_DRAFT} title="Unsent draft">
												<IconPencil size={20} />
											</span>
										)}
										<button
											type="button"
											className={tabCloseClass(key === activeId)}
											aria-label="Close session"
											title="Close session"
											onClick={(e) => {
												e.stopPropagation();
												onClose(session);
											}}
										>
											×
										</button>
									</ContextMenu.Trigger>
									{/* finalFocus=false: "Rename session" mounts the inline rename
							    input (autoFocus) — the closing menu must not steal focus
							    back to the tab. */}
									<ContextMenu.Popup className="min-w-[250px]" finalFocus={false}>
										<ContextMenu.Item
											onClick={() => {
												setDraft(session.title);
												setEditKey(key);
											}}
										>
											<span className="grow">Rename session</span>
										</ContextMenu.Item>
										{/* The cross-bar drag, spelled out: a bar down to its last
								    tab has no room to show a drag, and this is also the
								    only way back for someone who never found the gesture. */}
										{onMoveAcross && (
											<ContextMenu.Item onClick={() => onMoveAcross(key)}>
												<span className="grow">Move to {moveAcrossSide} side</span>
											</ContextMenu.Item>
										)}
										<ContextMenu.Separator />
										<ContextMenu.SubmenuRoot>
											<ContextMenu.SubmenuTrigger>
												<span className="grow">Copy transcript</span>
												<IconChevronRight size={16} className="text-faint" />
											</ContextMenu.SubmenuTrigger>
											<Menu.Popup>
												<Menu.Item onClick={() => void copySessionTranscript(session, "concise", onToast)}>
													<span className="grow">Concise</span>
													{key === activeId && copyTranscriptLabel && (
														<Menu.Shortcut>{copyTranscriptLabel}</Menu.Shortcut>
													)}
												</Menu.Item>
												<Menu.Item onClick={() => void copySessionTranscript(session, "full", onToast)}>
													<span className="grow">Full</span>
												</Menu.Item>
											</Menu.Popup>
										</ContextMenu.SubmenuRoot>
										<ContextMenu.Item
											onClick={() => copyToClipboard(absoluteLink(sessionPath(session)), () => onToast("Link copied"))}
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
													className={cn(TAB_SWATCH, colors[key] === c.key && TAB_SWATCH_ON)}
													style={{ background: c.hex }}
													aria-label={c.label}
													title={c.label}
													onClick={() => onSetColor(key, c.key)}
												/>
											))}
											<button
												type="button"
												className={cn(TAB_SWATCH, TAB_SWATCH_NONE)}
												aria-label="No color"
												title="No color"
												onClick={() => onSetColor(key, null)}
											/>
										</ContextMenu.Item>
										<ContextMenu.Separator />
										<ContextMenu.Item onClick={() => onClose(session)}>
											<span className="grow">Close tab</span>
											{key === activeId && closeLabel && (
												<ContextMenu.Shortcut>{closeLabel}</ContextMenu.Shortcut>
											)}
										</ContextMenu.Item>
									</ContextMenu.Popup>
								</ContextMenu.Root>
							</Reorder.Item>
						);
					})}
				</Reorder.Group>
				{/* Phone: the +/history controls scroll WITH the tabs so the strip
					    uses the full width — nothing pinned eating horizontal room. */}
				{isPhone && newTabButton}
				{isPhone && historyMenu}
			</div>
			{/* Desktop: the "+" sits OUTSIDE the scroll so it's pinned and always
				    visible — never scrolled off when the tabs overflow a narrow pane. */}
			{!isPhone && newTabButton}
			{!isPhone && <div className={TAB_ACTIONS}>{historyMenu}</div>}

			{newMenu && (
				<div
					className={NEW_MENU}
					style={{ left: newMenu.x, top: newMenu.y }}
					onClick={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						className={NEW_MENU_ITEM}
						onClick={() => {
							setNewMenu(null);
							onNewSession("share");
						}}
					>
						New session · share worktree
					</button>
					<button
						type="button"
						className={NEW_MENU_ITEM}
						onClick={() => {
							setNewMenu(null);
							onNewSession("stack");
						}}
					>
						New session · stacked worktree
					</button>
					<button
						type="button"
						className={NEW_MENU_ITEM}
						onClick={() => {
							setNewMenu(null);
							onNewSession("ask");
						}}
					>
						New session · ask (no worktree)
					</button>
				</div>
			)}
		</div>
	);
}
