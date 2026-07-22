import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { configuredRepos } from "../config";
import { getRepo, repoForPath } from "../worktree";
import {
  githubRepoFromRemote,
  handleLocalReposRoutes,
  localCloneUrlAllowed,
  localRepoId,
  sessionDataReferencesRepo,
} from "./local-repos";
import type { RouteContext } from "./context";

const saved = {
  profile: process.env.OPENSESSION_PROFILE,
  config: process.env.OPENSESSION_CONFIG,
  home: process.env.HOME,
};
let root = "";

function restore(name: keyof typeof saved, env: string): void {
  const value = saved[name];
  if (value === undefined) delete process.env[env];
  else process.env[env] = value;
}

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function makeRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(["init", "-b", "trunk"], dir);
  writeFileSync(join(dir, "README.md"), "local repo\n");
  git(["add", "README.md"], dir);
  git(["-c", "user.name=Local Test", "-c", "user.email=local@example.com", "commit", "-m", "init"], dir);
  return dir;
}

function context(path: string, init?: RequestInit): RouteContext {
  const req = new Request(`http://127.0.0.1:3850${path}`, init);
  return {
    req,
    url: new URL(req.url),
    path,
    publicPrefix: "",
    authUser: null,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "os1-local-repos-"));
  process.env.OPENSESSION_PROFILE = "local";
  process.env.OPENSESSION_CONFIG = join(root, "os1", "config.json");
  process.env.HOME = root;
});

afterEach(() => {
  restore("profile", "OPENSESSION_PROFILE");
  restore("config", "OPENSESSION_CONFIG");
  restore("home", "HOME");
  rmSync(root, { recursive: true, force: true });
});

describe("local repo routes", () => {
  test("registers an existing repo and unregisters without deleting it", async () => {
    const repoPath = makeRepo("My Project");
    const registered = await handleLocalReposRoutes(
      context("/backstage/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repoPath }),
      }),
    );
    expect(registered?.status).toBe(201);
    expect(await registered?.json()).toMatchObject({
      id: "my-project",
      repo: repoPath,
      defaultBranch: "trunk",
      wtPrefix: "my-project",
      default: true,
      ghRepo: "",
    });
    expect(Object.keys(configuredRepos())).toEqual(["my-project"]);

    const removed = await handleLocalReposRoutes(
      context("/backstage/api/repos/my-project/remove", { method: "POST" }),
    );
    expect(removed?.status).toBe(200);
    expect(configuredRepos()).toEqual({});
    expect(existsSync(repoPath)).toBe(true);
  });

  test("clones URL repos under the local profile root", async () => {
    const source = makeRepo("source-repo");
    const registered = await handleLocalReposRoutes(
      context("/backstage/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `file://${source}` }),
      }),
    );
    expect(registered?.status).toBe(201);
    const body = await registered?.json();
    expect(body.repo).toBe(join(root, "os1", "repos", "source-repo"));
    expect(existsSync(join(body.repo, ".git"))).toBe(true);
  });

  test("promotes the next repo when the default is removed", async () => {
    for (const name of ["first", "second"]) {
      const response = await handleLocalReposRoutes(
        context("/backstage/api/repos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: makeRepo(name) }),
        }),
      );
      expect(response?.status).toBe(201);
    }
    expect(configuredRepos().first.default).toBe(true);
    expect(configuredRepos().second.default).toBeUndefined();

    const removed = await handleLocalReposRoutes(
      context("/backstage/api/repos/first/remove", { method: "POST" }),
    );
    expect(removed?.status).toBe(200);
    expect(configuredRepos().second.default).toBe(true);
  });

  test("is dormant outside the local profile", async () => {
    process.env.OPENSESSION_PROFILE = "cloud";
    expect(
      await handleLocalReposRoutes(
        context("/backstage/api/repos", { method: "POST", body: "{}" }),
      ),
    ).toBeUndefined();
  });

  test("never falls back to another repo for an unknown local id or path", () => {
    expect(() => getRepo("missing")).toThrow('Unknown repo "missing"');
    expect(() => repoForPath(join(root, "unregistered"))).toThrow(
      "No registered repo owns path",
    );
  });
});

test("repo ids and GitHub remotes are normalized", () => {
  expect(localRepoId("My App.git")).toBe("my-app");
  expect(githubRepoFromRemote("git@github.com:tellahq/os1-mac.git")).toBe(
    "tellahq/os1-mac",
  );
  expect(githubRepoFromRemote("https://example.com/acme/app.git")).toBeUndefined();
  expect(localCloneUrlAllowed("https://github.com/acme/app.git")).toBe(true);
  expect(localCloneUrlAllowed("git@github.com:acme/app.git")).toBe(true);
  expect(localCloneUrlAllowed("ext::sh -c 'touch /tmp/pwned'")).toBe(false);
  expect(localCloneUrlAllowed("http://169.254.169.254/repo.git")).toBe(false);
  expect(sessionDataReferencesRepo({ id: "bks-1", repo: "my-app" }, "my-app")).toBe(true);
  expect(
    sessionDataReferencesRepo(
      { id: "bks-1", attachedRepos: [{ repo: "other" }] },
      "other",
    ),
  ).toBe(true);
  expect(sessionDataReferencesRepo({ repo: "my-app" }, "my-app")).toBe(false);
});
