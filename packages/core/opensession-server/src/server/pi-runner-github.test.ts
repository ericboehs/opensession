import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GITHUB_RUN_AUTH_FILE_ENV } from "./github-auth";
import { githubCodeRunEnv } from "./pi-runner";

const keys = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_GITHUB_AUTH_STORE",
  "GITHUB_API_TOKEN",
  GITHUB_RUN_AUTH_FILE_ENV,
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("recovered GitHub code-run credentials", () => {
  test("resolves the selected service credential instead of a connected human", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-recovered-github-"));
    try {
      const cwd = join(dir, "repo");
      mkdirSync(cwd);
      const config = join(dir, "config.json");
      const users = join(dir, "github-users.json");
      writeFileSync(
        config,
        JSON.stringify({
          integrations: { github: { botCredential: "pat" } },
          repos: {
            app: {
              repo: cwd,
              ghRepo: "tellahq/app",
              defaultBranch: "main",
            },
          },
        }),
      );
      writeFileSync(
        users,
        JSON.stringify({
          users: {
            alice: { login: "alice", token: "human-token", connectedAt: new Date().toISOString() },
          },
        }),
      );
      process.env.OPENSESSION_CONFIG = config;
      process.env.OPENSESSION_GITHUB_AUTH_STORE = users;
      process.env.GITHUB_API_TOKEN = "selected-service-pat";
      delete process.env[GITHUB_RUN_AUTH_FILE_ENV];

      const env = await githubCodeRunEnv(cwd);
      expect(env.GH_TOKEN).toBe("selected-service-pat");
      expect(Object.values(env)).not.toContain("human-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remote recovery consumes only its projected run-scoped file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-projected-github-"));
    try {
      const auth = join(dir, "github-auth.json");
      writeFileSync(auth, JSON.stringify({ GH_TOKEN: "projected-service-token" }));
      process.env[GITHUB_RUN_AUTH_FILE_ENV] = auth;
      process.env.GITHUB_API_TOKEN = "unprojected-host-token";

      const env = await githubCodeRunEnv("/remote/unregistered/repo");
      expect(env.GH_TOKEN).toBe("projected-service-token");
      expect(Object.values(env)).not.toContain("unprojected-host-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
