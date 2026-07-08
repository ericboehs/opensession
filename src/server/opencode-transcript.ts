/**
 * Read an OpenCode engine session's transcript out of OpenCode's own storage
 * (the ~/.local/share/opencode/opencode.db SQLite database — the pinned
 * opencode versions migrated session/message/part storage from per-file JSON
 * to SQLite) and map it onto our TranscriptEntry shape.
 *
 * This is the missing half of cross-engine handoff for the opencode engine:
 * claude↔codex handoffs read the other engine's transcript file
 * (getEngineTranscriptPath → parseTranscript), but opencode has no transcript
 * *file* to tail — sessions live in SQLite. So instead of a path this module
 * reads entries directly; sessions.ts's readEngineTranscript /
 * mergedSessionTranscript dispatch here for provider "opencode".
 *
 * Read-only by construction ({ readonly: true } + WAL allows concurrent
 * readers), opened per call and closed immediately — never holds the live
 * `opencode serve` processes' database open. Every failure path (missing db,
 * schema drift after an opencode upgrade, corrupt rows) degrades to [] so a
 * transcript read can never take a prompt path down.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { Database } from "bun:sqlite";
import type { TranscriptEntry } from "./types";
import { stripContext } from "./prompt-context";

const HOME = process.env.HOME || "/home/ubuntu";

/** The opencode SQLite store for the HOME opencode-runner passes through. */
export const OPENCODE_DB_PATH =
  process.env.BACKSTAGE_OPENCODE_DB || `${HOME}/.local/share/opencode/opencode.db`;

/**
 * Where the runner PERSISTS a claude-shape JSONL transcript per opencode
 * session (opencode itself only has the SQLite store — no tailable file, which
 * is why opencode sessions used to come back as "No transcript available" on
 * every reload). Deliberately a directory *inside* ~/.claude/projects: the
 * transcript resolver's last-resort scan (sessions.ts findTranscriptBySessionId)
 * walks every projects subdir for `<id>.jsonl`, so files here are discovered
 * by that existing convention with zero resolver special-cases — including by
 * code paths from before this module existed. The dir name follows the hashed
 * -cwd- convention and corresponds to no real checkout path.
 */
export const OPENCODE_TRANSCRIPTS_DIR =
  process.env.BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR ||
  `${HOME}/.claude/projects/-opencode-engine`;

