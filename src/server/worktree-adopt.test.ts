import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";

/**
 * createWorktree branch-collision tolerance: a create attempt killed
 * mid-flight (restart drain) can leave the BRANCH created with no worktree;
 * the retry used to die on `fatal: a branch named '…' already exists`
 * (Michiel's bks-019f467a, 2026-07-09). An orphan branch with zero unique
 * commits and no registered worktree is adopted; a branch with real commits
 * still fails loudly.
 *
 * Runs against a scratch repo via the BACKSTAGE_CONFIG / BACKSTAGE_WORKTREES_DIR
 * seams (config loader caches by path+mtime, env read per call).
 */

const ENV_KEYS = ["BACKSTAGE_CONFIG", "BACKSTAGE_WORKTREES_DIR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

let root: string;
let repoDir: string;
let originDir: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await $`git -C ${cwd} ${args}`.quiet();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bks-wt-adopt-"));
  originDir = join(root, "origin.git");
  repoDir = join(root, "repo");
  await $`git init --bare -b main ${originDir}`.quiet();
  await $`git init -b main ${repoDir}`.quiet();
  await git(repoDir, "config", "user.email", "test@test");
  await git(repoDir, "config", "user.name", "test");
  writeFileSync(join(repoDir, "a.txt"), "hello\n");
  await git(repoDir, "add", "a.txt");
  await git(repoDir, "commit", "-m", "init");
  await git(repoDir, "remote", "add", "origin", originDir);
  await git(repoDir, "push", "-u", "origin", "main");

  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        scratch: {
          repo: repoDir,
          wtPrefix: "scratch",
          defaultBranch: "main",
          ghRepo: "test/scratch",
        },
      },
    }),
  );
  process.env.BACKSTAGE_CONFIG = join(root, "config.json");
  process.env.BACKSTAGE_WORKTREES_DIR = join(root, "worktrees");
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("createWorktree branch-collision adoption", () => {
  test("adopts an orphan branch with zero unique commits", async () => {
    const { createWorktree } = await import("./worktree");
    // Simulate the killed first attempt: branch exists at origin/main, no worktree.
    await git(repoDir, "branch", "orphan-branch", "origin/main");

    const wtPath = await createWorktree("orphan-branch", "scratch");
    expect(existsSync(join(wtPath, ".git"))).toBe(true);
    const head = (await $`git -C ${wtPath} branch --show-current`.text()).trim();
    expect(head).toBe("orphan-branch");
  });

  test("still fails loudly when the branch has unique commits", async () => {
    const { createWorktree } = await import("./worktree");
    // A branch with real work on it (one commit past origin/main), no worktree.
    await git(repoDir, "branch", "has-work", "origin/main");
    await git(repoDir, "checkout", "has-work");
    writeFileSync(join(repoDir, "b.txt"), "work\n");
    await git(repoDir, "add", "b.txt");
    await git(repoDir, "commit", "-m", "real work");
    await git(repoDir, "checkout", "main");

    await expect(createWorktree("has-work", "scratch")).rejects.toThrow(
      /already exists/,
    );
    expect(existsSync(join(root, "worktrees", "scratch-has-work"))).toBe(false);
  });

  test("plain create still works (no collision)", async () => {
    const { createWorktree } = await import("./worktree");
    const wtPath = await createWorktree("fresh-branch", "scratch");
    const head = (await $`git -C ${wtPath} branch --show-current`.text()).trim();
    expect(head).toBe("fresh-branch");
  });
});

describe("resolveUniqueBranch", () => {
  test("passes through a name with no ref collision", async () => {
    const { resolveUniqueBranch } = await import("./worktree");
    expect(await resolveUniqueBranch("brand-new-name", "scratch")).toBe(
      "brand-new-name",
    );
  });

  test("bumps when the name is a directory of an existing ref", async () => {
    const { resolveUniqueBranch } = await import("./worktree");
    // `git worktree add -b test` can't create refs/heads/test while
    // refs/heads/test/foo exists (the reported failure). Expect a -2 bump.
    await git(repoDir, "branch", "test/foo", "origin/main");
    expect(await resolveUniqueBranch("test", "scratch")).toBe("test-2");
  });

  test("bumps on an exact-name collision, skipping taken suffixes", async () => {
    const { resolveUniqueBranch } = await import("./worktree");
    await git(repoDir, "branch", "dup", "origin/main");
    await git(repoDir, "branch", "dup-2", "origin/main");
    expect(await resolveUniqueBranch("dup", "scratch")).toBe("dup-3");
  });

});
