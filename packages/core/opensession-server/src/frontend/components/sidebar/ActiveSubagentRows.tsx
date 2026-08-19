import type { ActiveWorkspaceSubagent } from "../../lib/sidebar-workspaces";
import {
	SIDEBAR_HOVER_LAYER,
	SIDEBAR_RAIL,
	SIDEBAR_RAIL_GAP,
	SIDEBAR_RAIL_PAD,
	SIDEBAR_STATUS_DOT,
} from "../../lib/sidebar-classes";
import type { UnifiedSession } from "../../lib/types";
import { cn } from "../../ui/cn";
import { IconArrowDownRight } from "../icons";
import { SIDEBAR_ROW_TITLE } from "./SidebarItem";
import type { CSSProperties } from "react";

function stateLabel(session: UnifiedSession): string {
	if (session.waitingForInput) return "Waiting for input";
	if (session.isRunning) return "Running";
	return "Queued";
}

/** Active workers nested directly under their selected workspace row. */
export function ActiveSubagentRows({
	items,
	selectedId,
	onSelect,
}: {
	items: ActiveWorkspaceSubagent[];
	selectedId: string | null;
	onSelect: (session: UnifiedSession) => void;
}) {
	if (items.length === 0) return null;
	return (
		<div data-active-subagents="">
			{items.map(({ session, depth }) => {
				const selected = session.id === selectedId;
				const label = stateLabel(session);
				return (
					<button
						type="button"
						key={session.id}
						className={cn(
							"group relative mt-0.5 flex w-full items-center rounded-row border-0 bg-transparent py-[var(--sidebar-row-pad)] pr-2 text-left text-fg phone:py-[13px]",
							SIDEBAR_RAIL_GAP,
							SIDEBAR_RAIL_PAD,
							SIDEBAR_HOVER_LAYER,
							selected && "bg-selected",
						)}
						// The rail a child indents to, and it is derived rather than
						// picked: the workspace row above opens with the 22px rail at
						// --sidebar-icon-left (16), then the 7px rail gap, then its
						// 14px repo tile, so that tile's centre sits at 52 and a 22px
						// rail centres there from 41. At the 28 this was, the arrow
						// landed in the gap in front of the tile and the child's title
						// came out to the LEFT of its parent's, which read as a sibling
						// rather than a child. Deeper levels step 12 and stop at the
						// third, so a long chain keeps room for a title.
						style={
							{
								"--sidebar-icon-left": `${41 + Math.min(depth - 1, 2) * 12}px`,
							} as CSSProperties
						}
						data-active-subagent-row=""
						data-parent-session-id={session.parentSessionId}
						data-selected={selected || undefined}
						aria-current={selected ? "page" : undefined}
						aria-label={`${session.title}, subagent, ${label}`}
						onClick={() => onSelect(session)}
					>
						<span className={cn(SIDEBAR_RAIL, "text-faint")} aria-hidden="true">
							<IconArrowDownRight size={16} />
						</span>
						<span className={SIDEBAR_ROW_TITLE}>{session.title}</span>
						<span
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								session.waitingForInput
									? SIDEBAR_STATUS_DOT.waiting
									: session.isRunning
										? SIDEBAR_STATUS_DOT.running
										: "bg-yellow",
							)}
							aria-hidden="true"
							title={label}
						/>
					</button>
				);
			})}
		</div>
	);
}
