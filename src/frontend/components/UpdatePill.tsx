import React, { useEffect, useState } from "react";
import type { WSServerMessage } from "../lib/types";
import { Tooltip } from "../ui/tooltip";

interface Props {
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  // "toast" docks to the sidebar bottom (desktop). "pill" is the compact
  // topbar variant that sits next to the brand logo on phones.
  variant?: "toast" | "pill";
}

/** Grace before a forced update reloads a VISIBLE tab (hidden tabs reload
 *  immediately) — long enough to finish a thought, short enough that a
 *  protocol-break deploy converges in under a minute. */
const FORCE_GRACE_MS = 20_000;

/**
 * "A new version is available" nudge. Fired by the server's `frontend_updated`
 * broadcast after an in-process rebuild (no restart, so running sessions are
 * untouched).
 *
 * Refreshing is normally optional — new page loads already get the new build;
 * this just nudges already-open tabs — so it's non-blocking (it never covers
 * the composer). Desktop shows a toast docked to the sidebar bottom; phones
 * show a compact "Update" pill in the top bar, right after the brand logo.
 *
 * `force: true` broadcasts (POST /api/admin/frontend-reload — sent before a
 * server-side protocol change that old bundles can't follow) auto-reload
 * instead: hidden tabs immediately, visible tabs after a counted-down grace
 * shown on the pill/toast, or the moment the tab is hidden mid-countdown.
 */
export function UpdatePill({ addHandler, variant = "toast" }: Props) {
  const [show, setShow] = useState(false);
  const [by, setBy] = useState<string | null>(null);
  const [forceAt, setForceAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    // Let feedback paint before a potentially slow network-first navigation.
    setTimeout(() => location.reload(), 50);
  }

  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type !== "frontend_updated") return;
        setShow(true);
        if (msg.by) setBy(msg.by);
        if (msg.force) {
          if (document.hidden) {
            location.reload();
            return;
          }
          // Repeat broadcasts keep the EARLIEST deadline (no countdown resets).
          setForceAt((prev) => prev ?? Date.now() + FORCE_GRACE_MS);
        }
      }),
    [addHandler]
  );

  useEffect(() => {
    if (forceAt == null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((forceAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) location.reload();
    };
    tick();
    const iv = setInterval(tick, 500);
    // A tab backgrounded mid-countdown reloads right away — nobody's looking.
    const onVis = () => {
      if (document.hidden) location.reload();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [forceAt]);

  if (!show) return null;

  const forced = secondsLeft != null;

  if (variant === "pill") {
    return (
      <button
        className="update-pill"
        onClick={refresh}
        disabled={refreshing}
        role="status"
        aria-live="polite"
        title={
          forced
            ? `Updating in ${secondsLeft}s — tap to refresh now.`
            : `A new update is available${by ? ` (${by})` : ""}. Tap to refresh.`
        }
      >
        {refreshing ? "Refreshing…" : forced ? `Update ${secondsLeft}s` : "Update"}
      </button>
    );
  }

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <div className="update-toast-body">
        <span className="update-toast-text">
          {forced ? `Updating in ${secondsLeft}s…` : "New update available"}
        </span>
        {by && (
          <Tooltip label={by} side="top" multiline>
            <span className="update-toast-by">{by}</span>
          </Tooltip>
        )}
      </div>
      <div className="update-toast-actions">
        <button
          className="update-toast-refresh"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : forced ? "Refresh now" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
