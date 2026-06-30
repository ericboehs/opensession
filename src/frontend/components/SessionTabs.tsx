import React from "react";
import type { UnifiedSession } from "../lib/types";

interface Props {
  tabs: UnifiedSession[];
  activeId: string | null;
  /** IDs of sessions that are pinned; the rest are transient (current route only). */
  pinnedIds: Set<string>;
  onSelect: (session: UnifiedSession) => void;
  onTogglePin: (id: string) => void;
}

/**
 * Horizontal strip of session tabs above the session title, on every view.
 * Pinned tabs persist (the pins store — star on Home, or the ★ in the session
 * header). The currently-open session also shows as a *transient* tab even when
 * unpinned: like Chrome, it closes as soon as you navigate away. Clicking the
 * ☆ on a transient tab promotes it to a pinned one; the ★ on a pinned tab
 * unpins (removing the tab).
 */
export function SessionTabs({ tabs, activeId, pinnedIds, onSelect, onTogglePin }: Props) {
  if (tabs.length === 0) return null;

  return (
    <div className="session-tabs" role="tablist">
      {tabs.map((s) => {
        const pinned = pinnedIds.has(s.id);
        const waiting = !!s.waitingForInput;
        return (
          <div
            key={s.id}
            role="tab"
            aria-selected={s.id === activeId}
            className={`session-tab ${s.id === activeId ? "session-tab-active" : ""} ${
              pinned ? "" : "session-tab-transient"
            } ${waiting ? "session-tab-waiting" : ""}`}
            onClick={() => onSelect(s)}
            title={waiting ? `${s.title} — waiting for your input` : s.title}
          >
            {waiting ? (
              <span className="session-tab-dot session-tab-dot-waiting" />
            ) : (
              s.isRunning && <span className="session-tab-dot" />
            )}
            <span className="session-tab-title">{s.title}</span>
            <span
              className={`session-tab-pin ${pinned ? "session-tab-pin-on" : ""}`}
              role="button"
              aria-label={pinned ? "Unpin (remove tab)" : "Pin tab"}
              title={pinned ? "Unpin" : "Pin tab"}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(s.id);
              }}
            >
              {pinned ? "★" : "☆"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
