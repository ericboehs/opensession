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
import { envAlias } from "./rename-compat";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { Database } from "bun:sqlite";
import type { TranscriptEntry } from "./types";
import type { ImageInput } from "./run-events";
import { stripContext } from "./prompt-context";

const HOME = process.env.HOME || "/home/ubuntu";

/** The opencode SQLite store for the HOME opencode-runner passes through. */
export const OPENCODE_DB_PATH =
  envAlias("OPENSESSION_OPENCODE_DB", "BACKSTAGE_OPENCODE_DB") ||
  `${HOME}/.local/share/opencode/opencode.db`;

// ── Per-server DB sharding: locating a session's database ────────────────────
//
// Since the 2026-07-17 storage review, each `opencode serve` process gets its
// own SQLite file via the (official) OPENCODE_DB env var — per-session servers
// one DB per session, shared servers one DB per (account × user). That means
// "which file holds engine session ses_X?" is no longer a constant. The runner
// records the answer in a small JSON map the moment it creates/uses a session
// (recordOpencodeDbFor); readers resolve through it (resolveOpencodeDbFor) and
// fall back to probing the legacy candidates — the main DB, the per-account
// openai DBs (which the old constant never covered), and recent shard DBs.

/** ocSessionId → absolute DB path, written by the runner, read by resolvers. */
const OPENCODE_DB_MAP_PATH =
  envAlias("OPENSESSION_OPENCODE_DB_MAP", "BACKSTAGE_OPENCODE_DB_MAP") ||
  `${HOME}/.opensession-chats/opencode/db-map.json`;

const OPENAI_DATA_ROOT = `${HOME}/.opensession-opencode/openai-data`;
const SHARD_DB_DIR = `${HOME}/.opensession-chats/opencode/db`;

