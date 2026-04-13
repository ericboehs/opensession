import React from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime } from "../lib/api";

const SOURCE_COLORS: Record<string, string> = {
  slack: "#4A154B",
  linear: "#5E6AD2",
  backstage: "#0D9488",
  cli: "#6B7280",
};

interface Props {
  session: UnifiedSession;
  onClick: () => void;
}

export function SessionCard({ session, onClick }: Props) {
  const statusColor = session.isRunning ? "#22c55e" : isRecent(session.lastActivity) ? "#eab308" : "#6b7280";

  return (
    <div className="session-card" onClick={onClick}>
      <div className="session-card-header">
        <span
          className="source-badge"
          style={{ backgroundColor: SOURCE_COLORS[session.source] || "#6B7280" }}
        >
          {session.source}
        </span>
        <span className="status-dot" style={{ backgroundColor: statusColor }} />
      </div>
      <div className="session-card-title">{session.title}</div>
      {session.branch && session.title !== session.branch && (
        <div className="session-card-branch">{session.branch}</div>
      )}
      <div className="session-card-meta">
        {session.startedBy && <span>{session.startedBy}</span>}
        <span className="session-card-time">{relativeTime(session.lastActivity)}</span>
      </div>
    </div>
  );
}

function isRecent(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() < 3_600_000; // within 1hr
}
