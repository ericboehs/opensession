import React, { useEffect, useState } from "react";
import type { WSServerMessage } from "../lib/types";

interface Props {
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * Non-intrusive "a new frontend build is live — refresh" banner. Fired by the
 * server's `frontend_updated` broadcast after an in-process rebuild (no restart,
 * so running sessions are untouched). Deliberately NOT a forced reload: the user
 * refreshes when ready, so nobody loses a half-typed message. New page loads
 * already get the new build; this just nudges already-open tabs.
 */
export function UpdateToast({ addHandler }: Props) {
  const [show, setShow] = useState(false);

  useEffect(
    () => addHandler((msg) => msg.type === "frontend_updated" && setShow(true)),
    [addHandler]
  );

  if (!show) return null;

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <span className="update-toast-text">A new version of Backstage is available.</span>
      <button className="update-toast-refresh" onClick={() => location.reload()}>
        Refresh
      </button>
      <button
        className="update-toast-dismiss"
        onClick={() => setShow(false)}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
