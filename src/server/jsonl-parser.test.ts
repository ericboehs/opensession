import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractBackstageVideos,
  parseTranscript,
  parseTranscriptFrom,
  parseTranscriptTail,
} from "./jsonl-parser";

let dir: string;
let fileCounter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jsonl-parser-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a transcript fixture to a unique temp file (unique paths also keep
 *  the module's mtime/size parse cache from ever colliding between tests). */
function writeFixture(lines: string[]): string {
  const path = join(dir, `transcript-${++fileCounter}.jsonl`);
  writeFileSync(path, lines.map((l) => l + "\n").join(""));
  return path;
}

function writeCodexFixture(lines: string[]): string {
  const path = join(dir, `rollout-${++fileCounter}-thread.jsonl`);
  writeFileSync(path, lines.map((l) => l + "\n").join(""));
  return path;
}

const TS = "2026-07-01T10:00:00.000Z";

function userLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: TS,
    message: { role: "user", content: text },
  });
}

function assistantLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: TS,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function toolUseLine(uuid: string, toolUseId: string, command: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: TS,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
    },
  });
}

function toolResultLine(uuid: string, toolUseId: string, output: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: TS,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: output }],
    },
  });
}

const BASIC_LINES = [
  userLine("u1", "Please list the files"),
  toolUseLine("a1", "toolu_001", "ls -la"),
  toolResultLine("u2", "toolu_001", "file-a.txt\nfile-b.txt"),
  assistantLine("a2", "There are two files."),
];

describe("parseTranscript", () => {
  it("parses basic user/assistant turns in order", () => {
    const path = writeFixture([
      userLine("u1", "Hello there"),
      assistantLine("a1", "Hi! How can I help?"),
    ]);
    const entries = parseTranscript(path);
    expect(entries.length).toBe(2);
    expect(entries[0].type).toBe("user");
    expect(entries[0].content).toBe("Hello there");
    expect(entries[1].type).toBe("assistant");
    expect(entries[1].content).toBe("Hi! How can I help?");
  });

  it("pairs tool_use with its tool_result via toolUseId", () => {
    const path = writeFixture(BASIC_LINES);
    const entries = parseTranscript(path);
    expect(entries.map((e) => e.type)).toEqual([
      "user",
      "tool_use",
      "tool_result",
      "assistant",
    ]);
    const use = entries[1];
    const result = entries[2];
    expect(use.toolName).toBe("Bash");
    expect(use.toolUseId).toBe("toolu_001");
    expect(result.toolUseId).toBe(use.toolUseId);
    expect(result.content).toContain("file-a.txt");
  });

  it("skips a corrupt/truncated line mid-file without throwing and parses the rest", () => {
    const path = writeFixture([
      userLine("u1", "first"),
      '{"type":"assistant","message":{"content"', // truncated JSON
      "not json at all",
      assistantLine("a1", "last"),
    ]);
    const entries = parseTranscript(path);
    expect(entries.length).toBe(2);
    expect(entries[0].content).toBe("first");
    expect(entries[1].content).toBe("last");
  });

  it("ignores non-message line types", () => {
    const path = writeFixture([
      JSON.stringify({ type: "summary", summary: "a summary line" }),
      userLine("u1", "hello"),
      JSON.stringify({ type: "system", content: "system noise" }),
    ]);
    const entries = parseTranscript(path);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("user");
  });

  it("drops harness-injected system-reminder user lines", () => {
    const path = writeFixture([
      userLine("u1", "<system-reminder>internal note</system-reminder>"),
      userLine("u2", "real question"),
    ]);
    const entries = parseTranscript(path);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe("real question");
  });

  it("returns [] for an empty file", () => {
    const path = writeFixture([]);
    expect(parseTranscript(path)).toEqual([]);
  });

  it("returns [] for a missing file", () => {
    expect(parseTranscript(join(dir, "does-not-exist.jsonl"))).toEqual([]);
  });
});

describe("parseTranscriptTail", () => {
  it("returns the whole transcript untruncated when it fits the window", () => {
    const path = writeFixture(BASIC_LINES);
    const { entries, truncated } = parseTranscriptTail(path);
    expect(truncated).toBe(false);
    expect(entries).toEqual(parseTranscript(path));
  });

  it("returns a suffix of the full parse when the file exceeds the window", () => {
    // Many turns with chunky content so a small byte window can't hold them all.
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(userLine(`u${i}`, `question ${i} ` + "x".repeat(400)));
      lines.push(assistantLine(`a${i}`, `answer ${i} ` + "y".repeat(400)));
    }
    const path = writeFixture(lines);
    const full = parseTranscript(path);
    const { entries, truncated } = parseTranscriptTail(path, 1024, 5);
    expect(truncated).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.length).toBeLessThan(full.length);
    // Invariant: tail entries are exactly the trailing slice of a full parse.
    expect(entries).toEqual(full.slice(full.length - entries.length));
  });

  it("handles an empty file", () => {
    const path = writeFixture([]);
    const res = parseTranscriptTail(path);
    expect(res.entries).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("handles a missing file", () => {
    const res = parseTranscriptTail(join(dir, "nope.jsonl"));
    expect(res.entries).toEqual([]);
    expect(res.truncated).toBe(false);
  });
});