function readDbMap(): Record<string, string> {
  try {
    if (!existsSync(OPENCODE_DB_MAP_PATH)) return {};
    const parsed = JSON.parse(readFileSync(OPENCODE_DB_MAP_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember which DB file an engine session lives in. Entries whose file is
 *  gone are pruned on write, so the map tracks the shard GC for free. */
export function recordOpencodeDbFor(ocSessionId: string, dbPath: string): void {
  if (!ocSessionId || !dbPath) return;
  try {
    const map = readDbMap();
    if (map[ocSessionId] === dbPath) return;
    map[ocSessionId] = dbPath;
    for (const [id, p] of Object.entries(map)) {
      if (!existsSync(p)) delete map[id];
    }
    mkdirSync(OPENCODE_DB_MAP_PATH.slice(0, OPENCODE_DB_MAP_PATH.lastIndexOf("/")), {
      recursive: true,
    });
    const tmp = `${OPENCODE_DB_MAP_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(map));
    renameSync(tmp, OPENCODE_DB_MAP_PATH);
  } catch (e) {
    console.warn("[opencode-transcript] db-map write failed:", e);
  }
}

/** Legacy + shard DB files worth probing when the map has no answer:
 *  per-account openai DBs, then recent shard DBs (newest first, capped). */
function candidateDbPaths(): string[] {
  const out: string[] = [];
  try {
    try {
      for (const acct of readdirSync(OPENAI_DATA_ROOT)) {
        const p = `${OPENAI_DATA_ROOT}/${acct}/opencode/opencode.db`;
        if (existsSync(p)) out.push(p);
      }
    } catch {}
    try {
      const shards = readdirSync(SHARD_DB_DIR)
        .filter((f) => f.endsWith(".db"))
        .map((f) => {
          const p = `${SHARD_DB_DIR}/${f}`;
          try {
            return { p, m: statSync(p).mtimeMs };
          } catch {
            return { p, m: 0 };
          }
        })
        .sort((a, b) => b.m - a.m)
        .slice(0, 50);
      for (const s of shards) out.push(s.p);
    } catch {}
  } catch {}
  return out;
}

/** The DB file holding this engine session: map hit, else probe the main DB
 *  and the candidates (memoizing a hit back into the map). Always returns a
 *  path — the legacy main DB when nothing matches, preserving old behavior. */
export function resolveOpencodeDbFor(ocSessionId: string | null | undefined): string {
  if (!ocSessionId) return OPENCODE_DB_PATH;
  const hit = readDbMap()[ocSessionId];
  if (hit && existsSync(hit)) return hit;
  if (hasOpencodeTranscript(ocSessionId, OPENCODE_DB_PATH)) return OPENCODE_DB_PATH;
  for (const p of candidateDbPaths()) {
    if (hasOpencodeTranscript(ocSessionId, p)) {
      recordOpencodeDbFor(ocSessionId, p);
      return p;
    }
  }
  return OPENCODE_DB_PATH;
}

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
  envAlias(
    "OPENSESSION_OPENCODE_TRANSCRIPTS_DIR",
    "BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR",
  ) || `${HOME}/.claude/projects/-opencode-engine`;

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

export function transcriptLineUser(
  text: string,
  id?: string,
  ts?: string,
  images?: ImageInput[]
): JsonlLine {
  return {
    type: "user",
    uuid: id || crypto.randomUUID(),
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "user",
      content: [
        { type: "text", text },
        // Pasted images ride alongside the text block in the same claude-shape
        // blocks jsonl-parser's extractImages reads — without them the mirror
        // file loses the images the run actually received (they only exist in
        // opencode's SQLite as `file` parts, which nothing renders).
        ...(images || []).map((im) => ({
          type: "image",
          source: { type: "base64", media_type: im.mediaType, data: im.data },
        })),
      ],
    },
  };
}

/** Runner operational notice ("usage limit hit; switched account and
 *  retrying") as a durable transcript line. Rides a user-role line — the only
 *  role the runner can inject without claiming the model said something — with
 *  a harness marker the jsonl parser maps to a `system` entry (same pattern as
 *  `<task-notification>`), so it renders as a system chip instead of a user
 *  bubble and never confuses pending-bubble/steer reconciliation. */
export function transcriptLineRunnerNotice(
  text: string,
  id?: string,
  ts?: string
): JsonlLine {
  return transcriptLineUser(`<runner-notice>${text}</runner-notice>`, id, ts);
}

export function transcriptLineAssistantText(
  text: string,
  id?: string,
  ts?: string,
  model?: string
): JsonlLine {
  return {
    type: "assistant",
    uuid: id || crypto.randomUUID(),
    timestamp: ts || new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      // Same slot the Claude SDK uses on its assistant lines, so the shared
      // jsonl parser reads both without a special case.
      ...(model ? { model } : {}),
    },
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
    case "user": {
      const line = transcriptLineUser(e.content, e.id, e.timestamp);
      if (e.images?.length) {
        // Entry images are ready-to-render srcs (data: or http(s) URLs) — a
        // url-source image block round-trips both through extractImages.
        (line.message as { content: unknown[] }).content.push(
          ...e.images.map((src) => ({
            type: "image",
            source: { type: "url", url: src },
          }))
        );
      }
      return line;
    }
    case "assistant":
      return transcriptLineAssistantText(e.content, e.id, e.timestamp, e.model);
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

/** Uuids already present in a session's persisted transcript file. */
export function opencodeTranscriptUuids(ocSessionId: string): Set<string> {
  const out = new Set<string>();
  try {
    const path = getOpencodeTranscriptPath(ocSessionId);
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const uuid = (JSON.parse(line) as { uuid?: unknown }).uuid;
        if (typeof uuid === "string" && uuid) out.add(uuid);
      } catch {}
    }
  } catch {}
  return out;
}

/**
 * Append transcript lines for engine activity the live mirror missed — the
 * restart gap, where a turn kept executing inside a detached `opencode serve`
 * while no backstage process was around to pump its events (reattach path,
 * opencode-runner.tryReattachOpencodeRun). Assistant text and tool lines
 * only: their uuids are stable opencode part ids in BOTH writers (the live
 * SSE mirror and the SQLite reader), so uuid-dedup is sound; user lines are
 * written by the runner at send time with random uuids and never need
 * backfill. Returns every uuid now present, for seeding the live pump's
 * dedup sets so post-gap events don't double-append.
 */
export function backfillOpencodeTranscriptGap(ocSessionId: string): Set<string> {
  const seen = opencodeTranscriptUuids(ocSessionId);
  try {
    const missing: JsonlLine[] = [];
    for (const e of readOpencodeTranscript(ocSessionId)) {
      if (e.type === "user") continue;
      const line = transcriptLineForEntry(e);
      if (!line) continue;
      const uuid = String(line.uuid || "");
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      missing.push(line);
    }
    if (missing.length) {
      appendOpencodeTranscript(ocSessionId, missing);
      console.log(
        `[opencode-transcript] backfilled ${missing.length} gap line(s) for ${ocSessionId}`
      );
    }
  } catch (e) {
    console.warn(`[opencode-transcript] gap backfill failed for ${ocSessionId}:`, e);
  }
  return seen;
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
  // Assistant messages carry the upstream provider/model that produced them.
  providerID?: string;
  modelID?: string;
}

interface PartData {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  // `file` parts (pasted images ride as data: URLs).
  mime?: string;
  url?: string;
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
  dbPath?: string
): TranscriptEntry[] {
  if (!sessionId) return [];
  // No explicit path ⇒ resolve which shard/legacy DB holds this session.
  if (!dbPath) dbPath = resolveOpencodeDbFor(sessionId);
  if (!existsSync(dbPath)) return [];
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
      // Reconstruct our full model id shape from opencode's provider/model pair.
      const model =
        role === "assistant" && data.providerID && data.modelID
          ? `opencode/${data.providerID}/${data.modelID}`
          : undefined;
      // Pasted images arrive as `file` parts alongside the message's text part;
      // collect their renderable srcs and hang them on the message's user entry
      // (mirrors jsonl-parser's pasted-image handling).
      const msgImages: string[] = [];
      const entriesStart = entries.length;
      for (const p of partsByMessage.get(m.id) || []) {
        let part: PartData;
        try {
          part = JSON.parse(p.data);
        } catch {
          continue;
        }
        if (part.type === "file") {
          const url = typeof part.url === "string" ? part.url : "";
          if (role === "user" && url && (part.mime || "").startsWith("image/")) {
            msgImages.push(url);
          }
          continue;
        }
        if (part.type === "text") {
          if (part.synthetic) continue;
          const text = role === "user" ? stripContext(part.text || "") : part.text || "";
          if (!text.trim()) continue;
          entries.push({
            id: p.id,
            type: role,
            content: text,
            timestamp: ts,
            ...(model ? { model } : {}),
          });
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
        // reasoning / step-start / step-finish / patch / snapshot parts
        // have no transcript rendering — skip.
      }
      if (msgImages.length) {
        const lastUser = [...entries.slice(entriesStart)]
          .reverse()
          .find((e) => e.type === "user");
        if (lastUser) {
          lastUser.images = [...(lastUser.images || []), ...msgImages];
        } else {
          entries.push({
            id: m.id,
            type: "user",
            content: "",
            timestamp: ts,
            images: msgImages,
          });
        }
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
