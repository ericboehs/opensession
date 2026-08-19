import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPull, porcelainPaths } from "./git-status";

const roots: string[] = [];

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${dir} ${args}`.quiet().text()).trim();
}

async function makeRepo(): Promise<{ repo: string; origin: string }> {
  const root = mkdtempSync(join(tmpdir(), "opensession-git-status-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");

  await $`git init --bare -b main ${origin}`.quiet();
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "shared.txt"), "initial\n");
  await git(repo, "add", "shared.txt");
  await git(repo, "commit", "-m", "Initial commit");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "checkout", "-b", "feature");
  return { repo, origin };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gitPull from base", () => {
  test("merges base changes into a published feature branch without requiring force-push", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    await git(repo, "add", "feature.txt");
    await git(repo, "commit", "-m", "Feature change");
    await git(repo, "push", "-u", "origin", "feature");

    await git(repo, "checkout", "main");
    writeFileSync(join(repo, "base.txt"), "base\n");
    await git(repo, "add", "base.txt");
    await git(repo, "commit", "-m", "Base change");
    await git(repo, "push", "origin", "main");
    await git(repo, "checkout", "feature");

    expect(await gitPull(repo, "main")).toEqual({ ok: true });
    expect(await git(repo, "rev-list", "--count", "HEAD..origin/main")).toBe("0");
    expect(await git(repo, "status", "--porcelain")).toBe("");

    await git(repo, "push", "origin", "feature");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(
      await git(repo, "rev-parse", "origin/feature"),
    );
  });

  test("aborts a conflicting merge and restores the clean feature branch", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "shared.txt"), "feature\n");
    await git(repo, "add", "shared.txt");
    await git(repo, "commit", "-m", "Feature edit");
    await git(repo, "push", "-u", "origin", "feature");

    await git(repo, "checkout", "main");
    writeFileSync(join(repo, "shared.txt"), "base\n");
    await git(repo, "add", "shared.txt");
    await git(repo, "commit", "-m", "Base edit");
    await git(repo, "push", "origin", "main");
    await git(repo, "checkout", "feature");
    const before = await git(repo, "rev-parse", "HEAD");

    const result = await gitPull(repo, "main");
    expect(result).toHaveProperty("error");
    expect("error" in result ? result.error : "").toContain("conflicts with main");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  test("rejects a dirty worktree without changing it", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "shared.txt"), "uncommitted\n");
    const before = await git(repo, "rev-parse", "HEAD");

    expect(await gitPull(repo, "main")).toEqual({
      error: "Commit or discard the uncommitted changes before updating.",
    });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(await git(repo, "status", "--porcelain")).toContain("shared.txt");
  });
});

describe("porcelainPaths", () => {
  test("reads the path past both status columns, staged or not", () => {
    expect(porcelainPaths("M  src/a.ts\n?? src/b.ts\n M src/c.ts")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  test("takes a rename's new path — the old one is gone from disk", () => {
    expect(porcelainPaths("R  src/old.ts -> src/new.ts")).toEqual(["src/new.ts"]);
  });

  test("unquotes a path git had to escape", () => {
    expect(porcelainPaths('?? "src/a b\\u00e9.ts"')).toEqual(["src/a bé.ts"]);
  });

  test("ignores blank and truncated lines", () => {
    expect(porcelainPaths("\n\nM  src/a.ts\nM\n")).toEqual(["src/a.ts"]);
  });
});
