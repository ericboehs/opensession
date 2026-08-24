import { $ } from "bun";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  adoptExistingCheckout,
  githubCredentialHelperCommand,
  handleSetupRepoRoutes,
  matchesCodeStorageCheckout,
  normalizeDefaultBranch,
  validGithubFullName,
} from "./setup-repos";

const originalConfig = process.env.OPENSESSION_CONFIG;
const tempDirs: string[] = [];

function createGitRepo(dir: string): string {
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]).exitCode).toBe(0);
  writeFileSync(join(repo, "README.md"), "test\n");
  expect(Bun.spawnSync(["git", "-C", repo, "add", "README.md"]).exitCode).toBe(0);
  expect(
    Bun.spawnSync([
      "git",
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "initial",
    ]).exitCode,
  ).toBe(0);
  expect(Bun.spawnSync(["git", "-C", repo, "branch", "master"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "init", "-q", "--bare", remote]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", repo, "remote", "add", "origin", remote]).exitCode).toBe(0);
  expect(
    Bun.spawnSync([
      "git",
      "-C",
      repo,
      "push",
      "-q",
      "-u",
      "origin",
      "main",
      "master",
    ]).exitCode,
  ).toBe(0);
  return repo;
}

afterEach(() => {
  if (originalConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = originalConfig;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("validGithubFullName", () => {
  test("accepts ordinary owner/name pairs", () => {
    expect(validGithubFullName("tellahq/tella-fusion")).toBe(true);
    expect(validGithubFullName("owner/repo.name")).toBe(true);
    expect(validGithubFullName("o-w_n.er/re-po_1")).toBe(true);
  });

  test("rejects non-strings and empty parts", () => {
    expect(validGithubFullName(undefined)).toBe(false);
    expect(validGithubFullName(null)).toBe(false);
    expect(validGithubFullName(42)).toBe(false);
    expect(validGithubFullName("")).toBe(false);
    expect(validGithubFullName("owner/")).toBe(false);
    expect(validGithubFullName("/repo")).toBe(false);
    expect(validGithubFullName("just-a-name")).toBe(false);
  });

  test("rejects extra path segments and traversal", () => {
    expect(validGithubFullName("a/b/c")).toBe(false);
    expect(validGithubFullName("../etc/passwd")).toBe(false);
    expect(validGithubFullName("owner/..%2Fescape")).toBe(false);
  });

  test("rejects shell- and URL-meaningful characters", () => {
    expect(validGithubFullName("owner/repo;rm -rf /")).toBe(false);
    expect(validGithubFullName("owner/repo$(id)")).toBe(false);
    expect(validGithubFullName("owner/repo name")).toBe(false);
    expect(validGithubFullName("owner/repo\n")).toBe(false);
    expect(validGithubFullName("https://github.com/owner/repo")).toBe(false);
    expect(validGithubFullName("owner/repo?x=1")).toBe(false);
    expect(validGithubFullName("owner/repo#frag")).toBe(false);
    // The clone receives the full https URL through an argv array, so a
    // hyphen-prefixed owner cannot become a command flag.
    expect(validGithubFullName("--flag/repo")).toBe(true);
  });
});

describe("githubCredentialHelperCommand", () => {
  test("uses the stable installed command for compiled releases", () => {
    expect(
      githubCredentialHelperCommand("/home/alice/Open Session/bin/opensession", true),
    ).toBe("!'/home/alice/Open Session/bin/opensession' github-credential");
  });

  test("falls back to the source script before the shim is installed", () => {
    const command = githubCredentialHelperCommand("/missing/opensession", false);
    expect(command).toStartWith("!bun ");
    expect(command).toEndWith("scripts/gh-credential.ts");
  });
});

describe("normalizeDefaultBranch", () => {
  test("accepts ordinary and nested branch names", async () => {
    await expect(normalizeDefaultBranch("master")).resolves.toBe("master");
    await expect(normalizeDefaultBranch(" release/12.x ")).resolves.toBe("release/12.x");
  });

  test("rejects values git cannot use as branch names", async () => {
    await expect(normalizeDefaultBranch(undefined)).resolves.toBeNull();
    await expect(normalizeDefaultBranch(" ")).resolves.toBeNull();
    await expect(normalizeDefaultBranch("bad branch")).resolves.toBeNull();
    await expect(normalizeDefaultBranch("feature..next")).resolves.toBeNull();
    await expect(normalizeDefaultBranch("-dangerous")).resolves.toBeNull();
  });

  test("rejects git-valid shell and Markdown metacharacters", async () => {
    await expect(normalizeDefaultBranch("release;echo-not-a-command")).resolves.toBeNull();
    await expect(normalizeDefaultBranch("release`whoami`")).resolves.toBeNull();
    await expect(normalizeDefaultBranch("release$(whoami)")).resolves.toBeNull();
  });
});

describe("repository default branch settings", () => {
  test("updates only the selected repo config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        repos: {
          "compiler:legacy": {
            label: "Compiler",
            repo,
            defaultBranch: "main",
            customSetting: "preserved",
          },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/compiler%3Alegacy");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "master" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      id: "compiler:legacy",
      defaultBranch: "master",
      isolatedWorktrees: true,
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.repos["compiler:legacy"].defaultBranch).toBe("master");
    expect(saved.repos["compiler:legacy"].customSetting).toBe("preserved");
  });

  test("updates worktree isolation only for the selected repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        repos: {
          compiler: {
            repo,
            defaultBranch: "main",
            sharedCheckout: true,
            customSetting: "preserved",
          },
          docs: { repo: join(dir, "docs"), defaultBranch: "main", sharedCheckout: true },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/compiler");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isolatedWorktrees: true }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      id: "compiler",
      defaultBranch: "main",
      isolatedWorktrees: true,
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.repos.compiler.sharedCheckout).toBe(false);
    expect(saved.repos.compiler.customSetting).toBe("preserved");
    expect(saved.repos.docs.sharedCheckout).toBe(true);
  });

  test("migrates the legacy global override without changing other repos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        selfDev: "worktree",
        repos: {
          app: { repo, defaultBranch: "main", sharedCheckout: true },
          docs: { repo: join(dir, "docs"), defaultBranch: "main", sharedCheckout: true },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/app");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isolatedWorktrees: false }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.selfDev).toBeUndefined();
    expect(saved.repos.app.sharedCheckout).toBe(true);
    expect(saved.repos.docs.sharedCheckout).toBe(false);
  });

  test("rejects a non-boolean worktree setting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(path, JSON.stringify({ repos: { app: { repo, defaultBranch: "main" } } }));

    const url = new URL("http://localhost/api/setup/repos/app");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isolatedWorktrees: "yes" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(400);
    expect(JSON.parse(readFileSync(path, "utf8")).repos.app.sharedCheckout).toBeUndefined();
  });

  test("rejects a branch that does not exist without changing config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(path, JSON.stringify({ repos: { compiler: { repo, defaultBranch: "main" } } }));

    const url = new URL("http://localhost/api/setup/repos/compiler");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "missing" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(400);
    expect(JSON.parse(readFileSync(path, "utf8")).repos.compiler.defaultBranch).toBe("main");
  });

  test("rejects prototype-special repository ids", async () => {
    const url = new URL("http://localhost/api/setup/repos/__proto__");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "main" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(400);
    expect(Object.prototype).not.toHaveProperty("defaultBranch");
  });

  test("rejects a shared checkout branch that is not currently checked out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        repos: {
          app: { repo, defaultBranch: "main", sharedCheckout: true },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/app");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "master" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(400);
    expect(JSON.parse(readFileSync(path, "utf8")).repos.app.defaultBranch).toBe("main");
  });
});

