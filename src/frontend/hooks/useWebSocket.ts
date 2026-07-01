import { useState, useEffect, useRef, useCallback } from "react";
import type { WSServerMessage, WSClientMessage } from "../lib/types";
import { getWebSocketUrl } from "../lib/api";

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

  const connect = useCallback(() => {
    // Already open OR mid-handshake — don't stack a second socket.
    const state = wsRef.current?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(getWebSocketUrl());
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WSServerMessage;
        for (const handler of handlersRef.current) {
          handler(msg);
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      if (disposedRef.current) return;
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      clearTimeout(reconnectTimer.current);
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
