import { useState, useEffect, useCallback, useRef } from "react";
import type { UnifiedSession } from "../lib/types";
import { fetchSessions } from "../lib/api";

export function useSessions(pollInterval = 5000) {
  const [sessions, setSessions] = useState<UnifiedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const poll = useCallback(async () => {
    try {
      const data = await fetchSessions();
      if (mountedRef.current) {
        setSessions(data);
        setLoading(false);
        setError(null);
      }
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
    const id = setInterval(poll, pollInterval);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [poll, pollInterval]);

  // Expose manual refresh for after deletes
  const refresh = useCallback(() => { poll(); }, [poll]);

  // Drop a just-created session straight into the list so the UI can render it
  // immediately (e.g. the tab-strip + creating a new chat) instead of showing a
  // loading state until the next poll. The next poll replaces it with the
  // server's copy.
  const inject = useCallback((session: UnifiedSession) => {
    setSessions((prev) =>
      prev.some((s) => s.id === session.id)
        ? prev.map((s) => (s.id === session.id ? session : s))
        : [...prev, session],
    );
  }, []);

  return { sessions, loading, error, refresh, inject };
}
