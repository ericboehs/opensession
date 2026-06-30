import React, { useState, useMemo, useEffect } from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime } from "../lib/api";
import { useCurrentUser, TEAM } from "./UserPicker";
import { getPins, onPinsChanged } from "../lib/pins";
import { getRecents, onRecentsChanged } from "../lib/recents";

const RECENTLY_OPENED_COUNT = 6;

const AUTOMATION_COLOR = "#d29922";

// A palette for per-person group dots. The color is picked deterministically
// from the (lowercased) person name so each teammate keeps a stable color.
const PERSON_COLORS = [
  "#e8836b",
  "#6ba5e8",
  "#8ed99c",
  "#e8c46b",
  "#c06be8",
  "#6be8d2",
  "#e86b9c",
  "#a3b86b",
];

function personColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length];
}

// Only recognized people get their own "people" section. Sessions whose
// `startedBy` is something other than a real teammate — test labels
// ("proof-test", "image-test"), action/integration names ("Slack",
// "Make Michiel editor (action)"), or empty — are hidden rather than shown as
// stray sections. "Michael" (the assistant) counts as a person here.
const KNOWN_PEOPLE = new Set([...TEAM, "Michael"].map((n) => n.toLowerCase()));

export type NavView = "sessions" | "reviews" | "automations" | "actions" | "wiki" | "connections";

interface Props {
  sessions: UnifiedSession[];
  selectedId: string | null;
  activeView: NavView;
  onNavigate: (view: NavView) => void;
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
  onOpenArchived: () => void;
  onArchive: (session: UnifiedSession) => void;
}

const NAV_ITEMS: Array<{ view: NavView; label: string; icon: React.ReactNode }> = [
  {
    view: "sessions",
    label: "Sessions",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M2.5 4h11M2.5 8h11M2.5 12h7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: "reviews",
    label: "Reviews",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="4" cy="4" r="1.6" />
        <circle cx="4" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <path d="M4 5.6v4.8M12 10.4V8a2.4 2.4 0 0 0-2.4-2.4H7.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.8 4.2L7.2 5.6l1.6 1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    view: "automations",
    label: "Automations",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    view: "actions",
    label: "Actions",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M8.5 1.5L3 9h4l-.5 5.5L13 7H9l-.5-5.5z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    view: "wiki",
    label: "Wiki",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M3 2.5h7a2 2 0 0 1 2 2v9l-3-1.8-3 1.8-3-1.8V2.5z" strokeLinejoin="round" transform="translate(0.5,0)" />
      </svg>
    ),
  },
  {
    view: "connections",
    label: "Connections",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="4.5" cy="8" r="2" />
        <circle cx="11.5" cy="4" r="2" />
        <circle cx="11.5" cy="12" r="2" />
        <path d="M6.3 7.1l3.4-2.2M6.3 8.9l3.4 2.2" strokeLinecap="round" />
      </svg>
    ),
  },
];

// Groups are rendered in three visually separated bands (spacing between each):
//   "personal"    — Recently opened, Pinned, My sessions
//   "people"      — one group per other teammate (+ ownerless source groups)
//   "automations" — one group per automation
type GroupBand = "personal" | "people" | "automations";

interface Group {
  key: string;
  label: string;
  dotColor: string | null;
  band: GroupBand;
  items: UnifiedSession[];
}

const EXPANDED_KEY = "michael-sidebar-expanded";

function readExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '["recently","pinned","mine"]'));
  } catch {
    return new Set(["recently", "pinned", "mine"]);
  }
}

