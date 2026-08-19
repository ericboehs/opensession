import { existsSync } from "fs";
import { Database } from "bun:sqlite";
import {
  isOpencodeSessionId,
  readOpencodeTranscript,
  resolveOpencodeDbFor,
} from "./opencode-transcript";
import { listSubagents } from "./subagents";
import type { SubagentTranscript } from "./subagents";

// Sub-agents a session spawned directly (as opposed to workflow agents):
//
//  - On the opencode engine, the in-session `task` tool spawns a CHILD opencode
//    session (session.parent_id in opencode's SQLite links it; the task part's
//    state.metadata.sessionId names it). Open Session's transcript mirror only
//    keeps the child's final output inline in the tool_result text, so the
//    child's own conversation — and the fact that sub-agents ran at all —
//    was invisible to the UI until this module.
//  - On the Claude Agent SDK engine, Task-tool sub-agents land in the
//    `<transcript>/subagents/` sibling layout (see subagents.ts).
//
// listSessionSubagents merges both into one snapshot list for the Agents tab;
// getOpencodeSubagentTranscript serves the drill-in for opencode children
// (the SDK layout already had a reader).

export interface SessionSubagentSnapshot {
  /** Child engine session id (ses_…) or SDK agentId — the drill-in key.
   *  Missing only for a task call still pending before its child exists. */
  id?: string;
  /** The spawning task call's tool_use id (opencode part id / SDK toolUseId).
   *  Matches the transcript entry's toolUseId, so the UI can link a Task row
   *  to this snapshot — and open the child — while the call is still running
   *  (the result text that normally carries the child id doesn't exist yet). */
  toolUseId?: string;
  /** Agent flavor: task subagent_type / opencode agent name / SDK agentType. */
  agentType?: string;
  /** Row label: the task call's description, falling back to the child title. */
  label: string;
  status: "pending" | "running" | "done" | "error";
  /** Epoch ms (opencode's native representation). */
  startedAt?: number;
  endedAt?: number;
  model?: string;
  tokensOut?: number;
  source: "opencode" | "sdk";
}

/** The opencode engine session id backing a session, wherever it rides (the
 *  dedicated slot, or the claude slot on legacy pre-`opencodeSessionId` runs). */
export function sessionOpencodeId(session: {
  opencodeSessionId?: string | null;
  claudeSessionId?: string | null;
}): string | null {
  if (session.opencodeSessionId) return session.opencodeSessionId;
  return isOpencodeSessionId(session.claudeSessionId)
    ? (session.claudeSessionId ?? null)
    : null;
}

/** Model refs appear both as bare ids and as {providerID,id,…} objects (the
 *  session.model column holds the latter JSON-stringified) — normalize to the
 *  bare model id the UI's model-chip formatter understands. */
function modelId(v: unknown): string | undefined {
  if (typeof v === "string") {
    if (!v.startsWith("{")) return v;
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (v && typeof v === "object" && typeof (v as any).id === "string")
    return (v as any).id;
  return undefined;
}

/** Strip opencode's "(@explore subagent)" suffix off a child session title. */
function tidyChildTitle(title: string | null | undefined): string {
  return (title || "").replace(/\s*\(@[^)]+ subagent\)\s*$/, "").trim();
}

interface ChildRow {
  id: string;
  agent: string | null;
  title: string | null;
  model: string | null;
  tokens_output: number;
  time_created: number;
  time_updated: number;
}

