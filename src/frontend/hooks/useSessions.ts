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

  return { sessions, loading, error, refresh };
}