export function getOpencodeTranscriptPath(ocSessionId: string): string {
  const safe = ocSessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${OPENCODE_TRANSCRIPTS_DIR}/${safe}.jsonl`;
}

/** The persisted transcript file, or null when this session has none (yet). */
export function existingOpencodeTranscriptPath(
  ocSessionId: string | null | undefined
): string | null {
  if (!ocSessionId) return null;
  const path = getOpencodeTranscriptPath(ocSessionId);
  return existsSync(path) ? path : null;
}

// ── Claude-shape JSONL line builders ─────────────────────────────────────────
// The persisted file is parsed by jsonl-parser's claude-line parser (and by
// the live file watcher), so lines mimic the minimal subset of the Claude SDK
// jsonl shape the parser reads: type/uuid/timestamp + message.content blocks.

type JsonlLine = Record<string, unknown>;

export function transcriptLineUser(text: string, id?: string, ts?: string): JsonlLine {
  return {
    type: "user",
    uuid: id || crypto.randomUUID(),
    timestamp: ts || new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

export function transcriptLineAssistantText(text: string, id?: string, ts?: string): JsonlLine {
  return {
    type: "assistant",
    uuid: id || crypto.randomUUID(),
    timestamp: ts || new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

export function transcriptLineToolUse(
  toolUseId: string,
  name: string,
  input: unknown,
  ts?: string
): JsonlLine {
  return {
    type: "assistant",
    uuid: `${toolUseId}-use`,
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input: input ?? {} }],
    },
  };
}

export function transcriptLineToolResult(
  toolUseId: string,
  content: string,
  isError?: boolean,
  ts?: string
): JsonlLine {
  return {
    type: "user",
    uuid: `${toolUseId}-result`,
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

/** Map an already-parsed TranscriptEntry (any engine) back onto a claude-shape
 *  jsonl line, preserving ids so re-parsed copies upsert instead of duplicate.
 *  Used to seed a migrated session's opencode transcript file with its prior
 *  claude/codex history, and to backfill legacy opencode sessions from SQLite. */
export function transcriptLineForEntry(e: TranscriptEntry): JsonlLine | null {
  switch (e.type) {
    case "user":
      return transcriptLineUser(e.content, e.id, e.timestamp);
    case "assistant":
      return transcriptLineAssistantText(e.content, e.id, e.timestamp);
    case "tool_use":
      return transcriptLineToolUse(
        e.toolUseId || e.id,
        e.toolName || "Tool",
        e.toolInput,
        e.timestamp
      );
    case "tool_result":
      return e.toolUseId
        ? transcriptLineToolResult(e.toolUseId, e.content, e.isError, e.timestamp)
        : null;
    default:
      return null; // system entries are derived, not re-serialized
  }
}

/** Append lines to a session's persisted transcript (best-effort — a
 *  transcript write must never take the run down). */
export function appendOpencodeTranscript(
  ocSessionId: string,
  lines: JsonlLine[]
): void {
  if (!lines.length) return;
  try {
    mkdirSync(OPENCODE_TRANSCRIPTS_DIR, { recursive: true });
    appendFileSync(
      getOpencodeTranscriptPath(ocSessionId),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
    );
  } catch (e) {
    console.warn(`[opencode-transcript] append failed for ${ocSessionId}:`, e);
  }
}

/**
 * Make sure the persisted transcript file exists before a run starts writing
 * to it. `seed` (a cross-engine handoff's prior-engine entries) wins for
 * fresh sessions; otherwise a missing file is backfilled from OpenCode's
 * SQLite store, which heals sessions that ran before transcript persistence
 * existed on their next prompt. No-op when the file is already there.
 */
export function ensureOpencodeTranscriptFile(
  ocSessionId: string,
  seed?: TranscriptEntry[]
): void {
  try {
    const path = getOpencodeTranscriptPath(ocSessionId);
    if (existsSync(path)) return;
    const entries = seed?.length ? seed : readOpencodeTranscript(ocSessionId);
    const lines = entries
      .map(transcriptLineForEntry)
      .filter((l): l is JsonlLine => !!l);
    mkdirSync(OPENCODE_TRANSCRIPTS_DIR, { recursive: true });
    writeFileSync(
      path,
      lines.length ? lines.map((l) => JSON.stringify(l)).join("\n") + "\n" : ""
    );
  } catch (e) {
    console.warn(`[opencode-transcript] ensure failed for ${ocSessionId}:`, e);
  }
}

/**
 * OpenCode session ids look like `ses_0bc487ca3ffe…` — used to recognize
 * legacy session files where the opencode id rides the claude slot (runs
 * persisted before the dedicated `opencodeSessionId` field existed), and to
 * refuse resuming a Claude run on an id that was never Claude's.
 */
export function isOpencodeSessionId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("ses_");
}

interface MessageData {
  role?: string;
  time?: { created?: number };
  error?: { name?: string; data?: { message?: string } };
}

interface PartData {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
  };
}

function toIso(ms: number | undefined, fallback: string): string {
  if (!ms || !Number.isFinite(ms)) return fallback;
  try {
    return new Date(ms).toISOString();
  } catch {
    return fallback;
  }
}

/** Does OpenCode's store know this session id? (Cheap existence probe.) */
export function hasOpencodeTranscript(
  sessionId: string | null | undefined,
  dbPath = OPENCODE_DB_PATH
): boolean {
  if (!sessionId || !existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return !!db
        .query("SELECT 1 FROM session WHERE id = ? LIMIT 1")
        .get(sessionId);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * The session's transcript as TranscriptEntry[] — user/assistant text plus
 * tool_use/tool_result pairs, in message order. Synthetic parts (opencode's
 * own injected text) are skipped, and `<backstage:context>` fences (engine
 * handoffs, repos notes) are stripped from user text exactly like the claude
 * jsonl parser does, so the UI shows only what the human typed.
 */
export function readOpencodeTranscript(
  sessionId: string | null | undefined,
  dbPath = OPENCODE_DB_PATH
): TranscriptEntry[] {
  if (!sessionId || !existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
  try {
    const messages = db
      .query(
        "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC"
      )
      .all(sessionId) as Array<{ id: string; data: string; time_created: number }>;
    if (!messages.length) return [];
    const parts = db
      .query(
        "SELECT id, message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC"
      )
      .all(sessionId) as Array<{
      id: string;
      message_id: string;
      data: string;
      time_created: number;
    }>;

    const partsByMessage = new Map<string, typeof parts>();
    for (const p of parts) {
      const list = partsByMessage.get(p.message_id);
      if (list) list.push(p);
      else partsByMessage.set(p.message_id, [p]);
    }

    const entries: TranscriptEntry[] = [];
    for (const m of messages) {
      let data: MessageData;
      try {
        data = JSON.parse(m.data);
      } catch {
        continue;
      }
      const role = data.role === "user" ? "user" : "assistant";
      const ts = toIso(data.time?.created ?? m.time_created, new Date(0).toISOString());
      for (const p of partsByMessage.get(m.id) || []) {
        let part: PartData;
        try {
          part = JSON.parse(p.data);
        } catch {
          continue;
        }
        if (part.type === "text") {
          if (part.synthetic) continue;
          const text = role === "user" ? stripContext(part.text || "") : part.text || "";
          if (!text.trim()) continue;
          entries.push({ id: p.id, type: role, content: text, timestamp: ts });
        } else if (part.type === "tool") {
          entries.push({
            id: p.id,
            type: "tool_use",
            content: `Using ${part.tool || "tool"}`,
            timestamp: ts,
            toolName: part.tool,
            toolInput: part.state?.input,
            toolUseId: p.id,
          });
          const state = part.state;
          if (state?.status === "completed" || state?.status === "error") {
            entries.push({
              id: `tr-${p.id}`,
              type: "tool_result",
              content:
                state.status === "completed"
                  ? state.output || ""
                  : `Error: ${state.error || "tool failed"}`,
              timestamp: ts,
              toolUseId: p.id,
              ...(state.status === "error" ? { isError: true } : {}),
            });
          }
        }
        // reasoning / step-start / step-finish / file / patch / snapshot parts
        // have no transcript rendering — skip.
      }
    }
    return entries;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}
