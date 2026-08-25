import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setGithubAppKeyPathForTest,
  githubAppCredentialHealth,
  githubAppInstallationToken,
  githubRepositoryMatchesInstallation,
} from "./github-app";

const savedConfig = process.env.OPENSESSION_CONFIG;
const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  globalThis.fetch = originalFetch;
  __setGithubAppKeyPathForTest(undefined);
  const cache = globalThis as any;
  cache.__ghAppTokenCacheRead = null;
  cache.__ghAppTokenCacheWrite = null;
  cache.__ghAppLastMintOk = undefined;
  cache.__ghAppLastMintIdentity = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("repository-scoped App installation identity", () => {
  test("requires the requested repository owner to match the selected installation", () => {
    expect(githubRepositoryMatchesInstallation("tellahq/opensession", "TellaHQ")).toBe(true);
    expect(githubRepositoryMatchesInstallation("acme/opensession", "tellahq")).toBe(false);
    expect(githubRepositoryMatchesInstallation("tellahq/opensession/extra", "tellahq")).toBe(false);
    expect(githubRepositoryMatchesInstallation("tellahq/opensession", undefined)).toBe(false);
  });

  test("does not reuse a token cached for a previous installation owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-github-owner-cache-"));
    dirs.push(dir);
    const config = join(dir, "config.json");
    const keyPath = join(dir, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
    writeFileSync(
      config,
      JSON.stringify({
        integrations: {
          github: {
            oauthClientId: "Iv-owner-test",
            appSlug: "open-session-owner-test",
            installationOwner: "owner-b",
          },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = config;
    __setGithubAppKeyPathForTest(keyPath);
    (globalThis as any).__ghAppTokenCacheRead = {
      token: "owner-a-token",
      expiresAt: Date.now() + 30 * 60_000,
      installationId: 1,
      installationOwner: "owner-a",
      credentialIdentity: "Iv-owner-test::owner-a",
    };
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/app/installations")) {
        return Response.json([{ id: 2, account: { login: "owner-b" } }]);
      }
      if (url.endsWith("/app/installations/2/access_tokens")) {
        return Response.json({
          token: "owner-b-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    expect(await githubAppInstallationToken()).toBe("owner-b-token");
    expect(githubAppCredentialHealth()).toBe("operational");
    const changedConfig = join(dir, "config-owner-c.json");
    writeFileSync(
      changedConfig,
      JSON.stringify({
        integrations: {
          github: {
            oauthClientId: "Iv-owner-test",
            appSlug: "open-session-owner-test",
            installationOwner: "owner-c",
          },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = changedConfig;
    expect(githubAppCredentialHealth()).toBe("unchecked");
    expect(requests).toEqual([
      "https://api.github.com/app/installations",
      "https://api.github.com/app/installations/2/access_tokens",
    ]);
  });
});
