import { describe, expect, test } from "bun:test";
import { workspaceExecFor } from "./workspace-exec";

describe("workspaceExecFor", () => {
  test("fails closed for a volume workspace before sandbox materialization", async () => {
    const exec = await workspaceExecFor({
      worktreeDir: "/remote/workspace",
      sandbox: { provider: "macos", workspace: "volume" },
    });

    expect(exec.sandboxed).toBe(true);
    expect(exec.remote).toBe(true);
    expect(await exec(["pwd"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "remote sandbox macos is unavailable",
    });
  });
});
