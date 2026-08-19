import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { UnifiedSession } from "../lib/types";
import { fetchSessionsSnapshot } from "../lib/api";
import {
	mergeSessionSlices,
	settledOverrides,
	type LocalArchiveOverride,
} from "../lib/session-slices";

/** The live list. Archived sessions are ~46% of the unsliced payload and none
 *  of the cold start; the Archived screen requests them separately. */
const LIVE_QUERY = "?archived=exclude";
/** The archived index: the narrow row the Archived surfaces render. */
const ARCHIVED_QUERY = "?archived=only&slim=1";
/**
 * How often to re-check the archived index. Far slower than the live poll
 * because archiving is rare and its slice barely changes — and because the
 * response is ETagged, so the steady state is a 304 with no body at all. Its
 * one job is picking up sessions archived on another device; a local archive
 * refreshes it immediately.
 */
const ARCHIVED_POLL_MS = 30_000;

export function reconcilePendingSessionPatches(
  sessions: UnifiedSession[],
  pendingPatches: Map<string, Partial<UnifiedSession>>,
): UnifiedSession[] {
  // An archive is acknowledged by the row's ABSENCE. The live slice doesn't
  // carry archived sessions any more, so there are no field values left to
  // compare against and the patch below would be held forever — re-applying
  // `archived: true` to nothing, while a stale in-flight poll's copy of the
  // row is exactly what it exists to correct.
  if (pendingPatches.size) {
    const present = new Set(sessions.map((s) => s.id));
    for (const [id, pending] of pendingPatches)
      if (pending.archived === true && !present.has(id)) pendingPatches.delete(id);
  }
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

export function useSessions({
  loadArchived = false,
  pollInterval = 5000,
}: {
  loadArchived?: boolean;
  pollInterval?: number;
} = {}) {
  const [live, setLive] = useState<UnifiedSession[]>([]);
  // When the live list last came back. Settles a local unarchive: a poll that
  // STARTED after the change and still doesn't list the session means the
  // change didn't take, and the override should stop hiding the archived row.
  // Every poll writes it, including the byte-identical ones the ETag and
  // `lastTextRef` guards exist to make free — as state that re-rendered the
  // whole app every 5s for nothing. The ref is the value; the state is only
  // the trigger, promoted while an override is actually waiting on it.
  const liveAtRef = useRef(0);
  const [liveAt, setLiveAt] = useState(0);
  const [archivedIndex, setArchivedIndex] = useState<UnifiedSession[] | null>(
    null,
  );
  // When the archived index last came back, with the same split as `liveAt`
  // above: the archived poll runs every few seconds for as long as the
  // Archived screen is open, and its 304s carried no new rows but re-rendered
  // the app anyway. The ref is the value; the state is only the trigger.
  const archivedIndexAtRef = useRef(0);
  const [archivedIndexAt, setArchivedIndexAt] = useState(0);
  const [locallyArchived, setLocallyArchived] = useState<
    Map<string, LocalArchiveOverride>
  >(() => new Map());
  const [locallyUnarchived, setLocallyUnarchived] = useState<
    Map<string, number>
  >(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Read by `patch` to capture the row it is archiving, which the very next
  // live poll will drop. Assigned during render, like App.tsx's own *Ref
  // mirrors — a callback can't close over state without re-creating itself.
  const liveRef = useRef<UnifiedSession[]>(live);
  liveRef.current = live;
  // The merged list, for the reverse move: unarchiving a session that is only
  // in the archived index has nothing in `live` to flip, so `patch` puts it
  // there. Assigned below, once the merge has run.
  const mergedRef = useRef<UnifiedSession[]>(live);
  // Read by the poll to decide whether anything is waiting on `liveAt`.
  const locallyArchivedRef = useRef(locallyArchived);
  locallyArchivedRef.current = locallyArchived;
  const locallyUnarchivedRef = useRef(locallyUnarchived);
  locallyUnarchivedRef.current = locallyUnarchived;
  // Raw JSON text of the last applied poll. When a poll returns byte-identical
  // data (the common case every 5s), skip setSessions entirely — a fresh array
  // identity would otherwise re-render the whole app (Sidebar memos, the open
  // SessionViewer's `session` prop, …) for nothing.
  const lastTextRef = useRef<string | null>(null);
  const etagRef = useRef<string | null>(null);
  const pollPromiseRef = useRef<Promise<void> | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  // Optimistically-injected sessions the server hasn't caught up to yet (a
  // just-created workspace/session). A plain poll replaces the whole array and
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
    setLive((previous) => {
      const next = reconciled;
      if (stickyRef.current.size === 0) return next;
      const present = new Set(next.map((s) => s.id));
      const extras: UnifiedSession[] = [];
      for (const [id, s] of stickyRef.current) {
        if (present.has(id)) stickyRef.current.delete(id);
        else extras.push(s);
      }
      return extras.length ? [...next, ...extras] : next;
    });
  }, []);

  const poll = useCallback((): Promise<void> => {
    if (pollPromiseRef.current) return pollPromiseRef.current;
    const controller = new AbortController();
    pollAbortRef.current = controller;
    const startedAt = Date.now();
    const promise = (async () => {
      try {
        const snapshot = await fetchSessionsSnapshot({
          etag: etagRef.current,
          signal: controller.signal,
          query: LIVE_QUERY,
        });
        if (!mountedRef.current) return;
        if (!snapshot.notModified && snapshot.text !== null) {
          etagRef.current = snapshot.etag;
          if (snapshot.text !== lastTextRef.current) {
            lastTextRef.current = snapshot.text;
            applyServer(JSON.parse(snapshot.text));
          }
        }
        liveAtRef.current = startedAt;
        if (
          locallyArchivedRef.current.size > 0 ||
          locallyUnarchivedRef.current.size > 0
        )
          setLiveAt(startedAt);
        setLoading(false);
        setError(null);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        if (mountedRef.current) {
          setError(e.message);
          setLoading(false);
        }
      }
    })().finally(() => {
      if (pollPromiseRef.current === promise) pollPromiseRef.current = null;
      if (pollAbortRef.current === controller) pollAbortRef.current = null;
    });
    pollPromiseRef.current = promise;
    return promise;
  }, [applyServer]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    let timer: number | undefined;
    const schedule = () => {
      if (!active || document.visibilityState === "hidden") return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(run, pollInterval);
    };
    const run = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      void poll().finally(schedule);
    };
    run();
    // Don't poll while the tab is hidden (backgrounded PWA / other tab) —
    // resync immediately when it becomes visible again.
    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
      else if (timer !== undefined) window.clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      mountedRef.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
      pollAbortRef.current?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll, pollInterval]);

  // ── The archived index ─────────────────────────────────────────────────
  const archivedTextRef = useRef<string | null>(null);
  const archivedEtagRef = useRef<string | null>(null);
  const archivedPromiseRef = useRef<Promise<void> | null>(null);

  const pollArchived = useCallback((): Promise<void> => {
    if (archivedPromiseRef.current) return archivedPromiseRef.current;
    const startedAt = Date.now();
    const promise = (async () => {
      try {
        const snapshot = await fetchSessionsSnapshot({
          etag: archivedEtagRef.current,
          query: ARCHIVED_QUERY,
        });
        if (!mountedRef.current) return;
        if (!snapshot.notModified && snapshot.text !== null) {
          archivedEtagRef.current = snapshot.etag;
          if (snapshot.text !== archivedTextRef.current) {
            archivedTextRef.current = snapshot.text;
            setArchivedIndex(JSON.parse(snapshot.text));
          }
        }
        archivedIndexAtRef.current = startedAt;
        if (
          locallyArchivedRef.current.size > 0 ||
          locallyUnarchivedRef.current.size > 0
        )
          setArchivedIndexAt(startedAt);
      } catch {
        // Never surfaced as the app's error: the live list is what the app is
        // for, and a failed index just leaves Archived showing what it had.
      }
    })().finally(() => {
      if (archivedPromiseRef.current === promise) archivedPromiseRef.current = null;
    });
    archivedPromiseRef.current = promise;
    return promise;
  }, []);

  // The sidebar only links to Archived now; it does not render archived rows or
  // their count. Keep this larger index out of the app entirely until that
  // screen is open, then poll it while the person is looking at it.
  useEffect(() => {
    if (!loadArchived || loading) return;
    let active = true;
    let timer: number | undefined;
    const run = () => {
      if (!active) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      void pollArchived().finally(() => {
        if (!active || document.visibilityState === "hidden") return;
        timer = window.setTimeout(run, ARCHIVED_POLL_MS);
      });
    };
    run();
    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
      else if (timer !== undefined) window.clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadArchived, loading, pollArchived]);

  // One list out of the slices, so every consumer keeps reading `archived`
  // off a single array (see lib/session-slices for why that's the shape).
  const sessions = useMemo(
    () =>
      mergeSessionSlices({
        live,
        archivedIndex,
        locallyArchived,
        locallyUnarchived,
      }),
    [live, archivedIndex, locallyArchived, locallyUnarchived],
  );
  mergedRef.current = sessions;

  // Forget the local overrides the server has caught up with.
  useEffect(() => {
    if (locallyArchived.size === 0 && locallyUnarchived.size === 0) return;
    const settled = settledOverrides({
      live,
      liveAt: liveAtRef.current,
      archivedIndex,
      archivedIndexAt: archivedIndexAtRef.current,
      locallyArchived,
      locallyUnarchived,
    });
    if (settled.archived.length)
      setLocallyArchived((prev) => {
        const next = new Map(prev);
        for (const id of settled.archived) next.delete(id);
        return next;
      });
    if (settled.unarchived.length)
      setLocallyUnarchived((prev) => {
        const next = new Map(prev);
        for (const id of settled.unarchived) next.delete(id);
        return next;
      });
    // `liveAt` and `archivedIndexAt` are here as the trigger for a poll that
    // landed with an override pending; the values the settle reads are the refs
    // above, which every poll updates.
  }, [
    live,
    liveAt,
    archivedIndex,
    archivedIndexAt,
    locallyArchived,
    locallyUnarchived,
  ]);

  // Expose manual refresh for after deletes
  const refresh = useCallback(() => {
    poll();
    if (loadArchived || archivedIndex !== null) pollArchived();
  }, [archivedIndex, loadArchived, poll, pollArchived]);

  // Drop a just-created session straight into the list so the UI can render it
  // immediately (e.g. the tab-strip + creating a new session) instead of showing a
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
      etagRef.current = null;
      if (opts?.sticky) stickyRef.current.set(session.id, session);
      setLive((prev) =>
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
    if (stickyRef.current.delete(id)) {
      lastTextRef.current = null;
      etagRef.current = null;
    }
  }, []);

  const patch = useCallback(
    (id: string, patch: Partial<UnifiedSession>) => {
      lastTextRef.current = null;
      etagRef.current = null;
      if ("archived" in patch) {
        pendingPatchRef.current.set(id, {
          ...pendingPatchRef.current.get(id),
          ...patch,
        });
        const at = Date.now();
        const drop = <V,>(prev: Map<string, V>) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        };
        if (patch.archived) {
          // The next live poll drops this row and the index doesn't have it
          // yet: hold the copy we already have so the session doesn't blink
          // out of the sidebar and out of ⌘Z's reach in between.
          const current = liveRef.current.find((s) => s.id === id);
          if (current)
            setLocallyArchived((prev) =>
              new Map(prev).set(id, { session: { ...current, ...patch }, at }),
            );
          setLocallyUnarchived(drop);
        } else {
          setLocallyUnarchived((prev) => new Map(prev).set(id, at));
          setLocallyArchived(drop);
          // Mirror image of the above: the row lives in the archived index,
          // so there is nothing in the live slice for the patch below to flip
          // and it would vanish until the next poll. Move it across now. It
          // may be an index summary; one poll replaces it with the full row.
          const known = mergedRef.current.find((s) => s.id === id);
          if (known)
            setLive((prev) =>
              prev.some((s) => s.id === id) ? prev : [...prev, { ...known, ...patch }],
            );
        }
        // Settle the override immediately when the index is already in use.
        // Otherwise the local copy is enough for undo until Archived opens.
        if (loadArchived || archivedIndex !== null) void pollArchived();
      }
      setLive((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    },
    [archivedIndex, loadArchived, pollArchived],
  );

  const remove = useCallback((id: string) => {
    lastTextRef.current = null;
    etagRef.current = null;
    archivedTextRef.current = null;
    archivedEtagRef.current = null;
    stickyRef.current.delete(id);
    pendingPatchRef.current.delete(id);
    const drop = <V,>(prev: Map<string, V>) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    };
    setLive((prev) => prev.filter((s) => s.id !== id));
    setArchivedIndex((prev) => prev && prev.filter((s) => s.id !== id));
    setLocallyArchived(drop);
    setLocallyUnarchived(drop);
  }, []);

  return {
    sessions,
    loading,
    error,
    /** False until the archived index lands — the Archived page's own
     *  loading state, which it never needed while the list carried
     *  everything. */
    archivedLoaded: archivedIndex !== null,
    refreshArchived: pollArchived,
    refresh,
    inject,
    unstick,
    patch,
    remove,
  };
}
