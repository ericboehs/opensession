import { useState, useEffect } from "react";
import type { UnifiedSession } from "../lib/types";
import { fetchSessions } from "../lib/api";

export function useSessions(pollInterval = 5000) {
  const [sessions, setSessions] = useState<UnifiedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const data = await fetchSessions();
        if (mounted) {
          setSessions(data);
          setLoading(false);
          setError(null);
        }
      } catch (e: any) {
        if (mounted) {
          setError(e.message);
          setLoading(false);
        }
      }
    }

    poll();
    const id = setInterval(poll, pollInterval);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [pollInterval]);

  return { sessions, loading, error };
}