function listOpencodeSubagents(ocSessionId: string): SessionSubagentSnapshot[] {
  const dbPath = resolveOpencodeDbFor(ocSessionId);
  if (!existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
  try {
    const children = db
      .query(
        "SELECT id, agent, title, model, tokens_output, time_created, time_updated FROM session WHERE parent_id = ? ORDER BY time_created ASC"
      )
      .all(ocSessionId) as ChildRow[];
    const byId = new Map(children.map((c) => [c.id, c]));

    // The parent's task tool parts carry the live status + the description the
    // model gave each sub-agent; the child session rows carry title/tokens.
    let parts: Array<{ id: string; data: string }> = [];
    try {
      parts = db
        .query(
          "SELECT id, data FROM part WHERE session_id = ? AND json_extract(data, '$.tool') = 'task' ORDER BY time_created ASC, id ASC"
        )
        .all(ocSessionId) as Array<{ id: string; data: string }>;
    } catch {
      // JSON1 hiccup or malformed rows — fall through to child rows alone.
    }

    const out: SessionSubagentSnapshot[] = [];
    const claimed = new Set<string>();
    for (const p of parts) {
      let d: any;
      try {
        d = JSON.parse(p.data);
      } catch {
        continue;
      }
      const state = d?.state ?? {};
      const childId: string | undefined =
        typeof state.metadata?.sessionId === "string"
          ? state.metadata.sessionId
          : undefined;
      const child = childId ? byId.get(childId) : undefined;
      if (childId) claimed.add(childId);
      const rawStatus: string = state.status ?? "pending";
      const status: SessionSubagentSnapshot["status"] =
        rawStatus === "completed"
          ? "done"
          : rawStatus === "error"
            ? "error"
            : rawStatus === "running"
              ? "running"
              : "pending";
      const model = modelId(state.metadata?.model) ?? modelId(child?.model);
      out.push({
        id: childId,
        // The part row id IS the transcript's tool_use id (data JSON carries
        // no id field of its own).
        toolUseId: p.id,
        agentType:
          (typeof state.input?.subagent_type === "string"
            ? state.input.subagent_type
            : undefined) ?? child?.agent ?? undefined,
        label:
          (typeof state.input?.description === "string" &&
          state.input.description.trim()
            ? state.input.description.trim()
            : "") ||
          tidyChildTitle(child?.title) ||
          "sub-agent",
        status,
        startedAt: state.time?.start ?? child?.time_created,
        endedAt: state.time?.end ?? undefined,
        model,
        tokensOut: child?.tokens_output || undefined,
        source: "opencode",
      });
    }
    // Children with no surviving task part (edge: pruned/compacted parent
    // transcript) still deserve a row.
    for (const c of children) {
      if (claimed.has(c.id)) continue;
      out.push({
        id: c.id,
        agentType: c.agent ?? undefined,
        label: tidyChildTitle(c.title) || "sub-agent",
        status: "done",
        startedAt: c.time_created,
        endedAt: c.time_updated,
        model: modelId(c.model),
        tokensOut: c.tokens_output || undefined,
        source: "opencode",
      });
    }
    out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Every sub-agent this session spawned, merged across engines. `sessionRunning`
 * lets callers clamp statuses: a task part frozen at "running" on a session
 * whose run is over (crash, interrupt) must not pulse forever.
 */
export function listSessionSubagents(session: {
  opencodeSessionId?: string | null;
  claudeSessionId?: string | null;
  transcriptPath?: string | null;
  isRunning?: boolean;
}): SessionSubagentSnapshot[] {
  const out: SessionSubagentSnapshot[] = [];
  const ocId = sessionOpencodeId(session);
  if (ocId) out.push(...listOpencodeSubagents(ocId));
  if (session.transcriptPath) {
    for (const m of listSubagents(session.transcriptPath)) {
      out.push({
        id: m.agentId,
        toolUseId: m.toolUseId,
        agentType: m.agentType,
        label: m.description || m.agentType || m.agentId,
        status: "done",
        source: "sdk",
      });
    }
  }
  if (!session.isRunning) {
    for (const s of out) {
      if (s.status === "running" || s.status === "pending") s.status = "done";
    }
  }
  return out;
}

/**
 * Drill-in transcript for an opencode task-tool child. Scoped to the parent:
 * only sessions whose parent_id matches are served, so a session route can't
 * be used to read arbitrary engine sessions.
 */
export function getOpencodeSubagentTranscript(
  session: {
    opencodeSessionId?: string | null;
    claudeSessionId?: string | null;
  },
  childId: string
): SubagentTranscript | null {
  const ocId = sessionOpencodeId(session);
  if (!ocId || !isOpencodeSessionId(childId)) return null;
  const dbPath = resolveOpencodeDbFor(ocId);
  if (!existsSync(dbPath)) return null;
  let row:
    | { agent: string | null; title: string | null; model: string | null }
    | undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      row = db
        .query(
          "SELECT agent, title, model FROM session WHERE id = ? AND parent_id = ?"
        )
        .get(childId, ocId) as typeof row;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  if (!row) return null;
  return {
    meta: {
      agentId: childId,
      agentType: row.agent ?? undefined,
      model: modelId(row.model),
      description: tidyChildTitle(row.title) || undefined,
    },
    entries: readOpencodeTranscript(childId, dbPath),
  };
}
