import React, { useEffect, useRef, useState } from "react";
import type { WSServerMessage } from "../lib/types";
import { PRODUCT_NAME } from "../lib/brand";

const HEALTH_URL = "/backstage/api/health";

interface Props {
  connected: boolean;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * Covers the UI while the backstage server restarts (deploy) and auto-reloads
 * once a *new* server instance is up — so clients always pick up the new build
 * and nothing typed mid-restart is silently queued and lost.
 *
 * Triggered by an explicit `server_restarting` broadcast (instant) or by a
 * prolonged WebSocket disconnect (covers hard crashes). It reloads only when a
 * fresh instance answers — detected by a changed bootId, or by health coming
 * back after having gone unreachable — so a brief network blip just dismisses.
 */
export function RestartOverlay({ connected, addHandler }: Props) {
  const [restarting, setRestarting] = useState(false);
  const [backOnline, setBackOnline] = useState(false);
  const bootId = useRef<string | null>(null);
  const sawDown = useRef(false);
  // Set when the server explicitly told us it's going down. The old instance
  // stays up and the WebSocket stays open for the whole graceful drain (now up
  // to 2 min), so "socket connected + health answering" must NOT be mistaken for
  // a blip and dismiss the overlay — once we have an explicit signal we keep it
  // up until a *new* instance answers (bootId change).
  const explicit = useRef(false);

  // Learn the current instance's bootId up front.
  useEffect(() => {
    fetch(HEALTH_URL, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        bootId.current = d.bootId ?? null;
      })
      .catch(() => {});
  }, []);

  // Explicit "I'm going down" signal from the server.
  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type === "server_restarting") {
          explicit.current = true;
          setRestarting(true);
        }
      }),
    [addHandler]
  );

  // Fallback: a disconnect that doesn't recover quickly is treated as a restart.
  useEffect(() => {
    if (connected || restarting) return;
    const t = setTimeout(() => setRestarting(true), 2500);
    return () => clearTimeout(t);
  }, [connected, restarting]);

  // While restarting, poll health and reload once a fresh instance answers.
  useEffect(() => {
    if (!restarting) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const d = await fetch(HEALTH_URL, { cache: "no-store" }).then((r) => r.json());
        const changed = bootId.current && d.bootId && d.bootId !== bootId.current;
        if (!cancelled && (changed || sawDown.current)) {
          setBackOnline(true);
          setTimeout(() => location.reload(), 700);
          return true;
        }
        // Server alive, same instance, socket healthy again → it was a blip.
        // Only dismiss when the overlay was triggered by a disconnect guess, not
        // by an explicit server_restarting signal — during a graceful drain the
        // old instance stays up and connected, which would otherwise look like a
        // blip and hide the overlay for the whole drain.
        if (!cancelled && connected && !sawDown.current && !explicit.current) {
          setRestarting(false);
          return true;
        }
      } catch {
        sawDown.current = true;
      }
      return false;
    };

    const iv = setInterval(() => void tick(), 1500);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [restarting, connected]);

  if (!restarting) return null;

  return (
    <div className="restart-overlay" role="alertdialog" aria-live="assertive">
      <div className="restart-card">
        <div className={`restart-spinner ${backOnline ? "restart-spinner-done" : ""}`} />
        <div className="restart-title">
          {backOnline ? "Back online" : `${PRODUCT_NAME} is restarting`}
        </div>
        <div className="restart-sub">
          {backOnline
            ? "Refreshing…"
            : "Hang tight — the page will refresh automatically once it's back up."}
        </div>
      </div>
    </div>
  );
}
