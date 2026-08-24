import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { selectedGithubCredentialIssues } from "./account-health";

const originalConfig = process.env.OPENSESSION_CONFIG;
const originalPat = process.env.GITHUB_API_TOKEN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = originalConfig;
  if (originalPat === undefined) delete process.env.GITHUB_API_TOKEN;
  else process.env.GITHUB_API_TOKEN = originalPat;
  globalThis.fetch = originalFetch;
});

describe("GitHub account health credential selection", () => {
  test("App mode ignores a retired PAT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-account-health-"));
    try {
      const config = join(dir, "config.json");
      writeFileSync(
        config,
        JSON.stringify({ integrations: { github: { botCredential: "app" } } }),
      );
      process.env.OPENSESSION_CONFIG = config;
      process.env.GITHUB_API_TOKEN = "retired-pat";
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return new Response(null, { status: 401 });
      }) as unknown as typeof fetch;

      expect(await selectedGithubCredentialIssues()).toEqual([]);
      expect(requests).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
