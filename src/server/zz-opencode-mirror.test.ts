/**
 * withOpencodeTranscriptMirror (sandbox/adapters/bootstrap.ts) — the
 * host-side transcript writer for REMOTE opencode runs. The in-sandbox
 * writer path is covered by opencode-transcript.test.ts; this covers the
 * mirror specifically, including the bks-019f46d2 regression: the turn's
 * user entry must come from the SPEC at dispatch/init time (with full text)
 * and must land in the file of EVERY engine session the turn touches (an
 * account rotation mid-turn starts a fresh one), without duplicates.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withOpencodeTranscriptMirror } from "./sandbox/adapters/bootstrap";
import {
  getOpencodeTranscriptPath,
  __setOpencodeTranscriptsDirForTest,
} from "./opencode-transcript";
import { parseTranscript } from "./jsonl-parser";
import { RESUME_CONTINUATION_PROMPT } from "./agent-runner";
import type { StreamEvent } from "./run-events";
import type { RunHostSpec } from "../runner-host/protocol";

// __setOpencodeTranscriptsDirForTest repoints the LIVE OPENCODE_TRANSCRIPTS_DIR
// binding, so bootstrap.ts's own (already-cached, possibly earlier-imported-
// with-the-real-value) bare import of ./opencode-transcript picks the scratch
// dir up too — unlike a plain env-var-before-import, which only affects
// whichever test file happens to trigger the FIRST bare import of
// ./opencode-transcript in the whole `bun test` process (order-dependent,
// and this file previously read/wrote the developer's real transcript
// mirror dir when run as part of the full suite).
const scratch = mkdtempSync(join(tmpdir(), "bks-oc-mirror-"));
const priorTranscriptsDir = __setOpencodeTranscriptsDirForTest(scratch);

afterAll(() => {
  __setOpencodeTranscriptsDirForTest(priorTranscriptsDir);
  rmSync(scratch, { recursive: true, force: true });
});

function spec(overrides: Partial<RunHostSpec>): RunHostSpec {
  return {
    hostId: `rh-test-${Math.random().toString(36).slice(2, 10)}`,
    bksSessionId: "bks-mirror-test",
    prompt: "hello",
    cwd: "/tmp",
    mode: "code",
    model: "opencode/anthropic/claude-haiku-4-5",
    ...overrides,
  } as RunHostSpec;
}

async function* stream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const ev of events) yield ev;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const entriesOf = (oc: string) => parseTranscript(getOpencodeTranscriptPath(oc));

describe("withOpencodeTranscriptMirror", () => {
  test("two turns: both user prompts present with full text, in order, no dupes", async () => {
    const oc = "ses_mirror_two_turns";
    // Turn 1: fresh session — engine id arrives via init.
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: oc } as StreamEvent,
          { type: "text_chunk", text: "first answer" } as StreamEvent,
          { type: "done", sessionId: oc, result: "first answer" } as StreamEvent,
        ]),
        spec({ prompt: "first question" }),
      ),
    );
    // Turn 2: resumed session — engine id known at dispatch; the user entry
    // must exist BEFORE any event arrives (the "Sending…" bubble reconciles
    // on it while the remote engine still boots).
    const turn2 = withOpencodeTranscriptMirror(
      stream([
        { type: "init", sessionId: oc } as StreamEvent,
        { type: "text_chunk", text: "second answer" } as StreamEvent,
      ]),
      spec({ prompt: "second question", engineSessionId: oc }),
    );
    // Pull nothing yet — the generator body runs on first next(); one tick in.
    const first = await turn2.next();
    const midTurn = entriesOf(oc).filter((e) => e.type === "user");
    expect(midTurn.map((e) => e.content)).toContain("second question");
    while (!(await turn2.next()).done) {}
    void first;

    const entries = entriesOf(oc);
    const texts = entries.map((e) => [e.type, e.content]);
    expect(texts).toEqual([
      ["user", "first question"],
      ["assistant", "first answer"],
      ["user", "second question"],
      ["assistant", "second answer"],
    ]);
  });

  test("account rotation: the prompt lands in BOTH engine sessions' files", async () => {
    const s = spec({ prompt: "rotate me" });
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: "ses_rot_a" } as StreamEvent,
          { type: "text_chunk", text: "[runner] usage limit; switching" } as StreamEvent,
          { type: "init", sessionId: "ses_rot_b" } as StreamEvent,
          { type: "text_chunk", text: "answer after rotation" } as StreamEvent,
        ]),
        s,
      ),
    );
    const a = entriesOf("ses_rot_a");
    const b = entriesOf("ses_rot_b");
    expect(a.filter((e) => e.type === "user").map((e) => e.content)).toEqual(["rotate me"]);
    // The file the session ends up pointing at MUST open with the user turn.
    expect(b[0]?.type).toBe("user");
    expect(b[0]?.content).toBe("rotate me");
    expect(b.filter((e) => e.type === "user")).toHaveLength(1);
  });

  test("runner_notice events persist as system entries after the rotation", async () => {
    const s = spec({ prompt: "notice me" });
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: "ses_notice_a" } as StreamEvent,
          { type: "runner_notice", text: "usage limit; switching accounts" } as StreamEvent,
          { type: "init", sessionId: "ses_notice_b" } as StreamEvent,
          { type: "text_chunk", text: "answer after rotation" } as StreamEvent,
        ]),
        s,
      ),
    );
    // The notice fired between the two inits, so it lands in the FIRST file;
    // what matters is it parses back as a system chip, not a user bubble.
    const a = entriesOf("ses_notice_a");
    expect(a.map((e) => [e.type, e.content])).toEqual([
      ["user", "notice me"],
      ["system", "usage limit; switching accounts"],
    ]);
    const b = entriesOf("ses_notice_b");
    expect(b.map((e) => [e.type, e.content])).toEqual([
      ["user", "notice me"],
      ["assistant", "answer after rotation"],
    ]);
  });

  test("synthetic resume-continuation prompt is not a user entry", async () => {
    const oc = "ses_mirror_resume";
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: oc } as StreamEvent,
          { type: "text_chunk", text: "resumed output" } as StreamEvent,
        ]),
        spec({ prompt: RESUME_CONTINUATION_PROMPT, engineSessionId: oc, journalKind: "prompt-resume" }),
      ),
    );
    const entries = entriesOf(oc);
    expect(entries.filter((e) => e.type === "user")).toHaveLength(0);
    expect(entries.filter((e) => e.type === "assistant")).toHaveLength(1);
  });

  test("re-delivery with the same hostId upserts instead of duplicating", async () => {
    const oc = "ses_mirror_redeliver";
    const s = spec({ prompt: "once only", engineSessionId: oc });
    await drain(
      withOpencodeTranscriptMirror(
        stream([{ type: "init", sessionId: oc } as StreamEvent]),
        s,
      ),
    );
    // Reattach after a restart replays with the SAME spec/hostId.
    await drain(
      withOpencodeTranscriptMirror(
        stream([{ type: "init", sessionId: oc } as StreamEvent]),
        s,
      ),
    );
    const users = entriesOf(oc).filter((e) => e.type === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toBe("once only");
  });

  test("tool use/result mirror as tool entries (not empty user bubbles)", async () => {
    const oc = "ses_mirror_tools";
    await drain(
      withOpencodeTranscriptMirror(
        stream([
          { type: "init", sessionId: oc } as StreamEvent,
          { type: "tool_use", toolUseId: "prt_1", toolName: "bash", toolInput: { command: "ls" } } as StreamEvent,
          { type: "tool_result", toolUseId: "prt_1", content: "file.txt" } as StreamEvent,
        ]),
        spec({ prompt: "list files" }),
      ),
    );
    const entries = entriesOf(oc);
    expect(entries.map((e) => e.type)).toEqual(["user", "tool_use", "tool_result"]);
    // No plain-text user entry beyond the prompt (the empty-user-bubble bug).
    const userTexts = entries.filter((e) => e.type === "user").map((e) => e.content);
    expect(userTexts).toEqual(["list files"]);
  });

  test("non-opencode models pass through untouched", async () => {
    const events = [
      { type: "init", sessionId: "claude-native" } as StreamEvent,
      { type: "text_chunk", text: "hi" } as StreamEvent,
    ];
    const out = await drain(
      withOpencodeTranscriptMirror(stream(events), spec({ model: "claude-sonnet-5", prompt: "x" })),
    );
    expect(out).toHaveLength(2);
  });
});
