/**
 * Reading a mesh peer's pi transcript.
 *
 * A peer registers its session id in the mesh; pi writes that session to
 * `~/.pi/agent/sessions/<cwd-slug>/<file>.jsonl`, whose first line is a v3
 * header carrying the id (the same shape `pi-runner.readSessionHeader`
 * expects). Finding the file is therefore a header scan, not a path guess.
 *
 * Parsing goes through pi's own `SessionManager` rather than reading the
 * jsonl by hand. A pi session is a *tree* — `/fork`, `/resume` and compaction
 * all branch it — so the conversation someone means by "the transcript" is the
 * root-to-leaf path, not the file in order. Reimplementing that traversal here
 * would be a second, worse copy of logic the engine already owns.
 *
 * Everything here is read-only, and only for sessions owned by this user.
 */

import { readdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** pi's own store. Distinct from `~/.opensession/pi`, which is the isolated
 *  state root Open Session runs its embedded engine under. */
export const PI_SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");

export type PeerTranscriptEntry = {
  role: string;
  text: string;
  ts?: number;
};

/** First jsonl line only — a session file can be megabytes and we are
 *  scanning a directory of them to match one id. */
function readHeaderId(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.toString("utf-8", 0, n).split("\n")[0];
    if (!first) return null;
    const header = JSON.parse(first) as { type?: string; id?: string };
    return header?.type === "session" && header.id ? header.id : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Session files live one directory deep, grouped by working directory. */
function* sessionFiles(): Generator<string> {
  let groups: string[];
  try {
    groups = readdirSync(PI_SESSIONS_DIR);
  } catch {
    return;
  }
  for (const group of groups) {
    const dir = path.join(PI_SESSIONS_DIR, group);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".jsonl")) yield path.join(dir, name);
      }
    } catch {
      continue;
    }
  }
}

/** The file whose header id matches, or null. Newest first: an id collision
 *  is not expected, but a recent file is the better guess if one occurs. */
export function findPeerSessionFile(sessionId: string): string | null {
  const candidates: { file: string; mtime: number }[] = [];
  for (const file of sessionFiles()) {
    try {
      candidates.push({ file, mtime: statSync(file).mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates) {
    if (readHeaderId(file) === sessionId) return file;
  }
  return null;
}

/** Flatten one pi entry's content to display text. Pi content is a union of
 *  parts (text, thinking, tool calls); anything without text renders as a
 *  short marker rather than being dropped, so a tool-only turn is still
 *  visible as activity. */
function entryText(entry: unknown): string {
  const message = (entry as { message?: unknown })?.message;
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; text?: string; name?: string };
    if (typeof p?.text === "string" && p.text) parts.push(p.text);
    else if (p?.type === "toolCall" || p?.type === "tool_use")
      parts.push(`[tool: ${p.name ?? "?"}]`);
  }
  return parts.join("\n\n");
}

/**
 * The root-to-leaf conversation for a peer's session, oldest first.
 *
 * Returns null when the session file cannot be found, which is the normal
 * answer for a Claude Code peer: it registers in the same mesh but writes its
 * transcript somewhere else entirely.
 */
export async function readPeerTranscript(
  sessionId: string,
  limit = 200,
): Promise<PeerTranscriptEntry[] | null> {
  const file = findPeerSessionFile(sessionId);
  if (!file) return null;

  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.open(file);
  // getBranch() walks the active leaf back to the root in path order;
  // getEntries() would include abandoned forks and read as duplicated turns.
  const entries = manager.getBranch();

  const out: PeerTranscriptEntry[] = [];
  for (const entry of entries) {
    const e = entry as {
      type?: string;
      message?: { role?: string };
      timestamp?: number | string;
    };
    const role = e?.message?.role;
    if (!role) continue; // non-message entries: model changes, compaction marks
    const text = entryText(entry);
    if (!text) continue;
    const ts =
      typeof e.timestamp === "number"
        ? e.timestamp
        : typeof e.timestamp === "string"
          ? Date.parse(e.timestamp) || undefined
          : undefined;
    out.push({ role, text, ...(ts ? { ts } : {}) });
  }
  // A long session should render its tail, not its head.
  return out.length > limit ? out.slice(-limit) : out;
}
