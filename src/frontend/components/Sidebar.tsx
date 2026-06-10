import React, { useState, useMemo } from "react";
import type { UnifiedSession, SessionSource } from "../lib/types";
import { relativeTime } from "../lib/api";
import { useCurrentUser } from "./UserPicker";

const SOURCE_COLORS: Record<string, string> = {
  slack: "#4A154B",
  linear: "#5E6AD2",
  backstage: "#0D9488",
  cli: "#6B7280",
};

const AUTOMATION_COLOR = "#d29922";

const SOURCE_ORDER: SessionSource[] = ["slack", "linear", "backstage", "cli"];

interface Props {
  sessions: UnifiedSession[];
  selectedId: string | null;
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
}

interface Group {
  key: string;
  label: string;
  dotColor: string | null;
  items: UnifiedSession[];
}

export function Sidebar({ sessions, selectedId, onSelect, onNewSession }: Props) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const currentUser = useCurrentUser();

  const filtered = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.branch || "").toLowerCase().includes(q) ||
        (s.startedBy || "").toLowerCase().includes(q) ||
        (s.automation || "").toLowerCase().includes(q)
    );
  }, [sessions, search]);

  const groups = useMemo(() => {
    const out: Group[] = [];
    const user = currentUser.toLowerCase();

    // "Mine": sessions started by the current user (automations excluded)
    const mine = filtered.filter(
      (s) => !s.automation && s.startedBy && s.startedBy.toLowerCase() === user
    );
    if (mine.length > 0) {
      out.push({ key: "mine", label: `${currentUser}'s sessions`, dotColor: null, items: mine });
    }

    // One group per automation
    const byAutomation = new Map<string, UnifiedSession[]>();
    for (const s of filtered) {
      if (!s.automation) continue;
      const list = byAutomation.get(s.automation) || [];
      list.push(s);
      byAutomation.set(s.automation, list);
    }
    for (const name of Array.from(byAutomation.keys()).sort()) {
      out.push({
        key: `auto:${name}`,
        label: name,
        dotColor: AUTOMATION_COLOR,
        items: byAutomation.get(name)!,
      });
    }

    // Source groups (automation sessions live in their own groups above)
    for (const source of SOURCE_ORDER) {
      const items = filtered.filter((s) => s.source === source && !s.automation);
      if (items.length > 0) {
        out.push({
          key: source,
          label: source,
          dotColor: SOURCE_COLORS[source] || "#6B7280",
          items,
        });
      }
    }
    return out;
  }, [filtered, currentUser]);

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <input
          className="sidebar-search"
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="sidebar-new-btn" onClick={onNewSession} title="New session">
          +
        </button>
      </div>

      <div className="sidebar-list">
        {groups.length === 0 && <div className="sidebar-empty">No sessions</div>}
        {groups.map((group) => (
          <div key={group.key} className="sidebar-group">
            <button
              className="sidebar-group-header"
              onClick={() => toggleGroup(group.key)}
            >
              <span className="sidebar-group-chevron">
                {collapsed.has(group.key) ? "▸" : "▾"}
              </span>
              {group.dotColor && (
                <span
                  className="sidebar-group-dot"
                  style={{ backgroundColor: group.dotColor }}
                />
              )}
              <span className="sidebar-group-name">{group.label}</span>
              <span className="sidebar-group-count">{group.items.length}</span>
            </button>

            {!collapsed.has(group.key) &&
              group.items.map((s) => (
                <SidebarItem
                  key={s.id}
                  session={s}
                  selected={s.id === selectedId}
                  onClick={() => onSelect(s)}
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SidebarItem({
  session,
  selected,
  onClick,
}: {
  session: UnifiedSession;
  selected: boolean;
  onClick: () => void;
}) {
  const statusColor = session.isRunning
    ? "var(--green)"
    : isRecent(session.lastActivity)
      ? "var(--yellow)"
      : "transparent";

  return (
    <button
      className={`sidebar-item ${selected ? "sidebar-item-selected" : ""}`}
      onClick={onClick}
    >
      <div className="sidebar-item-top">
        <span className="sidebar-item-status" style={{ backgroundColor: statusColor }} />
        <span className="sidebar-item-title">{session.title}</span>
      </div>
      <div className="sidebar-item-meta">
        {session.startedBy && !session.automation && (
          <span className="sidebar-item-user">{session.startedBy}</span>
        )}
        <span className="sidebar-item-time">{relativeTime(session.lastActivity)}</span>
      </div>
      {(session.prUrl || session.linearIssue) && (
        <div className="sidebar-item-badges">
          {session.prUrl && (
            <span className={`sidebar-badge ${session.prState === "MERGED" ? "badge-merged" : session.prState === "CLOSED" ? "badge-closed" : "badge-pr"}`}>
              PR{session.prState === "MERGED" ? " ✓" : ""}
            </span>
          )}
          {session.linearIssue && (
            <span className="sidebar-badge badge-linear">
              {session.linearIssue.identifier}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function isRecent(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() < 3_600_000;
}
