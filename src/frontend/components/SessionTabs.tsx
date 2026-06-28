import React from "react";
import type { UnifiedSession } from "../lib/types";

interface Props {
  tabs: UnifiedSession[];
  activeId: string | null;
  onSelect: (session: UnifiedSession) => void;
  onUnpin: (id: string) => void;
}

/**
 * Horizontal strip of pinned sessions, rendered above the session title on
 * every view so you can jump between the sessions you care about. Pin/unpin is
 * the existing pins store (star on Home, or the ★ in the session header).
 */
export function SessionTabs({ tabs, activeId, onSelect, onUnpin }: Props) {
  if (tabs.length === 0) return null;

  return (
    <div className="session-tabs" role="tablist">
      {tabs.map((s) => (
        <div
          key={s.id}
          role="tab"
          aria-selected={s.id === activeId}
          className={`session-tab ${s.id === activeId ? "session-tab-active" : ""}`}
          onClick={() => onSelect(s)}
          title={s.title}
        >
          {s.isRunning && <span className="session-tab-dot" />}
          <span className="session-tab-title">{s.title}</span>
          <span
            className="session-tab-close"
            role="button"
            aria-label="Unpin tab"
            title="Unpin"
            onClick={(e) => {
              e.stopPropagation();
              onUnpin(s.id);
            }}
          >
            ×
          </span>
        </div>
      ))}
    </div>
  );
}
