import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startWatching,
  stopAllWatchesForClient,
  transcriptRev,
} from "./file-watcher";

const dir = mkdtempSync(join(tmpdir(), "file-watcher-test-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function wsStub() {
  return {
    sent: [] as string[],
    send(msg: string) {
      this.sent.push(msg);
    },
  };
}

function userLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-07-01T10:00:00.000Z",
    message: { role: "user", content: text },
  });
}

describe("startWatching", () => {
  it("replays the requested backlog when joining an existing path watch", () => {
    const path = join(dir, "existing-watch.jsonl");
    writeFileSync(path, `${userLine("u-opening", "Opening prompt")}\n`);

    const first = wsStub();
    const second = wsStub();

    try {
      startWatching(path, first, Bun.file(path).size, "bks-test");
      startWatching(path, second, 0, "bks-test");

      expect(second.sent).toHaveLength(1);
      const msg = JSON.parse(second.sent[0]);
      expect(msg.type).toBe("transcript_append");
      expect(msg.sessionId).toBe("bks-test");
      expect(msg.entries.map((e: { content: string }) => e.content)).toEqual([
        "Opening prompt",
      ]);
      // The replay carries the reconnect-resume cursor: where it ends in the
      // file, and which file that was (echoed back as sinceOffset/sinceRev).
      expect(msg.endOffset).toBe(Bun.file(path).size);
      expect(msg.rev).toBe(transcriptRev(path));
    } finally {
      stopAllWatchesForClient(first);
      stopAllWatchesForClient(second);
    }
  });

  it("transcriptRev tells mirror files apart (engine-rotation safety)", () => {
    // An offset into the old engine session's mirror must never be applied to
    // the new one — the rev is what the watch handler compares.
    expect(transcriptRev("/x/ses_one.jsonl")).not.toBe(
      transcriptRev("/x/ses_two.jsonl"),
    );
    expect(transcriptRev("/x/ses_one.jsonl")).toBe(
      transcriptRev("/x/ses_one.jsonl"),
    );
  });
});
