import { useState, useEffect, useCallback, useRef } from "react";
import type { UnifiedSession } from "../lib/types";
import { fetchSessionsSnapshot } from "../lib/api";

export function reconcilePendingSessionPatches(
  sessions: UnifiedSession[],
  pendingPatches: Map<string, Partial<UnifiedSession>>,
): UnifiedSession[] {
  return sessions.map((session) => {
    const pending = pendingPatches.get(session.id);
    if (!pending) return session;
    const acknowledged = Object.entries(pending).every(
      ([key, value]) => session[key as keyof UnifiedSession] === value,
    );
    if (acknowledged) {
      pendingPatches.delete(session.id);
      return session;
    }
    return { ...session, ...pending };
  });
}

export function useSessions(pollInterval = 5000) {
  const [sessions, setSessions] = useState<UnifiedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cloudUnreachable, setCloudUnreachable] = useState(false);
  const mountedRef = useRef(true);
  // Raw JSON text of the last applied poll. When a poll returns byte-identical
  // data (the common case every 5s), skip setSessions entirely — a fresh array
  // identity would otherwise re-render the whole app (Sidebar memos, the open
  // SessionViewer's `session` prop, …) for nothing.
  const lastTextRef = useRef<string | null>(null);
  // Optimistically-injected sessions the server hasn't caught up to yet (a
  // just-created workspace/chat). A plain poll replaces the whole array and
  // would drop the injected copy — flashing a loading placeholder until the
  // create lands seconds later. Keep these merged into every poll result until
  // the server's own copy shows up (auto-cleared here) or `unstick` drops it.
  const stickyRef = useRef<Map<string, UnifiedSession>>(new Map());
  // Optimistic changes that must survive an older poll already in flight. Each
  // entry is removed once a server snapshot contains the same field values.
  const pendingPatchRef = useRef<Map<string, Partial<UnifiedSession>>>(new Map());

  const applyServer = useCallback((parsed: UnifiedSession[]) => {
    const reconciled = reconcilePendingSessionPatches(
      parsed,
      pendingPatchRef.current,
    );
    if (stickyRef.current.size === 0) {
      setSessions(reconciled);
      return;
    }
    const present = new Set(reconciled.map((s) => s.id));
    const extras: UnifiedSession[] = [];
    for (const [id, s] of stickyRef.current) {
      if (present.has(id)) stickyRef.current.delete(id);
      else extras.push(s);
    }
    setSessions(extras.length ? [...reconciled, ...extras] : reconciled);
  }, []);

  const poll = useCallback(async () => {
    try {
      const snapshot = await fetchSessionsSnapshot();
      const { text } = snapshot;
      if (!mountedRef.current) return;
      setCloudUnreachable(snapshot.cloudUnreachable);
      if (text !== lastTextRef.current) {
        lastTextRef.current = text;
        applyServer(JSON.parse(text));
      }
      setLoading(false);
      setError(null);
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e.message);
        setLoading(false);
      }
    }
  }, [applyServer]);

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
  // server's copy. Pass `{ sticky: true }` for a create the server takes a while
  // to register (a new workspace): the injected copy then survives every poll
  // until the server's own copy lands, so the new tab renders instead of a
  // "Starting…" placeholder. Call `unstick` if the create fails.
  const inject = useCallback(
    (session: UnifiedSession, opts?: { sticky?: boolean }) => {
      // The list no longer matches the last server response — force the next
      // poll to apply (it reconciles the injected copy, same as before).
      lastTextRef.current = null;
      if (opts?.sticky) stickyRef.current.set(session.id, session);
      setSessions((prev) =>
        prev.some((s) => s.id === session.id)
          ? prev.map((s) => (s.id === session.id ? session : s))
          : [...prev, session],
      );
    },
    [],
  );

  // Drop a session's sticky status (e.g. its create failed / was abandoned).
  // The session itself stays until the next poll reconciles it away.
  const unstick = useCallback((id: string) => {
    if (stickyRef.current.delete(id)) lastTextRef.current = null;
  }, []);

  const patch = useCallback((id: string, patch: Partial<UnifiedSession>) => {
    lastTextRef.current = null;
    if ("archived" in patch) {
      pendingPatchRef.current.set(id, {
        ...pendingPatchRef.current.get(id),
        ...patch,
      });
    }
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
  }, []);

  const remove = useCallback((id: string) => {
    lastTextRef.current = null;
    stickyRef.current.delete(id);
    pendingPatchRef.current.delete(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { sessions, loading, error, cloudUnreachable, refresh, inject, unstick, patch, remove };
}
