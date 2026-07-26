// gh-guard shim policy tests. Spawns the shims with GH_GUARD_TEST=1 (print
// ALLOW/BLOCK instead of exec'ing) — no server modules imported on purpose
// (importing run-rpc from tests rebinds the live socket).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const GUARD_DIR = join(import.meta.dir, "gh-guard");

async function decide(
  bin: "gh" | "git",
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<{ allowed: boolean; out: string }> {
  const proc = Bun.spawn({
    cmd: [join(GUARD_DIR, bin), ...args],
    cwd: opts?.cwd ?? tmpdir(),
    env: {
      PATH: `${GUARD_DIR}:${process.env.PATH}`,
      HOME: process.env.HOME!,
      GH_GUARD_TEST: "1",
      ...(opts?.env || {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return { allowed: out === "ALLOW", out };
}

// A scratch clone whose origin points at a third-party repo.
function foreignRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-guard-test-"));
  Bun.spawnSync({ cmd: ["git", "init", "-q", dir] });
  Bun.spawnSync({
    cmd: ["git", "-C", dir, "remote", "add", "origin", "git@github.com:someone-else/thing.git"],
  });
  Bun.spawnSync({
    cmd: ["git", "-C", dir, "remote", "add", "tella", "https://github.com/tellahq/backstage.git"],
  });
  return dir;
}

describe("gh shim", () => {
  test("blocks issue/pr/comment writes on third-party repos", async () => {
    for (const args of [
      ["issue", "create", "--repo", "vercel-labs/deepsec", "--title", "x"],
      ["issue", "comment", "114", "--repo", "vercel-labs/deepsec", "--body", "hi"],
      ["pr", "create", "--repo", "TomGranot/tella-to-youtube", "--title", "x"],
      ["pr", "review", "1", "--repo", "someone/thing", "--approve"],
      ["release", "create", "v1", "--repo", "someone/thing"],
    ]) {
      expect((await decide("gh", args)).allowed).toBe(false);
    }
  });

  test("always blocks forks and gist/public-repo creation", async () => {
    expect((await decide("gh", ["repo", "fork", "tellahq/backstage"])).allowed).toBe(false);
    expect((await decide("gh", ["gist", "create", "f.txt"])).allowed).toBe(false);
    expect((await decide("gh", ["repo", "create", "x", "--public"])).allowed).toBe(false);
    expect((await decide("gh", ["repo", "create", "x", "--private"])).allowed).toBe(true);
  });

  test("allows writes on tellahq repos (flag and =-form)", async () => {
    expect(
      (await decide("gh", ["issue", "create", "-R", "tellahq/backstage", "--title", "x"])).allowed
    ).toBe(true);
    expect(
      (await decide("gh", ["pr", "create", "--repo=tellahq/tella-fusion", "--title", "x"])).allowed
    ).toBe(true);
  });

  test("resolves repo from origin; fails closed without one", async () => {
    const dir = foreignRepo();
    expect((await decide("gh", ["pr", "create", "--title", "x"], { cwd: dir })).allowed).toBe(false);
    // main checkout's origin is tellahq/backstage
    expect(
      (await decide("gh", ["pr", "create", "--title", "x"], { cwd: join(import.meta.dir, "../..") }))
        .allowed
    ).toBe(true);
    // no git repo at all → unresolvable → blocked
    expect((await decide("gh", ["issue", "create", "--title", "x"])).allowed).toBe(false);
  });

  test("reads pass through", async () => {
    for (const args of [
      ["issue", "list", "--repo", "vercel-labs/deepsec"],
      ["pr", "view", "1", "--repo", "someone/thing"],
      ["search", "prs", "--author", "x"],
      ["api", "repos/vercel-labs/deepsec/issues/114"],
      ["auth", "status"],
    ]) {
      expect((await decide("gh", args)).allowed).toBe(true);
    }
  });

  test("gh api mutations gated by path owner", async () => {
    expect(
      (await decide("gh", ["api", "-X", "POST", "repos/tellahq/backstage/dispatches", "-f", "e=x"]))
        .allowed
    ).toBe(true);
    expect(
      (await decide("gh", ["api", "repos/vercel-labs/deepsec/issues", "-f", "title=x"])).allowed
    ).toBe(false);
    expect((await decide("gh", ["api", "-X", "DELETE", "repos/x/y"])).allowed).toBe(false);
    expect((await decide("gh", ["api", "user/repos", "-f", "name=x"])).allowed).toBe(false);
  });

  test("OPENSESSION_GH_ALLOWED_OWNERS extends the allowlist", async () => {
    const env = { OPENSESSION_GH_ALLOWED_OWNERS: "tellahq,acme" };
    expect(
      (await decide("gh", ["issue", "create", "-R", "acme/x", "--title", "t"], { env })).allowed
    ).toBe(true);
  });
});

describe("git shim", () => {
  test("blocks pushes to third-party remotes (name, URL, upstream default)", async () => {
    const dir = foreignRepo();
    expect((await decide("git", ["push", "origin", "main"], { cwd: dir })).allowed).toBe(false);
    expect((await decide("git", ["push"], { cwd: dir })).allowed).toBe(false);
    expect(
      (await decide("git", ["push", "git@github.com:vercel-labs/deepsec.git", "main"])).allowed
    ).toBe(false);
    expect((await decide("git", ["-C", dir, "push", "origin", "main"])).allowed).toBe(false);
    expect(
      (await decide("git", ["push", "--force-with-lease", "origin", "main"], { cwd: dir })).allowed
    ).toBe(false);
  });

  test("allows pushes to tellahq remotes and non-push subcommands", async () => {
    const dir = foreignRepo();
    expect((await decide("git", ["push", "tella", "main"], { cwd: dir })).allowed).toBe(true);
    expect(
      (await decide("git", ["push", "https://github.com/tellahq/tella-fusion.git", "x"])).allowed
    ).toBe(true);
    expect((await decide("git", ["status"], { cwd: dir })).allowed).toBe(true);
    expect((await decide("git", ["commit", "-m", "x"], { cwd: dir })).allowed).toBe(true);
  });
});
