import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { fetchSessionsSnapshot } from "../lib/api";
import {
	mergeSessionSlices,
	settledOverrides,
	type LocalArchiveOverride,
} from "../lib/session-slices";

/** The unscoped live list, kept as a compatibility fallback. */
const LIVE_QUERY = "?archived=exclude";

export interface SidebarSessionsQueryOptions {
  user: string;
  person: string;
  repo: string;
  autoCreated: "show" | "hide";
  selectedSessionId?: string;
  selectedWorkspaceId?: string;
}

/** Build the opt-in server-side projection used by the left sidebar. */
export function sidebarSessionsQuery(
  options: SidebarSessionsQueryOptions,
): string {
  const params = new URLSearchParams({
    archived: "exclude",
    view: "sidebar",
    user: options.user,
    person: options.person,
    repo: options.repo,
    autoCreated: options.autoCreated,
  });
  if (options.selectedSessionId)
    params.set("session", options.selectedSessionId);
  if (options.selectedWorkspaceId)
    params.set("workspace", options.selectedWorkspaceId);
  return `?${params.toString()}`;
}
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
/** WebSocket invalidations are the primary live-list trigger. This slow poll
 * repairs missed frames after long transport failures or older servers. */
export const LIVE_POLL_FALLBACK_MS = 60_000;

export function sessionPatchNeedsAcknowledgement(
  patch: Partial<UnifiedSession>,
): boolean {
  // Runtime state comes from the open chat's WebSocket before the cached list
  // can observe it. Keep that exact state across list polls until the matching
  // stop frame arrives, just as an archive survives an older poll in flight.
  return "archived" in patch || "isRunning" in patch;
}

/** A sidebar response is scoped to the route that requested it. Navigating
 * while an older request is in flight must fence that response out: its
 * selected-session exception can otherwise put the session just archived on
 * the previous route back into the live list. */
export function liveSnapshotMatchesQuery(
  requestQuery: string,
  currentQuery: string,
): boolean {
  return requestQuery === currentQuery;
}

export interface PendingSessionPatch {
  values: Partial<UnifiedSession>;
  /** Runtime revision when a WebSocket status frame was applied. */
  runtimeRevision?: number;
}

export function reconcilePendingSessionPatches(
  sessions: UnifiedSession[],
  pendingPatches: Map<string, PendingSessionPatch>,
  snapshotRuntimeRevision = -1,
): UnifiedSession[] {
  // An archive is acknowledged by the row's ABSENCE. The live slice doesn't
  // carry archived sessions any more, so there are no field values left to
  // compare against and the patch below would be held forever — re-applying
  // `archived: true` to nothing, while a stale in-flight poll's copy of the
  // row is exactly what it exists to correct.
  if (pendingPatches.size) {
    const present = new Set(sessions.map((s) => s.id));
    for (const [id, pending] of pendingPatches)
      if (pending.values.archived === true && !present.has(id))
        pendingPatches.delete(id);
  }
  return sessions.map((session) => {
    const pending = pendingPatches.get(session.id);
    if (!pending) return session;
    // Only protect a WebSocket status frame from list requests that were
    // already in flight when it arrived. A later snapshot is authoritative:
    // the run may have finished after this viewer was unmounted, so keeping
    // the last local `true` until the server repeats it can strand the row in
    // In progress forever.
    if (
      pending.runtimeRevision !== undefined &&
      snapshotRuntimeRevision >= pending.runtimeRevision
    ) {
      delete pending.values.isRunning;
      delete pending.values.runStartedAt;
      delete pending.runtimeRevision;
    }
    if (Object.keys(pending.values).length === 0) {
      pendingPatches.delete(session.id);
      return session;
    }
    const acknowledged = Object.entries(pending.values).every(
      ([key, value]) => session[key as keyof UnifiedSession] === value,
    );
    if (acknowledged) {
      pendingPatches.delete(session.id);
      return session;
    }
    return { ...session, ...pending.values };
  });
}

