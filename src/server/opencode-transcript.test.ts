import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { TranscriptEntry } from "./types";

// Point both stores at scratch dirs BEFORE importing the module under test
// (cache-busted import so the env overrides are read fresh).
const scratch = mkdtempSync(join(tmpdir(), "oc-transcript-test-"));
const dbPath = join(scratch, "opencode.db");
const transcriptsDir = join(scratch, "transcripts");
process.env.BACKSTAGE_OPENCODE_DB = dbPath;
process.env.BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR = transcriptsDir;

const mod = await import(`./opencode-transcript.ts?test=${crypto.randomUUID()}`);
const {
  isOpencodeSessionId,
  readOpencodeTranscript,
  hasOpencodeTranscript,
  getOpencodeTranscriptPath,
  existingOpencodeTranscriptPath,
  appendOpencodeTranscript,
  ensureOpencodeTranscriptFile,
  transcriptLineUser,
  transcriptLineAssistantText,
  transcriptLineToolUse,
  transcriptLineToolResult,
  transcriptLineForEntry,
} = mod;
const { parseTranscript } = await import("./jsonl-parser");

const SES = "ses_testabc123";

function seedDb() {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text, title text, time_created integer, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
    CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
  `);
  db.query("INSERT INTO session VALUES (?, 'p', 't', 1, 1)").run(SES);
  const t0 = 1783500000000;
  const ins = db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  ins.run("msg_1", SES, t0, t0, JSON.stringify({ role: "user", time: { created: t0 } }));
  ins.run("msg_2", SES, t0 + 1000, t0 + 1000, JSON.stringify({ role: "assistant", time: { created: t0 + 1000 } }));
  const insP = db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  insP.run(
    "prt_u1", "msg_1", SES, t0, t0,
    JSON.stringify({
      type: "text",
      text: "<backstage:context>\nplumbing\n</backstage:context>\n\nRemember the codeword: PELICAN.",
    })
  );
  insP.run("prt_syn", "msg_2", SES, t0 + 500, t0 + 500,
    JSON.stringify({ type: "text", text: "injected", synthetic: true }));
  insP.run("prt_tool", "msg_2", SES, t0 + 800, t0 + 800,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
    }));
  insP.run("prt_a1", "msg_2", SES, t0 + 1000, t0 + 1000,
    JSON.stringify({ type: "text", text: "OK, noted." }));
  db.close();
}

beforeAll(seedDb);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("isOpencodeSessionId", () => {
  test("recognizes ses_ ids only", () => {
    expect(isOpencodeSessionId("ses_0bc487ca3ffe")).toBe(true);
    expect(isOpencodeSessionId("b1e2c3d4-0000-7000-8000-000000000000")).toBe(false);
    expect(isOpencodeSessionId(null)).toBe(false);
    expect(isOpencodeSessionId("")).toBe(false);
  });
});

describe("readOpencodeTranscript (SQLite)", () => {
  test("maps messages/parts to entries, strips context fences and synthetic parts", () => {
    const entries = readOpencodeTranscript(SES);
    expect(entries.map((e: TranscriptEntry) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(entries[0].content).toBe("Remember the codeword: PELICAN.");
    expect(entries[1].toolName).toBe("bash");
    expect(entries[2].content).toBe("file.txt");
    expect(entries[2].toolUseId).toBe("prt_tool");
    expect(entries[3].content).toBe("OK, noted.");
  });
  test("unknown session / missing db degrade to []", () => {
    expect(readOpencodeTranscript("ses_nope")).toEqual([]);
    expect(readOpencodeTranscript(SES, join(scratch, "missing.db"))).toEqual([]);
    expect(hasOpencodeTranscript(SES)).toBe(true);
    expect(hasOpencodeTranscript("ses_nope")).toBe(false);
  });
});

describe("persisted transcript file", () => {
  test("appended claude-shape lines round-trip through parseTranscript", () => {
    const id = "ses_roundtrip";
    appendOpencodeTranscript(id, [
      transcriptLineUser("hello there", "u1", "2026-07-08T00:00:00.000Z"),
      transcriptLineToolUse("tu1", "bash", { command: "ls" }, "2026-07-08T00:00:01.000Z"),
      transcriptLineToolResult("tu1", "file.txt", false, "2026-07-08T00:00:02.000Z"),
      transcriptLineAssistantText("done!", "a1", "2026-07-08T00:00:03.000Z"),
    ]);
    const path = getOpencodeTranscriptPath(id);
    expect(existingOpencodeTranscriptPath(id)).toBe(path);
    const entries = parseTranscript(path);
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(entries[0]).toMatchObject({ id: "u1", content: "hello there" });
    expect(entries[1]).toMatchObject({ toolName: "bash", toolUseId: "tu1" });
    expect(entries[2]).toMatchObject({ id: "tr-tu1", content: "file.txt" });
    expect(entries[3]).toMatchObject({ id: "a1", content: "done!" });
  });

  test("ensureOpencodeTranscriptFile seeds a fresh file with handoff entries, preserving ids", () => {
    const id = "ses_seeded";
    const seed: TranscriptEntry[] = [
      { id: "orig-1", type: "user", content: "old turn", timestamp: "2026-07-07T00:00:00.000Z" },
      { id: "orig-2", type: "assistant", content: "old reply", timestamp: "2026-07-07T00:00:01.000Z" },
    ];
    ensureOpencodeTranscriptFile(id, seed);
    const entries = parseTranscript(getOpencodeTranscriptPath(id));
    expect(entries.map((e) => e.id)).toEqual(["orig-1", "orig-2"]);
    // Second ensure is a no-op (file exists).
    ensureOpencodeTranscriptFile(id, [
      { id: "other", type: "user", content: "x", timestamp: "2026-07-07T00:00:02.000Z" },
    ]);
    expect(parseTranscript(getOpencodeTranscriptPath(id))).toHaveLength(2);
  });

  test("ensureOpencodeTranscriptFile backfills legacy sessions from SQLite", () => {
    ensureOpencodeTranscriptFile(SES);
    const path = getOpencodeTranscriptPath(SES);
    expect(existsSync(path)).toBe(true);
    const entries = parseTranscript(path);
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    expect(entries[0].content).toBe("Remember the codeword: PELICAN.");
    expect(readFileSync(path, "utf-8")).toContain("PELICAN");
  });

  test("transcriptLineForEntry skips system entries and tool_results without ids", () => {
    expect(
      transcriptLineForEntry({ id: "s", type: "system", content: "x", timestamp: "" })
    ).toBeNull();
    expect(
      transcriptLineForEntry({ id: "t", type: "tool_result", content: "x", timestamp: "" })
    ).toBeNull();
  });
});
