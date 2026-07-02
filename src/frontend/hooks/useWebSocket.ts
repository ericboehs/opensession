import { useState, useEffect, useRef, useCallback } from "react";
import type { WSServerMessage, WSClientMessage } from "../lib/types";
import { getWebSocketUrl } from "../lib/api";

// Liveness probe cadence. iOS/Safari kills backgrounded sockets without firing
// onclose, leaving a half-open socket that reads as OPEN but delivers nothing —
// the "chat frozen until refresh" trap. We ping over the app protocol (browsers
// can't send WS protocol pings) and force-close if nothing arrives back, which
// triggers the normal reconnect + re-watch path.
const HEARTBEAT_MS = 20_000;
// Tighter deadline for the visibility-resume probe: coming back to a
// backgrounded PWA is exactly when the socket is most likely dead.
const RESUME_PROBE_MS = 4_000;

export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<((msg: WSServerMessage) => void)[]>([]);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Set on unmount so a straggling onclose (close() fires it async) can't
  // schedule a fresh reconnect into a dead component — the zombie-loop trap.
  const disposedRef = useRef(false);
  // Flipped true by ANY inbound message (pong or otherwise); the heartbeat
  // flips it false after each ping. Still false at the next beat = dead socket.
  const aliveRef = useRef(true);

  const connect = useCallback(() => {
    // Already open OR mid-handshake — don't stack a second socket.
    const state = wsRef.current?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(getWebSocketUrl());
    wsRef.current = ws;
    aliveRef.current = true;

    ws.onopen = () => {
      if (wsRef.current === ws) setConnected(true);
    };

    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return; // superseded socket — ignore stragglers
      aliveRef.current = true;
      try {
        const msg = JSON.parse(e.data) as WSServerMessage;
        if (msg.type === "pong") return; // liveness only — not for handlers
        for (const handler of handlersRef.current) {
          handler(msg);
        }
      } catch {}
    };

    ws.onclose = () => {
      // A close from an already-replaced socket must not flip `connected` or
      // schedule a competing reconnect — only the current socket owns state.
      if (wsRef.current !== ws) return;
      setConnected(false);
      if (disposedRef.current) return;
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();

    // Steady-state heartbeat: ping every beat; a socket that answered nothing
    // since the previous ping is dead — close it so onclose reconnects.
    const heartbeat = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!aliveRef.current) {
        try {
          ws.close();
        } catch {}
        return;
      }
      aliveRef.current = false;
      try {
        ws.send('{"type":"ping"}');
      } catch {}
    }, HEARTBEAT_MS);

    // Foregrounding the tab/PWA (or the network coming back): reconnect a
    // closed socket immediately (skip the 2s backoff), and probe an "open" one
    // right away — if the probe gets no answer, close → reconnect.
    const resync = () => {
      if (disposedRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        clearTimeout(reconnectTimer.current);
        connect();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return; // handshake in flight
      aliveRef.current = false;
      try {
        ws.send('{"type":"ping"}');
      } catch {}
      setTimeout(() => {
        // Only judge the same socket we probed — it may have been replaced.
        if (wsRef.current === ws && !aliveRef.current) {
          try {
            ws.close();
          } catch {}
        }
      }, RESUME_PROBE_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") resync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", resync);
    window.addEventListener("pageshow", resync);

    return () => {
      disposedRef.current = true;
      clearTimeout(reconnectTimer.current);
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", resync);
      window.removeEventListener("pageshow", resync);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: WSClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const addHandler = useCallback((handler: (msg: WSServerMessage) => void) => {
    handlersRef.current.push(handler);
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler);
    };
  }, []);

  return { connected, send, addHandler };
}
