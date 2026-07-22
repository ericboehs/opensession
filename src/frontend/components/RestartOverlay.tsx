import { BASE_PATH } from "../lib/base";
import React, { useEffect, useRef, useState } from "react";
import type { WSServerMessage } from "../lib/types";
import { PRODUCT_NAME } from "../lib/brand";
import { toast } from "../ui/toast";

const HEALTH_URL = `${BASE_PATH}/api/health`;
// Grace before showing anything — most socket blips reconnect within this.
const PILL_DELAY_MS = 2500;
// A disconnect older than this whose health probe ALSO fails escalates from
// the calm pill to the full restart overlay (covers hard crashes).
const ESCALATE_AFTER_MS = 22_000;

interface Props {
  connected: boolean;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * Connection-state UI, differentiating a transient socket drop from a real
 * server restart (iOS PWA sockets die constantly on backgrounding — that must
 * never look like a deploy):
 *
 *  - Socket loss with no restart signal → a calm "Reconnecting…" pill while
 *    useWebSocket retries. On reconnect the server's bootId (hello frame;
 *    /api/health fallback for servers without it) is compared: unchanged →
 *    pure blip, the pill clears silently; changed → it really was a restart —
 *    a brief toast, then business as usual.
 *  - The full-screen overlay appears only on an explicit `server_restarting`
 *    broadcast (graceful drain) or when reconnects have failed for a while
 *    AND health is unreachable (hard crash). It auto-reloads once a *new*
 *    instance answers — detected by a changed bootId, or by health coming
 *    back after having gone unreachable — so clients pick up the new build.
 */
export function RestartOverlay({ connected, addHandler }: Props) {
  const [phase, setPhase] = useState<"ok" | "reconnecting" | "restarting">("ok");
  const [backOnline, setBackOnline] = useState(false);
  // Who likely caused the restart: `by` on server_restarting (pre-restart
  // overlay), `restartBy` on the new server's hello (post-restart toast).
  const [restartBy, setRestartBy] = useState<string | null>(null);
  const restartByRef = useRef<string | null>(null);
  restartByRef.current = restartBy;
  const bootId = useRef<string | null>(null);
  const sawDown = useRef(false);
  // Set when the server explicitly told us it's going down. The old instance
  // stays up and the WebSocket stays open for the whole graceful drain (up to
  // 2 min), so "socket connected + health answering" must NOT be mistaken for
  // a blip and dismiss the overlay — once we have an explicit signal we keep
  // it up until a *new* instance answers (bootId change).
  const explicit = useRef(false);
  const disconnectedAt = useRef<number | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Adopt/compare a server-reported bootId. First sighting just records it;
  // a change outside the overlay flow means the server restarted behind a
  // blip-looking disconnect — say so briefly, then carry on (the overlay
  // path reloads instead, to pick up the new frontend bundle).
  const handleBootId = (id: unknown) => {
    if (typeof id !== "string" || !id) return;
    if (!bootId.current) {
      bootId.current = id;
      return;
    }
    if (id === bootId.current) return;
    bootId.current = id;
    if (phaseRef.current !== "restarting" && !explicit.current) {
      const by = restartByRef.current;
      toast(
        `${PRODUCT_NAME} restarted${by ? ` (${by})` : ""}. Reconnected to the new server.`,
      );
    }
  };

  // Learn the current instance's bootId up front (also the fallback for
  // servers that don't send the hello frame yet).
  useEffect(() => {
    fetch(HEALTH_URL, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => handleBootId(d.bootId))
      .catch(() => {});
  }, []);

  // Server signals: explicit "I'm going down", and the per-connect hello.
  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type === "server_restarting") {
          explicit.current = true;
          if (msg.by) setRestartBy(msg.by);
          setPhase("restarting");
        } else if (msg.type === "hello") {
          // Adopt the attribution BEFORE the bootId compare fires the
          // "restarted" toast so the toast can name the culprit — setState
          // is async, so write the ref directly too.
          if (msg.restartBy) {
            restartByRef.current = msg.restartBy;
            setRestartBy(msg.restartBy);
          }
          handleBootId(msg.bootId);
        }
      }),
    [addHandler]
  );

  // Disconnect tracking: after a short grace, show the calm reconnecting pill
  // (never the overlay — that needs an explicit signal or a failed health
  // probe). On reconnect, clear it and settle the blip-vs-restart question
  // via bootId (hello handles new servers; one health fetch covers old ones).
  useEffect(() => {
    if (connected) {
      disconnectedAt.current = null;
      if (phaseRef.current === "reconnecting") {
        setPhase("ok");
        fetch(HEALTH_URL, { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => handleBootId(d.bootId))
          .catch(() => {});
      }
      return;
    }
    if (phase !== "ok") return;
    disconnectedAt.current ??= Date.now();
    const t = setTimeout(() => setPhase("reconnecting"), PILL_DELAY_MS);
    return () => clearTimeout(t);
  }, [connected, phase]);

  // Escalation: still disconnected after a while AND health unreachable →
  // treat as a real (crash) restart. While health answers, the server is up
  // and only the socket is broken — stay calm and keep retrying.
  useEffect(() => {
    if (phase !== "reconnecting" || connected) return;
    let cancelled = false;
    const iv = setInterval(async () => {
      const started = disconnectedAt.current ?? Date.now();
      if (Date.now() - started < ESCALATE_AFTER_MS) return;
      try {
        const r = await fetch(HEALTH_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
      } catch {
        if (!cancelled) {
          sawDown.current = true;
          setPhase("restarting");
        }
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [phase, connected]);

  // While restarting, poll health and reload once a fresh instance answers.
  useEffect(() => {
    if (phase !== "restarting") return;
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
        // Only dismiss when the overlay was triggered by a disconnect guess,
        // not by an explicit server_restarting signal — during a graceful
        // drain the old instance stays up and connected, which would
        // otherwise look like a blip and hide the overlay for the whole
        // drain.
        if (!cancelled && connected && !sawDown.current && !explicit.current) {
          setPhase("ok");
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
  }, [phase, connected]);

  if (phase === "reconnecting") {
    return (
      <div
        className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+14px)] left-1/2 z-[10000] flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-panel px-3.5 py-2 text-[12px] font-medium text-dim shadow-[0_4px_16px_rgba(0,0,0,0.18)]"
        role="status"
        aria-live="polite"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-70" />
        Reconnecting…
      </div>
    );
  }

  if (phase !== "restarting") return null;

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
            : "Hang tight. The page will refresh automatically once it's back up."}
        </div>
        {!backOnline && restartBy && (
          <div className="restart-by">Triggered by {restartBy}</div>
        )}
      </div>
    </div>
  );
}
