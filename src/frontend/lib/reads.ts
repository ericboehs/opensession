// Per-session "last read" marks, so the sidebar can flag sessions with unread
// activity (WhatsApp/iMessage-style). We store, per session id, the
// `lastActivity` timestamp the session had the last time it was open in the
// viewer. A session counts as unread when its current `lastActivity` is newer
// than that mark — i.e. something happened after you last looked.
//
// Only sessions you've actually opened get a mark, so sessions you've never
// looked at (other people's, automations you don't follow) don't all light up
// as unread — the flag means "new since you last read it", not "never seen".

import { saveReadsApi } from "./api";
import { getCurrentUser } from "../components/UserPicker";

const KEY = "opensession-reads";
const CHANGE_EVENT = "opensession-reads-changed";
// Bound the map so it can't grow forever; when over cap we drop the
// oldest-inserted marks (object key order is insertion order).
const CAP = 500;

type ReadMap = Record<string, string>;

function read(): ReadMap {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function getReads(): ReadMap {
  return read();
}

// Mirror the full read map to the server (fire-and-forget) so consumers that
// can't see localStorage — the hardware macropad feed (GET /api/keypad) — can
// flag unread sessions. Optimistic, like pins: failures are ignored.
function syncToServer(map: ReadMap): void {
  void saveReadsApi(getCurrentUser(), map).catch(() => {});
}

/**
 * Record that a session has been read up to `activity` (its `lastActivity` at
 * the moment it's open). No-op if we already have that exact mark, so calling
 * it on every activity tick while a session is open stays cheap and doesn't
 * spam the change event.
 */
export function markRead(id: string, activity: string): void {
  const map = read();
  if (map[id] === activity) return;
  map[id] = activity;
  const keys = Object.keys(map);
  if (keys.length > CAP) {
    for (const k of keys.slice(0, keys.length - CAP)) delete map[k];
  }
  localStorage.setItem(KEY, JSON.stringify(map));
  window.dispatchEvent(new Event(CHANGE_EVENT));
  syncToServer(map);
}

/**
 * Force a session to read as unread: park its mark at the epoch so any real
 * `lastActivity` is newer (see isUnread). Used by the sidebar's "Mark as unread"
 * — the inverse of markRead. If the session is currently open the viewer will
 * re-mark it read on the next activity tick, which is the expected behavior.
 */
export function markUnread(id: string): void {
  const map = read();
  const epoch = "1970-01-01T00:00:00.000Z";
  if (map[id] === epoch) return;
  map[id] = epoch;
  localStorage.setItem(KEY, JSON.stringify(map));
  window.dispatchEvent(new Event(CHANGE_EVENT));
  syncToServer(map);
}

/** True when the session has activity newer than the last read mark. */
export function isUnread(
  id: string,
  lastActivity: string,
  reads: ReadMap,
): boolean {
  const mark = reads[id];
  if (!mark) return false;
  return new Date(lastActivity).getTime() > new Date(mark).getTime();
}

export function onReadsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