describe("parseTranscriptFrom", () => {
  it("returns everything from offset 0 with newOffset = file size", () => {
    const path = writeFixture(BASIC_LINES);
    const { entries, newOffset } = parseTranscriptFrom(path, 0);
    const full = parseTranscript(path);
    expect(entries.map((e) => e.id)).toEqual(full.map((e) => e.id));
    expect(newOffset).toBe(Bun.file(path).size);
  });

  it("returns only entries after a line-boundary byte offset (suffix of full parse)", () => {
    const path = writeFixture(BASIC_LINES);
    // Offset = end of the first two lines (each line is terminated by "\n").
    const offset =
      Buffer.byteLength(BASIC_LINES[0], "utf-8") +
      Buffer.byteLength(BASIC_LINES[1], "utf-8") +
      2;
    const { entries, newOffset } = parseTranscriptFrom(path, offset);
    const full = parseTranscript(path);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => `${e.type}:${e.content}`)).toEqual(
      full.slice(full.length - entries.length).map((e) => `${e.type}:${e.content}`)
    );
    // The first two lines' entries (user + tool_use) must NOT be present.
    expect(entries.some((e) => e.type === "tool_use")).toBe(false);
    expect(entries[0].type).toBe("tool_result");
    expect(newOffset).toBe(Bun.file(path).size);
  });

  it("supports incremental consumption: resume from newOffset after append", () => {
    const path = writeFixture([BASIC_LINES[0], BASIC_LINES[1]]);
    const first = parseTranscriptFrom(path, 0);
    expect(first.entries.length).toBe(2);
    // Append two more lines, resume from the returned offset.
    const appended = [BASIC_LINES[2], BASIC_LINES[3]];
    writeFileSync(path, appended.map((l) => l + "\n").join(""), { flag: "a" });
    const second = parseTranscriptFrom(path, first.newOffset);
    expect(second.entries.map((e) => e.type)).toEqual(["tool_result", "assistant"]);
    expect(second.newOffset).toBe(Bun.file(path).size);
  });

  it("returns no entries when the offset is at or past the end of file", () => {
    const path = writeFixture(BASIC_LINES);
    const size = Bun.file(path).size;
    const atEnd = parseTranscriptFrom(path, size);
    expect(atEnd.entries).toEqual([]);
    expect(atEnd.newOffset).toBe(size);
    const pastEnd = parseTranscriptFrom(path, size + 100);
    expect(pastEnd.entries).toEqual([]);
    expect(pastEnd.newOffset).toBe(size + 100);
  });

  it("handles an empty file", () => {
    const path = writeFixture([]);
    const res = parseTranscriptFrom(path, 0);
    expect(res.entries).toEqual([]);
    expect(res.newOffset).toBe(0);
  });

  it("handles a missing file (offset preserved)", () => {
    const res = parseTranscriptFrom(join(dir, "gone.jsonl"), 42);
    expect(res.entries).toEqual([]);
    expect(res.newOffset).toBe(42);
  });

  it("degrades gracefully when the offset lands mid-line", () => {
    const path = writeFixture(BASIC_LINES);
    // Point into the middle of the second line: the partial line can't parse
    // as JSON, but every complete later line must still come through.
    const offset = Buffer.byteLength(BASIC_LINES[0], "utf-8") + 1 + 10;
    const { entries } = parseTranscriptFrom(path, offset);
    const tail = entries.slice(-2).map((e) => e.type);
    expect(tail).toEqual(["tool_result", "assistant"]);
  });
});

describe("Codex rollout parsing", () => {
  it("extracts videos from Codex shell tool output markers", () => {
    const path = writeCodexFixture([
      JSON.stringify({
        timestamp: TS,
        type: "response_item",
        payload: {
          type: "local_shell_call_output",
          call_id: "call_shell_1",
          output: "recorded\nBACKSTAGE_VIDEO: /tmp/backstage-demo.mp4\n",
        },
      }),
    ]);

    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("tool_result");
    expect(entries[0].toolUseId).toBe("call_shell_1");
    expect(entries[0].videos).toEqual([
      "/backstage/media?path=%2Ftmp%2Fbackstage-demo.mp4",
    ]);
  });

  it("extracts videos from Codex MCP tool output markers", () => {
    const path = writeCodexFixture([
      JSON.stringify({
        timestamp: TS,
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_mcp_1",
          output: { output: "ok\nBACKSTAGE_VIDEO: /var/tmp/mcp-recording.webm\n" },
        },
      }),
    ]);

    const entries = parseTranscript(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("tool_result");
    expect(entries[0].toolUseId).toBe("call_mcp_1");
    expect(entries[0].videos).toEqual([
      "/backstage/media?path=%2Fvar%2Ftmp%2Fmcp-recording.webm",
    ]);
  });
});

describe("extractBackstageVideos", () => {
  it("returns media URLs for absolute BACKSTAGE_VIDEO markers", () => {
    expect(
      extractBackstageVideos("before\nBACKSTAGE_VIDEO: /tmp/capture-one.mp4\nBACKSTAGE_VIDEO: /tmp/second.webm")
    ).toEqual([
      "/backstage/media?path=%2Ftmp%2Fcapture-one.mp4",
      "/backstage/media?path=%2Ftmp%2Fsecond.webm",
    ]);
  });
});
