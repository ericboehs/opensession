import { describe, expect, test } from "bun:test";
import { startSessionTerminal } from "./terminals";

describe("session terminal sandbox routing", () => {
  for (const sandboxId of ["macos-bks-1", undefined]) test(`fails closed for macOS execution-node sessions ${sandboxId ? "after" : "before"} materialization`, async () => {
    const messages: object[] = [];
    await startSessionTerminal(
      {},
      {
        worktreeDir: "/Users/runner/.opensession-workspaces/bks-1/tella-mac",
        sandbox: { provider: "macos", sandboxId, workspace: "volume" },
      },
      { send: (message) => messages.push(message) },
    );

    expect(messages).toEqual([
      {
        type: "term_notice",
        message: "The Shell tab is unavailable for macOS execution-node sessions.",
      },
      { type: "term_exit", code: 1 },
    ]);
  });
});
