import React, { useEffect, useState } from "react";
import type { WSServerMessage } from "../lib/types";

interface Props {
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * "A new frontend build is live" affordance, rendered inline next to the
 * Backstage wordmark (desktop sidebar brand + mobile top bar, both via
 * `brandTitle`) as a small solid-red rounded button hugging its label. Fired by
 * the server's `frontend_updated` broadcast after an in-process rebuild (no
 * restart, so running sessions are untouched).
 *
 * This replaced a center-bottom toast that floated over the composer and had to
 * be dismissed. Refreshing is optional — new page loads already get the new
 * build; this just nudges already-open tabs — so the indicator is deliberately
 * quiet and non-blocking: it never covers content and never needs dismissing.
 * It simply persists until the user clicks to refresh (or reloads on their own).
 */
export function UpdatePill({ addHandler }: Props) {
  const [show, setShow] = useState(false);

  useEffect(
    () => addHandler((msg) => msg.type === "frontend_updated" && setShow(true)),
    [addHandler]
  );

  if (!show) return null;

  return (
    <button
      className="update-pill"
      onClick={() => location.reload()}
      title="A new version of Backstage is available — click to refresh"
      aria-label="A new version of Backstage is available — click to refresh"
    >
      <span className="update-pill-text">Update</span>
    </button>
  );
}
