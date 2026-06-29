import React, { useMemo } from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime } from "../lib/api";
import { PrPanel } from "./PrPanel";

interface Props {
  sessions: UnifiedSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSession: (id: string) => void;
}

function prNumber(url?: string): string | null {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? `#${m[1]}` : null;
}

const STATE_RANK: Record<string, number> = { OPEN: 0, CLOSED: 1, MERGED: 2 };

/**
 * Full-page PR review view: a rail of every PR attached to a Michael session on
 * the left, a GitHub-style review (diff + checks + actions) on the right. Reuses
 * PrPanel for the detail pane so it stays in sync with the session PR tab. Open
 * PRs sort first; one entry per PR (deduped by URL across sessions on a branch).
 */
export function Reviews({ sessions, selectedId, onSelect, onOpenSession }: Props) {
  const prSessions = useMemo(() => {
    const byPr = new Map<string, UnifiedSession>();
    for (const s of sessions) {
      if (!s.prUrl || s.archived) continue;
      const existing = byPr.get(s.prUrl);
      if (!existing || new Date(s.lastActivity) > new Date(existing.lastActivity)) {
        byPr.set(s.prUrl, s);
      }
    }
    return [...byPr.values()].sort((a, b) => {
      const r = (STATE_RANK[a.prState || ""] ?? 1) - (STATE_RANK[b.prState || ""] ?? 1);
      if (r !== 0) return r;
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });
  }, [sessions]);

  const selected =
    prSessions.find((s) => s.id === selectedId) || prSessions[0] || null;

  if (prSessions.length === 0) {
    return (
      <div className="reviews reviews-empty">
        <div className="detail-empty-inner">
          <div className="detail-empty-title">No pull requests yet</div>
          <div className="detail-empty-sub">
            PRs opened by Michael sessions show up here for review.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="reviews">
      <div className="reviews-rail">
        <div className="reviews-rail-title">
          Pull requests <span className="reviews-rail-count">{prSessions.length}</span>
        </div>
        {prSessions.map((s) => {
          const state = s.prState || "OPEN";
          const stateClass =
            state === "MERGED"
              ? "pr-pill-merged"
              : state === "CLOSED"
                ? "pr-pill-closed"
                : "pr-pill-open";
          return (
            <button
              key={s.prUrl}
              className={`reviews-rail-item ${selected?.id === s.id ? "active" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="reviews-rail-item-head">
                <span className={`pr-pill ${stateClass}`}>{state.toLowerCase()}</span>
                {prNumber(s.prUrl) && (
                  <span className="reviews-rail-num">{prNumber(s.prUrl)}</span>
                )}
              </div>
              <div className="reviews-rail-item-title">{s.title}</div>
              <div className="reviews-rail-item-meta">
                {s.branch && <span className="reviews-rail-branch">{s.branch}</span>}
                <span>{relativeTime(s.lastActivity)}</span>
                {s.linearIssue && <span>{s.linearIssue.identifier}</span>}
              </div>
            </button>
          );
        })}
      </div>

      <div className="reviews-detail">
        {selected ? (
          <PrPanel
            key={selected.id}
            sessionId={selected.id}
            onOpenSession={() => onOpenSession(selected.id)}
          />
        ) : (
          <div className="panel-placeholder">Select a pull request to review</div>
        )}
      </div>
    </div>
  );
}
