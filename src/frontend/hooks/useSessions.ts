import { useState, useEffect, useCallback, useRef } from "react";
import type { UnifiedSession } from "../lib/types";
import { fetchSessionsText } from "../lib/api";

export function useSessions(pollInterval = 5000) {
  const [sessions, setSessions] = useState<UnifiedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Raw JSON text of the last applied poll. When a poll returns byte-identical
  // data (the common case every 5s), skip setSessions entirely — a fresh array
  // identity would otherwise re-render the whole app (Sidebar memos, the open
  // SessionViewer's `session` prop, …) for nothing.
  const lastTextRef = useRef<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const text = await fetchSessionsText();
      if (!mountedRef.current) return;
      if (text !== lastTextRef.current) {
        lastTextRef.current = text;
        setSessions(JSON.parse(text));
      }
      setLoading(false);
      setError(null);
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e.message);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    poll();
    // Don't poll while the tab is hidden (backgrounded PWA / other tab) —
    // resync immediately when it becomes visible again.
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      poll();
    }, pollInterval);
    const onVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll, pollInterval]);

  // Expose manual refresh for after deletes
  const refresh = useCallback(() => { poll(); }, [poll]);

  // Drop a just-created session straight into the list so the UI can render it
  // immediately (e.g. the tab-strip + creating a new chat) instead of showing a
  // loading state until the next poll. The next poll replaces it with the
  // server's copy.
  const inject = useCallback((session: UnifiedSession) => {
    // The list no longer matches the last server response — force the next
    // poll to apply (it reconciles the injected copy, same as before).
    lastTextRef.current = null;
    setSessions((prev) =>
      prev.some((s) => s.id === session.id)
        ? prev.map((s) => (s.id === session.id ? session : s))
        : [...prev, session],
    );
  }, []);

  const patch = useCallback((id: string, patch: Partial<UnifiedSession>) => {
    lastTextRef.current = null;
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
  }, []);

  const remove = useCallback((id: string) => {
    lastTextRef.current = null;
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { sessions, loading, error, refresh, inject, patch, remove };
}
