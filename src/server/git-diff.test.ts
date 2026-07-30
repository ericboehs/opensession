import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getSessionDiff } from "./git-diff";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("getSessionDiff", () => {
  test("coalesces concurrent reads of the same worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-git-diff-"));
    dirs.push(dir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenSession Test",
      GIT_AUTHOR_EMAIL: "test@opensession.local",
      GIT_COMMITTER_NAME: "OpenSession Test",
      GIT_COMMITTER_EMAIL: "test@opensession.local",
    };
    expect(Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir, env }).exitCode).toBe(0);
    writeFileSync(join(dir, "file.txt"), "before\n");
    expect(Bun.spawnSync(["git", "add", "file.txt"], { cwd: dir, env }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir, env }).exitCode).toBe(0);
    writeFileSync(join(dir, "file.txt"), "after\n");

    const first = getSessionDiff(dir);
    const second = getSessionDiff(dir);

    expect(second).toBe(first);
    expect((await first).rawPatch).toContain("+after");

    const next = getSessionDiff(dir);
    expect(next).not.toBe(first);
    await next;
  });
});