describe("adoptExistingCheckout", () => {
  const roots: string[] = [];
  const tmpRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "os-adopt-"));
    roots.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  async function makeCheckout(dir: string, origin: string): Promise<string> {
    mkdirSync(dir, { recursive: true });
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} remote add origin ${origin}`.quiet();
    await $`git -C ${dir} -c user.email=t@e -c user.name=t commit -q --allow-empty -m init`.quiet();
    return dir;
  }

  test("returns null when nothing is at the destination", async () => {
    expect(await adoptExistingCheckout(join(tmpRoot(), "absent"), () => true)).toBe(null);
  });

  test("adopts a checkout of the same repo (no token needed)", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://github.com/acme/widget.git",
    );
    const adopted = await adoptExistingCheckout(
      dest,
      (i) => (i.ghRepo || "").toLowerCase() === "acme/widget",
    );
    expect(adopted?.ghRepo).toBe("acme/widget");
    expect(adopted?.defaultBranch).toBe("main");
  });

  test("only adopts a code.storage checkout from the configured organization", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://old-org.code.storage/acme/widget.git",
    );
    const inspected = await adoptExistingCheckout(
      dest,
      (i) => matchesCodeStorageCheckout(i, "old-org", "acme/widget"),
    );
    expect(inspected?.cs).toEqual({ org: "old-org", repoId: "acme/widget" });
    expect(
      adoptExistingCheckout(
        dest,
        (i) => matchesCodeStorageCheckout(i, "new-org", "acme/widget"),
      ),
    ).rejects.toThrow(/Clone destination already exists/);
  });

  test("refuses a checkout of a different repo", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://github.com/acme/other.git",
    );
    expect(
      adoptExistingCheckout(dest, (i) => (i.ghRepo || "").toLowerCase() === "acme/widget"),
    ).rejects.toThrow(/Clone destination already exists/);
  });

  test("refuses a non-git directory at the destination", async () => {
    const dest = join(tmpRoot(), "widget");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "notes.txt"), "hi");
    expect(adoptExistingCheckout(dest, () => true)).rejects.toThrow(
      /Clone destination already exists/,
    );
  });
});
