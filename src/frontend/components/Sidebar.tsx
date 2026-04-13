import React, { useState, useMemo } from "react";
import type { UnifiedSession, SessionSource } from "../lib/types";
import { relativeTime } from "../lib/api";

const SOURCE_COLORS: Record<string, string> = {
  slack: "#4A154B",
  linear: "#5E6AD2",
  backstage: "#0D9488",
  cli: "#6B7280",
};

const SOURCE_ORDER: SessionSource[] = ["slack", "linear", "backstage", "cli"];

interface Props {
  sessions: UnifiedSession[];
  selectedId: string | null;
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
}

export function Sidebar({ sessions, selectedId, onSelect, onNewSession }: Props) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.branch || "").toLowerCase().includes(q) ||
        (s.startedBy || "").toLowerCase().includes(q)
    );
  }, [sessions, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, UnifiedSession[]>();
    for (const source of SOURCE_ORDER) {
      const items = filtered.filter((s) => s.source === source);
      if (items.length > 0) {
        map.set(source, items);
      }
    }
    return map;
  }, [filtered]);

  function toggleGroup(source: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
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
        {grouped.size === 0 && (
          <div className="sidebar-empty">No sessions</div>
        )}
        {Array.from(grouped.entries()).map(([source, items]) => (
          <div key={source} className="sidebar-group">
            <button
              className="sidebar-group-header"
              onClick={() => toggleGroup(source)}
            >
              <span className="sidebar-group-chevron">
                {collapsed.has(source) ? "▸" : "▾"}
              </span>
              <span
                className="sidebar-group-dot"
                style={{ backgroundColor: SOURCE_COLORS[source] || "#6B7280" }}
              />
              <span className="sidebar-group-name">{source}</span>
              <span className="sidebar-group-count">{items.length}</span>
            </button>

            {!collapsed.has(source) &&
              items.map((s) => (
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
        {session.startedBy && (
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
