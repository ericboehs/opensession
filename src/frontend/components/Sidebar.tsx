import React, { useState, useMemo, useEffect } from "react";
import type { UnifiedSession, SessionSource } from "../lib/types";
import { relativeTime } from "../lib/api";
import { useCurrentUser } from "./UserPicker";
import { getPins, onPinsChanged } from "../lib/pins";

const SOURCE_COLORS: Record<string, string> = {
  slack: "#a36ba5",
  linear: "#7b86e8",
  backstage: "#5eead4",
  cli: "#6B7280",
};

const AUTOMATION_COLOR = "#d29922";

const SOURCE_ORDER: SessionSource[] = ["slack", "linear", "backstage", "cli"];

interface Props {
  sessions: UnifiedSession[];
  selectedId: string | null;
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
  onOpenArchived: () => void;
}

interface Group {
  key: string;
  label: string;
  dotColor: string | null;
  items: UnifiedSession[];
}

const EXPANDED_KEY = "michael-sidebar-expanded";

function readExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '["pinned","mine"]'));
  } catch {
    return new Set(["pinned", "mine"]);
  }
}

export function Sidebar({ sessions, selectedId, onSelect, onNewSession, onOpenArchived }: Props) {
  const [search, setSearch] = useState("");
  // Groups are collapsed by default; the expanded set persists per browser
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [pins, setPins] = useState<string[]>(getPins);
  const currentUser = useCurrentUser();

  useEffect(() => onPinsChanged(() => setPins(getPins())), []);

  const archivedCount = useMemo(() => sessions.filter((s) => s.archived).length, [sessions]);

  const filtered = useMemo(() => {
    const visible = sessions.filter((s) => !s.archived);
    if (!search) return visible;
    const q = search.toLowerCase();
    return visible.filter(
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
    const pinSet = new Set(pins);

    const pinned = filtered.filter((s) => pinSet.has(s.id));
    if (pinned.length > 0) {
      out.push({ key: "pinned", label: "Pinned", dotColor: null, items: pinned });
    }

    // "Mine": sessions started by the current user (automations excluded)
    const mine = filtered.filter(
      (s) =>
        !s.automation &&
        !pinSet.has(s.id) &&
        s.startedBy &&
        s.startedBy.toLowerCase() === user
    );
    if (mine.length > 0) {
      out.push({ key: "mine", label: "My sessions", dotColor: null, items: mine });
    }

    // One group per automation
    const byAutomation = new Map<string, UnifiedSession[]>();
    for (const s of filtered) {
      if (!s.automation || pinSet.has(s.id)) continue;
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
      const items = filtered.filter(
        (s) => s.source === source && !s.automation && !pinSet.has(s.id)
      );
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
  }, [filtered, currentUser, pins]);

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  // While searching, show everything that matched
  const isOpen = (key: string) => search.trim().length > 0 || expanded.has(key);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-search-wrap">
          <svg className="sidebar-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M14 14L10.7 10.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            className="sidebar-search"
            type="text"
            placeholder="Search sessions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
              {group.dotColor && (
                <span
                  className="sidebar-group-dot"
                  style={{ backgroundColor: group.dotColor }}
                />
              )}
              <span className="sidebar-group-name">{group.label}</span>
              <span className="sidebar-group-count">{group.items.length}</span>
              <span className="sidebar-group-chevron">
                {isOpen(group.key) ? "▾" : "▸"}
              </span>
            </button>

            {isOpen(group.key) &&
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

        {archivedCount > 0 && (
          <button className="sidebar-archived-link" onClick={onOpenArchived}>
            Archived ({archivedCount}) →
          </button>
        )}
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
  const running = session.isRunning;
  const recent = isRecent(session.lastActivity);

  const metaParts: React.ReactNode[] = [];
  if (session.startedBy && !session.automation) {
    metaParts.push(<span key="u">{session.startedBy}</span>);
  }
  metaParts.push(<span key="t">{relativeTime(session.lastActivity)}</span>);
  if (session.prUrl) {
    metaParts.push(
      <span
        key="pr"
        className={
          session.prState === "MERGED"
            ? "sidebar-meta-merged"
            : session.prState === "CLOSED"
              ? "sidebar-meta-closed"
              : "sidebar-meta-pr"
        }
      >
        {session.prState === "MERGED" ? "merged" : session.prState === "CLOSED" ? "closed" : "PR open"}
      </span>
    );
  }
  if (session.linearIssue) {
    metaParts.push(
      <span key="lin" className="sidebar-meta-linear">
        {session.linearIssue.identifier}
      </span>
    );
  }

  return (
    <button
      className={`sidebar-item ${selected ? "sidebar-item-selected" : ""}`}
      onClick={onClick}
    >
      <div className="sidebar-item-top">
        {(running || recent) && (
          <span
            className={`sidebar-item-status ${running ? "sidebar-status-running" : "sidebar-status-recent"}`}
          />
        )}
        <span className="sidebar-item-title">{session.title}</span>
      </div>
      <div className="sidebar-item-meta">
        {metaParts.map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sidebar-meta-sep">·</span>}
            {part}
          </React.Fragment>
        ))}
      </div>
    </button>
  );
}

function isRecent(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() < 3_600_000;
}
