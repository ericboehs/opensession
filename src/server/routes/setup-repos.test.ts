import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  handleSetupRepoRoutes,
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
      "git", "-C", repo,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-q", "-m", "initial",
    ]).exitCode,
  ).toBe(0);
  expect(Bun.spawnSync(["git", "-C", repo, "branch", "master"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "init", "-q", "--bare", remote]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", repo, "remote", "add", "origin", remote]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", repo, "push", "-q", "-u", "origin", "main", "master"]).exitCode).toBe(0);
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
    // Matches the regex, but is harmless: the clone always receives the full
    // https URL via array spawn, so a "-"-prefixed owner can't become a flag.
    expect(validGithubFullName("--flag/repo")).toBe(true);
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
      default: true,
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.repos["compiler:legacy"].defaultBranch).toBe("master");
    expect(saved.repos["compiler:legacy"].customSetting).toBe("preserved");
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

  test("materializes the built-in registry before making it explicit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(path, "{}");

    const url = new URL("http://localhost/api/setup/repos/opensession");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default: true }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.repos.opensession.default).toBe(true);
    expect(typeof saved.repos.opensession.repo).toBe("string");
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

  test("makes one repository the default and clears the previous default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-config-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");
    const repo = createGitRepo(dir);
    process.env.OPENSESSION_CONFIG = path;
    writeFileSync(
      path,
      JSON.stringify({
        repos: {
          app: { repo, defaultBranch: "main", default: true },
          compiler: { repo, defaultBranch: "master", customSetting: "preserved" },
        },
      }),
    );

    const url = new URL("http://localhost/api/setup/repos/compiler");
    const response = await handleSetupRepoRoutes({
      req: new Request(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default: true }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      id: "compiler",
      defaultBranch: "master",
      default: true,
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.repos.app).not.toHaveProperty("default");
    expect(saved.repos.compiler.default).toBe(true);
    expect(saved.repos.compiler.customSetting).toBe("preserved");
  });
});
