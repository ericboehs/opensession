/**
 * Keyless snapshot fixtures: record once, compare forever.
 *
 * The harness in this directory drives scripted sessions through the real run
 * pipeline on the fake engine (no API key, no network, no engine subprocess)
 * and freezes two things per scenario: what the pipeline WROTE (transcript
 * entries in the owned store) and what it HANDED THE ENGINE (prompt bodies,
 * notes, MCP scope, tool policy). This module is the record/compare half:
 *
 *   OPENSESSION_SNAPSHOT=record bun test src/server/zz-snapshot-runs.test.ts
 *
 * rewrites `snapshots/<name>.json`; any other value (or none) compares and
 * fails with a line diff. Fixtures are plain, readable JSON on purpose.
 * reviewing the DIFF of a fixture is the point of the exercise: a changed
 * fence, a newly mounted MCP server or a dropped tool strip has to show up in
 * a pull request as content, not as a passing test.
 *
 * See docs/transcript-snapshots.md for how to add a scenario and when a change
 * legitimately requires re-recording one.
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "../shared/atomic-write";

export const SNAPSHOT_DIR = join(import.meta.dir, "snapshots");

/** Record mode rewrites fixtures; everything else compares. */
export function snapshotMode(): "record" | "compare" {
  const v = (process.env.OPENSESSION_SNAPSHOT || "").toLowerCase();
  return v === "record" || v === "update" || v === "1" ? "record" : "compare";
}

export function snapshotPath(name: string): string {
  return join(SNAPSHOT_DIR, `${name}.json`);
}

/**
 * Compare `value` against the stored fixture (or write it in record mode).
 * Throws with a readable diff on mismatch; bun test surfaces the message.
 */
export function expectSnapshot(name: string, value: unknown): void {
  const actual = `${stableStringify(value)}\n`;
  const file = snapshotPath(name);
  if (snapshotMode() === "record") {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileAtomic(file, actual);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(
      `Snapshot "${name}" has never been recorded (${file}).\n` +
        `Record it with:  OPENSESSION_SNAPSHOT=record bun test <this file>\n` +
        `Then READ the fixture before committing it.`,
    );
  }
  const expected = readFileSync(file, "utf-8");
  if (expected === actual) return;
  throw new Error(
    `Snapshot "${name}" does not match ${file}.\n` +
      `If the new behaviour is intended, re-record with ` +
      `OPENSESSION_SNAPSHOT=record and review the fixture diff.\n\n` +
      diffLines(expected, actual),
  );
}

/** Deterministic JSON: object keys sorted, arrays kept in order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

// ── Diff ─────────────────────────────────────────────────────────────────────

const DIFF_MAX_LINES = 60;

/** Small LCS line diff. Snapshots are a few hundred lines, and an inserted
 *  line must not report every following line as changed. */
export function diffLines(expected: string, actual: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  // Trim the common head/tail first: it keeps the LCS table small and the
  // reported diff local to what actually moved.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  const out: string[] = [];
  for (const line of lcsDiff(aMid, bMid)) {
    if (out.length >= DIFF_MAX_LINES) {
      out.push(`  … (diff truncated; compare the file yourself)`);
      break;
    }
    out.push(line);
  }
  return out.length
    ? `  (line ${head + 1})\n${out.join("\n")}`
    : "  (files differ only in trailing whitespace)";
}

function lcsDiff(a: string[], b: string[]): string[] {
  // Bail out of the quadratic table on pathological inputs: a plain
  // side-by-side dump is still more useful than hanging the test run.
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.slice(0, DIFF_MAX_LINES / 2).map((l) => `- ${l}`),
      ...b.slice(0, DIFF_MAX_LINES / 2).map((l) => `+ ${l}`),
    ];
  }
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Volatile-value scrubber. Machine-specific paths are registered by the test
 * (temp dirs, the checkout root); the rest are shapes that are volatile
 * everywhere: clock, uuids, engine session ids, ports.
 *
 * Registered paths are replaced longest-first so `<tmp>/scratch` never comes
 * out as `<home>/…` because HOME happened to be a prefix.
 */
export class Normalizer {
  private paths: Array<{ from: string; to: string }> = [];

  /** Replace an absolute path with a stable label, e.g. "<tmp>". */
  path(from: string | undefined | null, to: string): this {
    if (from) this.paths.push({ from, to });
    return this;
  }

  text(value: string): string {
    let out = value;
    for (const { from, to } of [...this.paths].sort(
      (x, y) => y.from.length - x.from.length,
    ))
      out = out.split(from).join(to);
    for (const [re, to] of VOLATILE_PATTERNS) out = out.replace(re, to);
    return out;
  }

  value<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (VOLATILE_KEYS.has(k)) continue;
        out[k] = this.walk(v);
      }
      return out;
    }
    return value;
  }
}

/** Dropped outright: their value is a clock or a per-run identity. */
const VOLATILE_KEYS = new Set([
  "timestamp",
  "createdAt",
  "lastActivity",
  "startedAt",
  "firstJournaledAt",
  "at",
]);

const VOLATILE_PATTERNS: Array<[RegExp, string]> = [
  // ISO-8601 instants (transcript entries, memory `at`, handoff headers).
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>"],
  // uuid v4: prompt entry ids, engine session ids on the claude shape.
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<uuid>",
  ],
  // opencode engine session ids.
  [/\bses_[A-Za-z0-9_-]+/g, "<engine-session>"],
  // Unified session ids that a fixture didn't mint itself.
  [/\b(?:bks|os|slack|linear)-[0-9a-f][0-9a-f-]{7,}/g, "<session-id>"],
  // Loopback ports (run-rpc socket urls, relay urls).
  [/(127\.0\.0\.1|localhost):\d{2,5}/g, "$1:<port>"],
];
