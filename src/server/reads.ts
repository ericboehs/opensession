/**
 * Per-user "last read" marks — the server mirror of the frontend's localStorage
 * read state (src/frontend/lib/reads.ts). Each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file `~/.opensession-reads/<user>.json` of shape
 * `{ reads: Record<sessionId, isoTimestamp> }`, where the timestamp is the
 * session's `lastActivity` at the moment it was last open in the viewer.
 *
 * A session is unread when its current `lastActivity` is newer than its mark
 * (see isUnread). A session with no mark is never unread — the flag means "new
 * since you last read it", not "never seen" — matching the client semantics.
 *
 * The frontend pushes its full read map here whenever a mark changes (markRead
 * on open/activity, markUnread from the sidebar) so server-side consumers that
 * can't see localStorage — notably the hardware macropad feed (GET /api/keypad)
 * — can flag sessions with unread activity. Mirrors the flat-file pattern in
 * pins.ts.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./rename-compat";

const READS_DIR = stateDir("reads");

// Bound the map so it can't grow forever; when over cap we drop the
// oldest-inserted marks (object key order is insertion order). Matches the
// frontend CAP so the mirror and localStorage stay the same size.
const CAP = 500;

/** Map a free-form user name to a safe filename; empty/odd input → Anonymous. */
function sanitizeUser(user: string): string {
  const cleaned = (user || "").trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "Anonymous";
}

function fileFor(user: string): string {
  return `${READS_DIR}/${sanitizeUser(user)}.json`;
}

/** A user's read marks: session id → ISO `lastActivity` last seen. */
export function getReads(user: string): Record<string, string> {
  try {
    const f = fileFor(user);
    if (!existsSync(f)) return {};
    const raw = JSON.parse(readFileSync(f, "utf8"));
    const marks = raw?.reads;
    if (!marks || typeof marks !== "object") return {};
    const out: Record<string, string> = {};
    for (const [id, ts] of Object.entries(marks)) {
      if (typeof id === "string" && typeof ts === "string") out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Replace a user's read marks (strings only, capped). Wholesale, like setPins —
 * the frontend sends its full map on every change. Returns the stored map.
 */
export function setReads(user: string, reads: unknown): Record<string, string> {
  const clean: Record<string, string> = {};
  if (reads && typeof reads === "object") {
    for (const [id, ts] of Object.entries(reads as Record<string, unknown>)) {
      if (typeof id === "string" && typeof ts === "string") clean[id] = ts;
    }
  }
  // Enforce the cap (drop oldest-inserted keys), matching the frontend.
  const keys = Object.keys(clean);
  if (keys.length > CAP) {
    for (const k of keys.slice(0, keys.length - CAP)) delete clean[k];
  }
  try {
    if (!existsSync(READS_DIR)) mkdirSync(READS_DIR, { recursive: true });
    writeJsonAtomic(fileFor(user), { reads: clean });
  } catch {}
  return clean;
}

/**
 * True when the session has activity newer than the user's last-read mark.
 * A session with no mark is never unread (mirrors the client isUnread).
 */
export function isUnread(
  lastActivity: string | undefined,
  mark: string | undefined,
): boolean {
  if (!mark || !lastActivity) return false;
  const a = new Date(lastActivity).getTime();
  const m = new Date(mark).getTime();
  if (Number.isNaN(a) || Number.isNaN(m)) return false;
  return a > m;
}
