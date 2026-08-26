import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TranscriptStore } from "./transcript-store";
import { transcriptEntryMatchSnippet } from "./transcript-search";
import { searchStoredTranscripts } from "./transcript-search-worker";
import { sessionKernelSessionDbPath } from "./session-kernel/store";
import type { TranscriptEntry } from "./types";

describe("transcript search", () => {
  let root = "";
  const stores: TranscriptStore[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "transcript-search-"));
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function entry(
    id: string,
    content: string,
    extra: Partial<TranscriptEntry> = {},
  ): TranscriptEntry {
    return {
      id,
      type: "assistant",
      content,
      ...extra,
      timestamp: extra.timestamp ?? "2026-08-20T10:00:00Z",
    };
  }

  function append(sessionId: string, entries: TranscriptEntry[]): void {
    const store = new TranscriptStore(sessionKernelSessionDbPath(sessionId, root));
    stores.push(store);
    store.appendTranscriptEvents(sessionId, entries);
  }

  test("matches visible text in requested session order from read-only actor files", () => {
    append("newer", [entry("tool", "Ran a command", {
      type: "tool_use",
      toolInput: { command: "echo NEEDLE" },
    })]);
    append("older", [entry("answer", "The needle is here")]);
    append("metadata", [entry("needle-only-id", "Nothing visible")]);

    const result = searchStoredTranscripts({
      isolatedRoot: root,
      query: "needle",
      sessionIds: ["newer", "older", "metadata"],
    });
    expect(result.matches.map((match) => match.id)).toEqual(["newer", "older"]);
    expect(result.matches[0]!.snippet).toContain("NEEDLE");
    expect(result.searchedSessions).toBe(3);
  });

  test("enforces total session and candidate-row budgets", () => {
    for (const id of ["one", "two", "three"])
      append(id, Array.from({ length: 4 }, (_, i) => entry(`${id}-${i}`, "shared phrase")));
    expect(searchStoredTranscripts({
      isolatedRoot: root,
      query: "shared phrase",
      sessionIds: ["one", "two", "three"],
      maxMatches: 10,
      maxSessions: 2,
    })).toMatchObject({
      searchedSessions: 2,
      exhausted: "sessions",
    });
    expect(searchStoredTranscripts({
      isolatedRoot: root,
      query: "shared phrase",
      sessionIds: ["one", "two", "three"],
      maxMatches: 10,
      maxRows: 1,
    })).toMatchObject({
      candidateRows: 1,
      exhausted: "rows",
    });
  });

  test("enforces a wall-clock budget", () => {
    append("one", [entry("a", "needle")]);
    let tick = 0;
    const result = searchStoredTranscripts({
      isolatedRoot: root,
      query: "needle",
      sessionIds: ["one", "two"],
      maxMs: 1,
    }, () => tick++);
    expect(result).toMatchObject({ searchedSessions: 0, exhausted: "time" });
  });

  test("global route dispatches a worker instead of scanning actor mailboxes", () => {
    const route = readFileSync(join(import.meta.dir, "routes/sessions.ts"), "utf8");
    const search = route.slice(
      route.indexOf("async function searchStoredTranscripts"),
      route.indexOf("async function ripgrepFiles"),
    );
    expect(search).toContain("transcriptSearchWorkerArgv");
    expect(search).not.toContain("transcript.search");
    expect(search).toContain("signal?.addEventListener");
  });

  test("builds one-line context around a match", () => {
    expect(
      transcriptEntryMatchSnippet(
        entry("a", `before ${"x".repeat(80)}\nNeedle\tafter`),
        "needle",
        12,
      ),
    ).toMatch(/^….*Needle after$/);
  });
});
