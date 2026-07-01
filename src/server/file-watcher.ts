import { statSync } from "fs";
import { existsSync } from "fs";
import { parseTranscriptFrom } from "./jsonl-parser";
import type { TranscriptEntry } from "./types";

interface WatchState {
  path: string;
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

  const msg = JSON.stringify({ type: "transcript_append", entries });
  for (const ws of state.viewers) {
    try {
      ws.send(msg);
    } catch {
      // Dead connection, will be cleaned up on close
    }
  }
}

export function startWatching(
  path: string,
  ws: any,
  initialOffset: number = 0
): void {
  let state = watches.get(path);
  if (state) {
    state.viewers.add(ws);
    return;
  }

  state = {
    path,
    // With a caller-supplied offset, start with lastMtime 0 so the first poll
    // flushes bytes appended between the caller's parse and this watch (the
    // file's current mtime already covers them and would skip the tick).
    lastMtime: initialOffset ? 0 : getMtime(path),
    lastByteOffset: initialOffset || getFileSize(path),
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
