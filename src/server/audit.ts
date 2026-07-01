import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";

// Structured audit log, modeled on tellahq/incident-agent's src/audit.ts.
// One JSON line per event into a daily file under ~/.backstage-audit/.
// incident-agent ships stdout via Docker's awslogs driver; backstage runs as
// a systemd unit that hard-denies IMDS (backstage.service), so it can never
// hold AWS credentials itself — a separate amazon-cloudwatch-agent service
// tails these files into CloudWatch Logs instead (see deploy/README-audit.md).

const HOME = process.env.HOME || "/home/ubuntu";
const AUDIT_DIR = `${HOME}/.backstage-audit`;

// Match incident-agent's CloudWatch retention (400d) for the local files.
const RETENTION_DAYS = 400;

let initialized = false;

function ensureAuditDir(): void {
  if (initialized) return;
  initialized = true;
  mkdirSync(AUDIT_DIR, { recursive: true });
  pruneOldFiles();
}

function pruneOldFiles(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const file of readdirSync(AUDIT_DIR)) {
      const m = file.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      if (new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) {
        unlinkSync(`${AUDIT_DIR}/${file}`);
      }
    }
  } catch (e) {
    console.error("[audit] prune failed:", e);
  }
}

/**
 * Emit one audit event as a JSON line. Never throws — audit failures must not
 * take down the run they're observing (they do land in journald via stderr).
 */
export function audit(event: Record<string, unknown>): void {
  try {
    ensureAuditDir();
    const now = new Date();
    const line = JSON.stringify({
      time: now.toISOString(),
      service: "backstage",
      ...event,
    });
    appendFileSync(`${AUDIT_DIR}/audit-${now.toISOString().slice(0, 10)}.jsonl`, line + "\n");
  } catch (e) {
    console.error("[audit] write failed:", e);
  }
}

// Stored all-lowercase so the redactor's `.toLowerCase()` lookup catches
// camelCase and snake_case variants alike.
const SECRET_KEYS = new Set([
  "token",
  "apikey",
  "api_key",
  "password",
  "secret",
  "authorization",
  "auth",
  "bearer",
  "pat",
  "credential",
  "credentials",
]);

/** Scrub secret-shaped keys from a value before it lands in the audit log. */
export function redactArgs(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redactArgs);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redactArgs(v);
    }
    return out;
  }
  return value;
}

export function digest(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export interface TextSummary {
  text_sha256: string;
  text_bytes: number;
  text_snippet: string;
}

/**
 * Bounded audit view of a potentially-large string: truncated snippet + byte
 * length + full sha256, so the log stays small but the exact body can still
 * be reconciled against the on-disk Claude session jsonl when needed.
 */
export function summarizeText(text: string | undefined, snippetBytes = 300): TextSummary {
  const s = text ?? "";
  return {
    text_sha256: createHash("sha256").update(s).digest("hex"),
    text_bytes: Buffer.byteLength(s, "utf8"),
    text_snippet: s.length > snippetBytes ? `${s.slice(0, snippetBytes)}…` : s,
  };
}

// ── Read side (the in-app audit viewer, Settings → Audit log) ──

/** Dates (YYYY-MM-DD, newest first) that have an audit file. */
export function listAuditDates(): string[] {
  ensureAuditDir();
  try {
    return readdirSync(AUDIT_DIR)
      .map((f) => f.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
      .filter((d): d is string => !!d)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The per-turn streaming firehose — hidden by the viewer's default
 *  "significant only" filter so decisions/prompts/confirmations stand out. */
const NOISY_KINDS = new Set([
  "tool_use",
  "tool_result",
  "assistant_text",
  "assistant_thinking",
  "result",
]);

export interface AuditReadResult {
  /** Page of events, newest first. */
  events: Array<Record<string, unknown>>;
  /** Total matches for the filter (before offset/limit). */
  total: number;
  /** Distinct event types seen on this date (for the filter dropdown). */
  types: string[];
}

/** One event's display type: the runner events carry `kind`, the audited()
 *  wrapper and other emitters carry `msg`. */
function eventType(e: Record<string, unknown>): string {
  return String(e.kind || e.msg || "event");
}

export function readAuditEvents(opts: {
  date: string;
  /** Case-insensitive substring across the raw line. */
  q?: string;
  /** Exact event type (see eventType). */
  type?: string;
  /** Substring match on bks_session_id. */
  session?: string;
  /** Drop the per-turn firehose kinds (default true). */
  significantOnly?: boolean;
  offset?: number;
  limit?: number;
}): AuditReadResult {
  ensureAuditDir();
  const path = `${AUDIT_DIR}/audit-${opts.date}.jsonl`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date) || !existsSync(path)) {
    return { events: [], total: 0, types: [] };
  }
  const q = (opts.q || "").toLowerCase();
  const significantOnly = opts.significantOnly !== false;
  const offset = Math.max(0, opts.offset || 0);
  const limit = Math.min(500, Math.max(1, opts.limit || 200));

  const types = new Set<string>();
  const matches: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = eventType(e);
    types.add(t);
    if (opts.type && t !== opts.type) continue;
    if (!opts.type && significantOnly && NOISY_KINDS.has(t)) continue;
    if (opts.session && !String(e.bks_session_id || "").includes(opts.session)) continue;
    if (q && !line.toLowerCase().includes(q)) continue;
    matches.push(e);
  }
  matches.reverse(); // newest first
  return {
    events: matches.slice(offset, offset + limit),
    total: matches.length,
    types: [...types].sort(),
  };
}

/**
 * Wraps a side-effecting call with start/end audit events: redacted args on
 * both, result fingerprint + duration on completion. Results are only
 * digested, never logged verbatim (data minimization).
 */
export async function audited<T>(
  ctx: { context: string; action: string; args?: unknown },
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  const base = {
    context: ctx.context,
    action: ctx.action,
    args_digest: digest(ctx.args),
    args_redacted: redactArgs(ctx.args),
  };

  audit({ ...base, msg: "action_start" });
  try {
    const result = await fn();
    audit({
      ...base,
      msg: "action_end",
      ok: true,
      result_digest: digest(result),
      duration_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    audit({
      ...base,
      msg: "action_end",
      ok: false,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
