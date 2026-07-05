import React, { useEffect, useState } from "react";
import type { WSServerMessage } from "../lib/types";

interface Props {
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * "A new version is available" toast, docked to the sidebar bottom. Fired by the server's
 * `frontend_updated` broadcast after an in-process rebuild (no restart, so
 * running sessions are untouched).
 *
 * Refreshing is optional — new page loads already get the new build; this just
 * nudges already-open tabs — so the toast is non-blocking (it never covers the
 * composer) and dismissable.
 */
export function UpdatePill({ addHandler }: Props) {
  const [show, setShow] = useState(false);

  useEffect(
    () => addHandler((msg) => msg.type === "frontend_updated" && setShow(true)),
    [addHandler]
  );

  if (!show) return null;

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <div className="update-toast-body">
        <span className="update-toast-text">New update available</span>
      </div>
      <div className="update-toast-actions">
        <button
          className="update-toast-refresh"
          onClick={() => location.reload()}
        >
          Refresh
        </button>
        <button
          className="update-toast-dismiss"
          onClick={() => setShow(false)}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M3.5 3.5l7 7M10.5 3.5l-7 7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