export function useSessions({
  loadArchived = false,
  pollInterval = LIVE_POLL_FALLBACK_MS,
  liveQuery = LIVE_QUERY,
}: {
  loadArchived?: boolean;
  pollInterval?: number;
  liveQuery?: string;
} = {}) {
  const [live, setLive] = useState<UnifiedSession[]>([]);
  // When the live list last came back. Settles a local unarchive: a poll that
  // STARTED after the change and still doesn't list the session means the
  // change didn't take, and the override should stop hiding the archived row.
  // Every refresh writes it, including byte-identical fallback responses the
  // ETag and `lastTextRef` guards exist to make free. The ref is the value; the
  // state is only
  // the trigger, promoted while an override is actually waiting on it.
  const liveAtRef = useRef(0);
  const [liveAt, setLiveAt] = useState(0);
  const [archivedIndex, setArchivedIndex] = useState<UnifiedSession[] | null>(
    null,
  );
  // When the archived index last came back, with the same split as `liveAt`
  // above: the archived fallback runs while the Archived screen is open, and
  // its 304s carried no new rows but re-rendered
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
  useLayoutEffect(() => {
    liveRef.current = live;
  });
  // The merged list, for the reverse move: unarchiving a session that is only
  // in the archived index has nothing in `live` to flip, so `patch` puts it
  // there. Assigned below, once the merge has run.
  const mergedRef = useRef<UnifiedSession[]>(live);
  // Read by the poll to decide whether anything is waiting on `liveAt`.
  const locallyArchivedRef = useRef(locallyArchived);
  const locallyUnarchivedRef = useRef(locallyUnarchived);
  useLayoutEffect(() => {
    locallyArchivedRef.current = locallyArchived;
    locallyUnarchivedRef.current = locallyUnarchived;
  });
  // Raw JSON text of the last applied refresh. When it returns byte-identical
  // data, skip setSessions entirely — a fresh array
  // identity would otherwise re-render the whole app (Sidebar memos, the open
  // SessionViewer's `session` prop, …) for nothing.
  const lastTextRef = useRef<string | null>(null);
  const etagRef = useRef<string | null>(null);
  const appliedLiveQueryRef = useRef(liveQuery);
  const pollPromiseRef = useRef<{
    query: string;
    promise: Promise<void>;
  } | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  // An invalidation can land while a list request is in flight. The revision
  // lets that request finish, then immediately reruns it instead of mistaking
  // the already-running request for a refresh of the newer server state.
  const invalidationRevisionRef = useRef(0);
  const invalidationTimerRef = useRef<number | undefined>(undefined);
  // Fence the previous route's scoped response before passive effects start its
  // replacement poll. Abort is best-effort; the query comparison after await is
  // the authority when a completed fetch wins the race with cancellation.
  useLayoutEffect(() => {
    if (appliedLiveQueryRef.current === liveQuery) return;
    appliedLiveQueryRef.current = liveQuery;
    etagRef.current = null;
    lastTextRef.current = null;
    pollAbortRef.current?.abort();
  }, [liveQuery]);
  // Optimistically-injected sessions the server hasn't caught up to yet (a
  // just-created workspace/session). A plain poll replaces the whole array and
  // would drop the injected copy — flashing a loading placeholder until the
  // create lands seconds later. Keep these merged into every poll result until
  // the server's own copy shows up (auto-cleared here) or `unstick` drops it.
  const stickyRef = useRef<Map<string, UnifiedSession>>(new Map());
  // Optimistic changes that must survive an older poll already in flight.
  // Archive fields wait for value acknowledgement; runtime fields yield to the
  // first snapshot started after their WebSocket frame.
  const pendingPatchRef = useRef<Map<string, PendingSessionPatch>>(new Map());
  // A poll captures this before it starts. Runtime frames increment it, which
  // lets reconciliation distinguish an older response from a later, current
  // server snapshot without relying on wall-clock timing.
  const runtimeRevisionRef = useRef(0);

  const applyServer = (parsed: UnifiedSession[], snapshotRuntimeRevision: number) => {
      const reconciled = reconcilePendingSessionPatches(
        parsed,
        pendingPatchRef.current,
        snapshotRuntimeRevision,
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
    };

  // Stable per query: refs, setters and module fns otherwise. The polling
  // effect below can list it without re-arming on unrelated re-renders.
  // Named function expression so the invalidation re-poll can recurse
  // without the compiler seeing a read of `poll` mid-initialization.
  const poll = useCallback(async function pollSelf(): Promise<void> {
    const requestQuery = liveQuery;
    if (pollPromiseRef.current?.query === requestQuery)
      return pollPromiseRef.current.promise;
    if (pollPromiseRef.current) pollAbortRef.current?.abort();
    if (appliedLiveQueryRef.current !== requestQuery) {
      appliedLiveQueryRef.current = requestQuery;
      etagRef.current = null;
      lastTextRef.current = null;
    }
    const controller = new AbortController();
    pollAbortRef.current = controller;
    const startedAt = Date.now();
    const snapshotRuntimeRevision = runtimeRevisionRef.current;
    const invalidationRevision = invalidationRevisionRef.current;
    const promise = (async () => {
      await (async () => {
const snapshot = await fetchSessionsSnapshot({
          etag: etagRef.current,
          signal: controller.signal,
          query: requestQuery,
        });
        if (
          !mountedRef.current ||
          !liveSnapshotMatchesQuery(
            requestQuery,
            appliedLiveQueryRef.current,
          )
        )
          return;
        if (!snapshot.notModified && snapshot.text !== null) {
          etagRef.current = snapshot.etag;
          if (snapshot.text !== lastTextRef.current) {
            lastTextRef.current = snapshot.text;
            applyServer(JSON.parse(snapshot.text), snapshotRuntimeRevision);
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
})().catch(async (e: any) => {
if (e?.name === "AbortError") return;
        if (mountedRef.current) {
          setError(e.message);
          setLoading(false);
        }
});
    })().finally(() => {
      if (pollPromiseRef.current?.promise === promise)
        pollPromiseRef.current = null;
      if (pollAbortRef.current === controller) pollAbortRef.current = null;
      if (
        mountedRef.current &&
        document.visibilityState !== "hidden" &&
        invalidationRevisionRef.current !== invalidationRevision
      )
        void pollSelf();
    });
    pollPromiseRef.current = { query: requestQuery, promise };
    return promise;
  }, [liveQuery]);

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
      if (invalidationTimerRef.current !== undefined)
        window.clearTimeout(invalidationTimerRef.current);
      pollAbortRef.current?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll, pollInterval]);

  // ── The archived index ─────────────────────────────────────────────────
  const archivedTextRef = useRef<string | null>(null);
  const archivedEtagRef = useRef<string | null>(null);
  const archivedPromiseRef = useRef<Promise<void> | null>(null);

  const pollArchived = useCallback(async function pollArchivedSelf(): Promise<void> {
    if (archivedPromiseRef.current) return archivedPromiseRef.current;
    const startedAt = Date.now();
    const invalidationRevision = invalidationRevisionRef.current;
    const promise = (async () => {
      await (async () => {
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
})().catch(async () => {
// Never surfaced as the app's error: the live list is what the app is
        // for, and a failed index just leaves Archived showing what it had.
});
    })().finally(() => {
      if (archivedPromiseRef.current === promise) archivedPromiseRef.current = null;
      if (
        mountedRef.current &&
        document.visibilityState !== "hidden" &&
        invalidationRevisionRef.current !== invalidationRevision
      )
        void pollArchivedSelf();
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
  const sessions = (mergeSessionSlices({
        live,
        archivedIndex,
        locallyArchived,
        locallyUnarchived,
      }));
  useLayoutEffect(() => {
    mergedRef.current = sessions;
  });

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

  // Expose manual refresh for after deletes.
  const refresh = () => {
    poll();
    if (loadArchived || archivedIndex !== null) pollArchived();
  };

  // Coalesce write bursts into one scoped list read. If the timer meets an
  // older request already in flight, poll's revision fence runs once more when
  // that request settles.
  const refreshInvalidated = () => {
    invalidationRevisionRef.current++;
    if (invalidationTimerRef.current !== undefined)
      window.clearTimeout(invalidationTimerRef.current);
    if (document.visibilityState === "hidden") return;
    invalidationTimerRef.current = window.setTimeout(() => {
      invalidationTimerRef.current = undefined;
      if (document.visibilityState === "hidden") return;
      void poll();
      if (loadArchived || archivedIndex !== null) void pollArchived();
    }, 250);
  };

  // Drop a just-created session straight into the list so the UI can render it
  // immediately (e.g. the tab-strip + creating a new session) instead of showing a
  // loading state until the next poll. The next poll replaces it with the
  // server's copy. Pass `{ sticky: true }` for a create the server takes a while
  // to register (a new workspace): the injected copy then survives every poll
  // until the server's own copy lands, so the new tab renders instead of a
  // "Starting…" placeholder. Call `unstick` if the create fails.
  const inject = (session: UnifiedSession, opts?: { sticky?: boolean }) => {
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
    };

  // Drop a session's sticky status (e.g. its create failed / was abandoned).
  // The session itself stays until the next poll reconciles it away.
  const unstick = (id: string) => {
    if (stickyRef.current.delete(id)) {
      lastTextRef.current = null;
      etagRef.current = null;
    }
  };

  const patch = (id: string, patch: Partial<UnifiedSession>) => {
      lastTextRef.current = null;
      etagRef.current = null;
      if (sessionPatchNeedsAcknowledgement(patch)) {
        const previous = pendingPatchRef.current.get(id);
        const runtimeRevision =
          "isRunning" in patch
            ? ++runtimeRevisionRef.current
            : previous?.runtimeRevision;
        pendingPatchRef.current.set(id, {
          values: { ...previous?.values, ...patch },
          runtimeRevision,
        });
      }
      if ("archived" in patch) {
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
    };

  const remove = (id: string) => {
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
  };

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
    refreshInvalidated,
    inject,
    unstick,
    patch,
    remove,
  };
}
