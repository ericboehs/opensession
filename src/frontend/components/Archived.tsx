import React, { useState, useMemo, useEffect } from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime, archiveSessionApi } from "../lib/api";

interface Props {
  sessions: UnifiedSession[];
  onSelect: (session: UnifiedSession) => void;
  onChanged: () => void;
}

export function Archived({ sessions, onSelect, onChanged }: Props) {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Archived — Michael";
    return () => {
      document.title = "Michael — Tella";
    };
  }, []);

  const archived = useMemo(() => {
    const list = sessions.filter((s) => s.archived);
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.branch || "").toLowerCase().includes(q) ||
        (s.startedBy || "").toLowerCase().includes(q) ||
        (s.automation || "").toLowerCase().includes(q)
    );
  }, [sessions, search]);

  async function handleUnarchive(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setBusy(id);
    try {
      await archiveSessionApi(id, false);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="automations">
      <div className="page-header">
        <div>
          <h2 className="page-title">Archived</h2>
          <div className="page-sub">
            {archived.length} archived session{archived.length === 1 ? "" : "s"} — done Plain
            tickets and anything idle for over a week land here automatically.
          </div>
        </div>
        <input
          className="sidebar-search"
          style={{ maxWidth: 260 }}
          placeholder="Search archived…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {archived.length === 0 ? (
        <div className="automations-empty">
          <p>Nothing archived{search ? " matches" : " yet"}.</p>
        </div>
      ) : (
        <div className="home-rows">
          {archived.slice(0, 200).map((s) => (
            <button key={s.id} className="home-row" onClick={() => onSelect(s)}>
              <span className="home-row-main">
                <span className="home-row-title">{s.title}</span>
                <span className="home-row-meta">
                  <span className={`source-chip source-${s.mode === "ask" ? "ask" : s.source}`}>
                    {s.automation || (s.mode === "ask" ? "ask" : s.source)}
                  </span>
                  {s.startedBy && <span>{s.startedBy}</span>}
                  <span>{relativeTime(s.lastActivity)}</span>
                </span>
              </span>
              <span
                className="btn-small"
                role="button"
                onClick={(e) => handleUnarchive(e, s.id)}
              >
                {busy === s.id ? "…" : "Unarchive"}
              </span>
            </button>
          ))}
          {archived.length > 200 && (
            <div className="home-empty">Showing first 200 — refine the search to find older ones.</div>
          )}
        </div>
      )}
    </div>
  );
}
