import React, { useState } from "react";
import type { UnifiedSession, SessionSource } from "../lib/types";
import { SessionCard } from "./SessionCard";

interface Props {
  sessions: UnifiedSession[];
  loading: boolean;
  onSelectSession: (session: UnifiedSession) => void;
  onNewSession: () => void;
}

type Filter = "all" | SessionSource;

export function Dashboard({ sessions, loading, onSelectSession, onNewSession }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const filtered = sessions.filter((s) => {
    if (filter !== "all" && s.source !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        (s.branch || "").toLowerCase().includes(q) ||
        (s.startedBy || "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  const counts = {
    all: sessions.length,
    slack: sessions.filter((s) => s.source === "slack").length,
    linear: sessions.filter((s) => s.source === "linear").length,
    backstage: sessions.filter((s) => s.source === "backstage").length,
  };

  return (
    <div className="dashboard">
      <div className="dashboard-toolbar">
        <div className="filter-tabs">
          {(["all", "slack", "linear", "backstage"] as const).map((f) => (
            <button
              key={f}
              className={`filter-tab ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f} {counts[f] ? `(${counts[f]})` : ""}
            </button>
          ))}
        </div>
        <input
          className="search-input"
          type="text"
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn-new-session" onClick={onNewSession}>
          + New Session
        </button>
      </div>

      {loading ? (
        <div className="loading">Loading sessions...</div>
      ) : filtered.length === 0 ? (
        <div className="empty">No sessions found</div>
      ) : (
        <div className="session-grid">
          {filtered.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onClick={() => onSelectSession(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
