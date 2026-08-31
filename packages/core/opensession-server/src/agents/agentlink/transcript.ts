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

/**
 * One row of the transcript in the shape every Open Session client already
 * renders (`TranscriptEntry`): `type` is one of user / assistant / tool_use /
 * tool_result / system.
 *
 * A pi entry can produce several of these — an assistant turn that calls two
 * tools is one message but three rows — which is why the mapper below is a
 * flat-map rather than a field rename.
 */
export type ClientTranscriptEntry = {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  /** Always present, empty for a row that is only a tool call: the clients'
   *  wire type requires it. */
  content: string;
  /** Always present for the same reason as `content`. Falls back to the
   *  session's own clock when a pi entry carries no timestamp. */
  timestamp: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  isReasoning?: boolean;
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

/** Text out of a pi content array, ignoring images and other parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p) => (p as { type?: string })?.type === "text" || typeof (p as { text?: string })?.text === "string",
    )
    .map((p) => (p as { text?: string }).text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A pi session entry as the clients' transcript rows.
 *
 * Tool calls are split out of the assistant message into their own `tool_use`
 * rows so the client renders them the way it renders its own: a named call
 * with its arguments, not a line of prose claiming a tool ran. `toolUseId`
 * carries pi's call id, which is what pairs a result back to its call.
 */
function toClientEntries(
  entry: unknown,
  index: number,
): ClientTranscriptEntry[] {
  const e = entry as {
    id?: string;
    timestamp?: number | string;
    message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string };
  };
  const message = e?.message;
  const role = message?.role;
  if (!role) return [];

  const baseId = e.id || `entry-${index}`;
  const stamp = {
    timestamp:
      (typeof e.timestamp === "number"
        ? new Date(e.timestamp).toISOString()
        : typeof e.timestamp === "string"
          ? e.timestamp
          : undefined) ?? new Date(0).toISOString(),
  };

  if (role === "toolResult") {
    return [
      {
        id: baseId,
        type: "tool_result",
        content: textOf(message?.content),
        ...(message?.toolName ? { toolName: message.toolName } : {}),
        ...(message?.toolCallId ? { toolUseId: message.toolCallId } : {}),
        ...stamp,
      },
    ];
  }

  if (role === "user" || role === "system") {
    const content = textOf(message?.content);
    if (!content) return [];
    return [{ id: baseId, type: role, content, ...stamp }];
  }

  if (role !== "assistant") return [];

  const rows: ClientTranscriptEntry[] = [];
  const parts = Array.isArray(message?.content) ? message!.content : [];
  const text = textOf(message?.content);
  if (text) rows.push({ id: baseId, type: "assistant", content: text, ...stamp });
  const thinking = (parts as { type?: string; thinking?: string }[])
    .filter((p) => p?.type === "thinking" && p.thinking)
    .map((p) => p.thinking as string)
    .join("\n\n");
  if (thinking) {
    rows.push({
      id: `${baseId}:thinking`,
      type: "assistant",
      content: thinking,
      isReasoning: true,
      ...stamp,
    });
  }
  for (const part of parts as {
    type?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
  }[]) {
    if (part?.type !== "toolCall") continue;
    rows.push({
      id: part.id || `${baseId}:tool`,
      type: "tool_use",
      content: "",
      ...(part.name ? { toolName: part.name } : {}),
      ...(part.arguments !== undefined ? { toolInput: part.arguments } : {}),
      ...(part.id ? { toolUseId: part.id } : {}),
      ...stamp,
    });
  }
  return rows;
}

/**
 * A peer's transcript in the clients' own row shape, oldest last-N first.
 *
 * Null means no session file, which is the normal answer for a Claude Code
 * peer: it registers in the same mesh but writes its history elsewhere.
 */
export async function readPeerClientTranscript(
  sessionId: string,
  limit = 400,
): Promise<ClientTranscriptEntry[] | null> {
  const file = findPeerSessionFile(sessionId);
  if (!file) return null;
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const entries = SessionManager.open(file).getBranch();
  const rows = entries.flatMap((entry, i) => toClientEntries(entry, i));
  return rows.length > limit ? rows.slice(-limit) : rows;
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
