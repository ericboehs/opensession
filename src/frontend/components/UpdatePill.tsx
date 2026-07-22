import React, { useEffect, useState } from "react";
import type { WSServerMessage } from "../lib/types";

interface Props {
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  // "toast" docks to the sidebar bottom (desktop). "pill" is the compact
  // topbar variant that sits next to the brand logo on phones.
  variant?: "toast" | "pill";
}

/**
 * "A new version is available" nudge. Fired by the server's `frontend_updated`
 * broadcast after an in-process rebuild (no restart, so running sessions are
 * untouched).
 *
 * Refreshing is optional — new page loads already get the new build; this just
 * nudges already-open tabs — so it's non-blocking (it never covers the
 * composer). Desktop shows a toast docked to the sidebar bottom; phones show a
 * compact "Update" pill in the top bar, right after the brand logo.
 */
export function UpdatePill({ addHandler, variant = "toast" }: Props) {
  const [show, setShow] = useState(false);

  useEffect(
    () => addHandler((msg) => msg.type === "frontend_updated" && setShow(true)),
    [addHandler]
  );

  if (!show) return null;

  if (variant === "pill") {
    return (
      <button
        className="update-pill"
        onClick={() => location.reload()}
        role="status"
        aria-live="polite"
        title="A new update is available. Tap to refresh."
      >
        Update
      </button>
    );
  }

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
      </div>
    </div>
  );
}
