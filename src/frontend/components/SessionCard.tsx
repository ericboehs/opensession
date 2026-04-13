import React, { useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime, deleteSessionApi } from "../lib/api";

const SOURCE_COLORS: Record<string, string> = {
  slack: "#4A154B",
  linear: "#5E6AD2",
  backstage: "#0D9488",
  cli: "#6B7280",
};

interface Props {
  session: UnifiedSession;
  onClick: () => void;
  onDeleted: () => void;
}

export function SessionCard({ session, onClick, onDeleted }: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const statusColor = session.isRunning
    ? "#22c55e"
    : isRecent(session.lastActivity)
      ? "#eab308"
      : "#6b7280";

  async function handleDelete(cleanWorktree: boolean) {
    setDeleting(true);
    try {
      await deleteSessionApi(session.id, cleanWorktree);
      onDeleted();
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    } finally {
      setDeleting(false);
      setShowConfirm(false);
    }
  }

  return (
    <div className="session-card" onClick={showConfirm ? undefined : onClick}>
      <div className="session-card-header">
        <span
          className="source-badge"
          style={{ backgroundColor: SOURCE_COLORS[session.source] || "#6B7280" }}
        >
          {session.source}
        </span>
        <div className="session-card-actions">
          {!showConfirm && (
            <button
              className="btn-delete-small"
              title="Delete session"
              onClick={(e) => {
                e.stopPropagation();
                setShowConfirm(true);
              }}
            >
              ×
            </button>
          )}
          <span className="status-dot" style={{ backgroundColor: statusColor }} />
        </div>
      </div>

      <div className="session-card-title">{session.title}</div>
      {session.branch && session.title !== session.branch && (
        <div className="session-card-branch">{session.branch}</div>
      )}

      {/* Links row */}
      {(session.prUrl || session.linearIssue?.url) && (
        <div className="session-card-links">
          {session.prUrl && (
            <a
              href={session.prUrl}
              target="_blank"
              rel="noopener"
              className="session-link session-link-pr"
              onClick={(e) => e.stopPropagation()}
            >
              PR
            </a>
          )}
          {session.linearIssue?.url && (
            <a
              href={session.linearIssue.url}
              target="_blank"
              rel="noopener"
              className="session-link session-link-linear"
              onClick={(e) => e.stopPropagation()}
            >
              {session.linearIssue.identifier}
            </a>
          )}
        </div>
      )}

      <div className="session-card-meta">
        {session.startedBy && <span>{session.startedBy}</span>}
        <span className="session-card-time">{relativeTime(session.lastActivity)}</span>
      </div>

      {showConfirm && (
        <div className="delete-confirm" onClick={(e) => e.stopPropagation()}>
          <span className="delete-confirm-text">Delete session{session.worktreeDir ? " and worktree?" : "?"}</span>
          <div className="delete-confirm-buttons">
            {session.worktreeDir && (
              <button
                className="btn-delete-wt"
                onClick={() => handleDelete(true)}
                disabled={deleting}
              >
                {deleting ? "..." : "Session + Worktree"}
              </button>
            )}
            <button
              className="btn-delete-only"
              onClick={() => handleDelete(false)}
              disabled={deleting}
            >
              {deleting ? "..." : "Session only"}
            </button>
            <button
              className="btn-delete-cancel"
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function isRecent(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() < 3_600_000;
}
