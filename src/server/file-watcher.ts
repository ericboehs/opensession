import { statSync } from "fs";
import { existsSync } from "fs";
import { clampEntriesForWire, parseTranscriptFrom } from "./jsonl-parser";
import type { TranscriptEntry } from "./types";

interface WatchState {
  path: string;
  /** Session this transcript belongs to — stamped on transcript_append so
      clients can drop events that aren't for the session they're viewing. */
  sessionId?: string;
  lastMtime: number;
  lastByteOffset: number;
  viewers: Set<any>; // WebSocket connections
  interval: ReturnType<typeof setInterval> | null;
}

// Parked on globalThis so a `bun --hot` reload keeps the live watch map: the
// old module's map would otherwise be unreachable from the new module's stop
// functions, orphaning every 1s polling interval forever.
const watches: Map<string, WatchState> = ((globalThis as any).__transcriptWatches ??=
  new Map());

// Server-side hook: backstage registers a listener so appended entries can
// reconcile state that mirrors the transcript (steer receipts — a receipt
// whose message has landed must clear NOW, not at run end, or it shows as
// still-queued and a mid-run restart would re-deliver it). On globalThis so
// hot reloads re-register cleanly; read at call time.
type AppendListener = (sessionId: string, entries: TranscriptEntry[]) => void;
export function setTranscriptAppendListener(fn: AppendListener): void {
  (globalThis as any).__transcriptAppendListener = fn;
}
function notifyAppendListener(sessionId: string | undefined, entries: TranscriptEntry[]) {
  if (!sessionId || entries.length === 0) return;
  const fn = (globalThis as any).__transcriptAppendListener as AppendListener | undefined;
  try {
    fn?.(sessionId, entries);
  } catch {
    // Reconcile is best-effort; never let it break transcript delivery.
  }
}

/**
 * Opaque revision tag for a transcript file, sent with transcript_init/append
 * and echoed back by clients on a resume-watch (`sinceRev`). It only has to
 * distinguish "same mirror file" from "the session's transcript moved" (engine
 * id rotation swaps transcriptPath; a byte offset into the OLD file must never
 * be applied to the new one) — a short path hash does that without leaking
 * server paths to the browser.
 */
export function transcriptRev(path: string): string {
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function getMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function pollFile(state: WatchState) {
  if (!existsSync(state.path)) return;

  const mtime = getMtime(state.path);
  if (mtime <= state.lastMtime) return;

  state.lastMtime = mtime;
  const { entries, newOffset } = parseTranscriptFrom(
    state.path,
    state.lastByteOffset
  );
  state.lastByteOffset = newOffset;

  if (entries.length === 0) return;

  notifyAppendListener(state.sessionId, entries);

  // endOffset + rev = the client's resume cursor: on reconnect it re-watches
  // with sinceOffset/sinceRev and the gap since this exact byte is replayed
  // from the jsonl instead of a full transcript_init replace.
  const msg = JSON.stringify({
    type: "transcript_append",
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    entries: clampEntriesForWire(entries),
    endOffset: state.lastByteOffset,
    rev: transcriptRev(state.path),
  });
  for (const ws of state.viewers) {
    try {
      ws.send(msg);
    } catch {
      // Dead connection, will be cleaned up on close
    }
  }
}

function sendTranscriptAppend(
  ws: any,
  entries: TranscriptEntry[],
  sessionId: string | undefined,
  endOffset: number,
  rev: string
): void {
  if (entries.length === 0) return;
  try {
    ws.send(
      JSON.stringify({
        type: "transcript_append",
        ...(sessionId ? { sessionId } : {}),
        entries: clampEntriesForWire(entries),
        endOffset,
        rev,
      })
    );
  } catch {
    // Dead connection, will be cleaned up on close
  }
}

export function startWatching(
  path: string,
  ws: any,
  initialOffset?: number,
  sessionId?: string
): void {
  let state = watches.get(path);
  if (state) {
    // A shared watch has one global byte offset. A new viewer may have just
    // parsed an older tail (or, for a fresh session, no transcript at all) and
    // ask to stream from that offset. Fill that viewer's gap without rewinding
    // the global watch for everyone else.
    if (initialOffset !== undefined && initialOffset < state.lastByteOffset) {
      const { entries, newOffset } = parseTranscriptFrom(path, initialOffset);
      sendTranscriptAppend(
        ws,
        entries,
        sessionId || state.sessionId,
        newOffset,
        transcriptRev(path)
      );
    }
    state.viewers.add(ws);
    if (sessionId && !state.sessionId) state.sessionId = sessionId;
    return;
  }

  state = {
    path,
    sessionId,
    // With a caller-supplied offset (including an explicit 0 — "stream this
    // file from the beginning", used when a run starts writing a brand-new
    // transcript), start with lastMtime 0 so the first poll flushes bytes
    // appended between the caller's parse and this watch (the file's current
    // mtime already covers them and would skip the tick). No offset = tail
    // only from the file's current end.
    lastMtime: initialOffset !== undefined ? 0 : getMtime(path),
    lastByteOffset: initialOffset ?? getFileSize(path),
    viewers: new Set([ws]),
    interval: null,
  };

  state.interval = setInterval(() => pollFile(state!), 1000);
  watches.set(path, state);
}

export function stopWatching(path: string, ws: any): void {
  const state = watches.get(path);
  if (!state) return;

  state.viewers.delete(ws);
  if (state.viewers.size === 0) {
    if (state.interval) clearInterval(state.interval);
    watches.delete(path);
  }
}

export function stopAllWatchesForClient(ws: any): void {
  for (const [path, state] of watches) {
    state.viewers.delete(ws);
    if (state.viewers.size === 0) {
      if (state.interval) clearInterval(state.interval);
      watches.delete(path);
    }
  }
}

export function getViewerCount(path: string): number {
  return watches.get(path)?.viewers.size || 0;
}