export function Sidebar({
  sessions,
  selectedId,
  activeView,
  onNavigate,
  onSelect,
  onNewSession,
  onOpenArchived,
  onArchive,
}: Props) {
  const [search, setSearch] = useState("");
  // Groups are collapsed by default; the expanded set persists per browser
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [pins, setPins] = useState<string[]>(getPins);
  const [recents, setRecents] = useState<string[]>(getRecents);
  const currentUser = useCurrentUser();

  useEffect(() => onPinsChanged(() => setPins(getPins())), []);
  useEffect(() => onRecentsChanged(() => setRecents(getRecents())), []);

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

    // "Recently opened": a quick-access shortcut to the sessions you last opened
    // (newest first). Hidden while searching; items still appear in their normal
    // groups below. Only the freshest few are shown.
    if (!search.trim()) {
      const byId = new Map(filtered.map((s) => [s.id, s] as const));
      const recentItems = recents
        .map((id) => byId.get(id))
        .filter((s): s is UnifiedSession => Boolean(s))
        .slice(0, RECENTLY_OPENED_COUNT);
      if (recentItems.length > 0) {
        out.push({
          key: "recently",
          label: "Recently opened",
          dotColor: null,
          band: "personal",
          items: recentItems,
        });
      }
    }

    const pinned = filtered.filter((s) => pinSet.has(s.id));
    if (pinned.length > 0) {
      out.push({ key: "pinned", label: "Pinned", dotColor: null, band: "personal", items: pinned });
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
      out.push({ key: "mine", label: "My sessions", dotColor: null, band: "personal", items: mine });
    }

    // One group per other person: every non-automation session owned by
    // someone other than the current user, grouped by `startedBy`. The current
    // user's own sessions already live in "My sessions" above, so they're not
    // repeated here (no double-listing). Only recognized teammates get a
    // section — sessions with an unrecognized or empty `startedBy` are hidden
    // (see KNOWN_PEOPLE). Keyed by lowercased name to merge casing variants;
    // the first-seen spelling is used as the label.
    const byPerson = new Map<string, { label: string; items: UnifiedSession[] }>();
    for (const s of filtered) {
      if (s.automation || pinSet.has(s.id) || !s.startedBy) continue;
      const key = s.startedBy.toLowerCase();
      if (key === user) continue; // already in "My sessions"
      if (!KNOWN_PEOPLE.has(key)) continue; // hide non-person owners
      const entry = byPerson.get(key) || { label: s.startedBy, items: [] };
      entry.items.push(s);
      byPerson.set(key, entry);
    }
    for (const key of Array.from(byPerson.keys()).sort()) {
      const { label, items } = byPerson.get(key)!;
      out.push({
        key: `person:${key}`,
        label,
        dotColor: personColor(key),
        band: "people",
        items,
      });
    }

    // Automations last, each in its own group (band "automations").
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
        band: "automations",
        items: byAutomation.get(name)!,
      });
    }

    return out;
  }, [filtered, currentUser, pins, recents, search]);

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

  // Distinct open PRs (deduped by URL) — shown as a badge on the Reviews tab.
  const openPrCount = useMemo(() => {
    const urls = new Set<string>();
    for (const s of sessions) {
      if (s.prUrl && s.prState === "OPEN" && !s.archived) urls.add(s.prUrl);
    }
    return urls.size;
  }, [sessions]);

  return (
    <div className="sidebar">
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            className={`sidebar-nav-item ${activeView === item.view ? "active" : ""}`}
            onClick={() => onNavigate(item.view)}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            {item.label}
            {item.view === "reviews" && openPrCount > 0 && (
              <span className="sidebar-nav-count">{openPrCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-section-label">Sessions</div>

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
        {groups.map((group, i) => (
          <div
            key={group.key}
            className={`sidebar-group${
              i > 0 && group.band !== groups[i - 1].band ? " sidebar-group--band-start" : ""
            }`}
          >
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
                  onArchive={() => onArchive(s)}
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
  onArchive,
}: {
  session: UnifiedSession;
  selected: boolean;
  onClick: () => void;
  onArchive: () => void;
}) {
  const running = session.isRunning;
  const recent = isRecent(session.lastActivity);
  const waiting = !!session.waitingForInput;

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
      className={`sidebar-item ${selected ? "sidebar-item-selected" : ""} ${waiting ? "sidebar-item-waiting" : ""}`}
      onClick={onClick}
      title={waiting ? "Waiting for your input" : undefined}
    >
      <div className="sidebar-item-top">
        {(waiting || running || recent) && (
          <span
            className={`sidebar-item-status ${
              waiting
                ? "sidebar-status-waiting"
                : running
                  ? "sidebar-status-running"
                  : "sidebar-status-recent"
            }`}
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
      <span
        className="sidebar-item-x"
        role="button"
        aria-label="Archive session"
        title="Archive session"
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
      >
        ×
      </span>
    </button>
  );
}

function isRecent(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() < 3_600_000;
}
