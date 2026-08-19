import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectSandboxProvider, updateSandboxConnection } from "./connections";

let scratch = "";

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "os-remote-template-"));
  process.env.OPENSESSION_SESSIONS_DIR = `${scratch}/sessions`;
  process.env.OPENSESSION_SANDBOX_CONFIG = `${scratch}/sandbox.json`;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = `${scratch}/secrets.json`;
  await Bun.write(
    process.env.OPENSESSION_SANDBOX_CONFIG,
    JSON.stringify({ runnerSha: "abc" }),
  );
  connectSandboxProvider("modal", {
    tokenId: "test-id",
    tokenSecret: "test-secret",
    settings: { image: "base:v1" },
  });
});

afterEach(() => {
  delete process.env.OPENSESSION_SESSIONS_DIR;
  delete process.env.OPENSESSION_SANDBOX_CONFIG;
  delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  rmSync(scratch, { recursive: true, force: true });
});

describe("remote repo template index", () => {
  test("round-trips only while signature and ttl match", async () => {
    const mod = await import(`./remote-repo-template?roundtrip=${Math.random()}`);
    mod.writeRemoteRepoTemplate("modal", "app", "im-1", 1_000);
    expect(mod.readRemoteRepoTemplate("modal", "app", 2_000)?.artifactId).toBe("im-1");
    expect(
      mod.readRemoteRepoTemplate(
        "modal",
        "app",
        1_000 + mod.REMOTE_REPO_TEMPLATE_TTL_MS + 1,
      ),
    ).toBeNull();
  });

  test("create-shape changes invalidate the local artifact mapping", async () => {
    const mod = await import(`./remote-repo-template?shape=${Math.random()}`);
    mod.writeRemoteRepoTemplate("modal", "app", "im-1");
    updateSandboxConnection("modal", { settings: { image: "base:v2" } });
    expect(mod.readRemoteRepoTemplate("modal", "app")).toBeNull();
  });

  test("replacements report the old artifact for provider cleanup", async () => {
    const mod = await import(`./remote-repo-template?replace=${Math.random()}`);
    mod.writeRemoteRepoTemplate("daytona", "app", "snap-1");
    const result = mod.writeRemoteRepoTemplate("daytona", "app", "snap-2");
    expect(result.previous?.artifactId).toBe("snap-1");
    const stored = JSON.parse(
      readFileSync(
        `${scratch}/sessions/sandbox-repo-templates/daytona-app.json`,
        "utf-8",
      ),
    );
    expect(stored.artifactId).toBe("snap-2");
  });
});
