/**
 * Per-user GitHub auth: config gating, token store lookups, runner env
 * building, and the web sign-in resolution — the pure/local parts (device
 * flow itself needs GitHub and is not tested here). Store paths are pointed
 * at temp files via their env overrides; audit-emitting mutations
 * (connect/disconnect/sign-in) are exercised only where they don't fire.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  connectedGithubAccounts,
  githubAuthEnv,
  githubCredentialForLogin,
  githubUserAuthActive,
  githubUserAuthSettings,
  githubUserLoginForRun,
  removeGithubAccount,
  validateGithubTokenLogin,
} from "./github-auth";
import {
  keypadBearerAuthorized,
  resolveWebAuth,
  teamMemberForLogin,
  webAuthRequired,
} from "./web-auth";

const ENV_KEYS = [
  "BACKSTAGE_CONFIG",
  "OPENSESSION_CONFIG",
  "OPENSESSION_GITHUB_CLIENT_ID",
  "OPENSESSION_GITHUB_AUTH_STORE",
  "OPENSESSION_WEB_SESSIONS_STORE",
  "KEYPAD_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bks-github-auth-test-"));
  for (const k of ENV_KEYS) delete process.env[k];
  // Isolate from the machine's real ~/.opensession/config.json (which may
  // have the feature enabled): a missing file = {} = built-in defaults.
  process.env.OPENSESSION_CONFIG = join(dir, "no-config.json");
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
  process.env.OPENSESSION_WEB_SESSIONS_STORE = join(dir, "web-sessions.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // web-auth parks its session map on globalThis — reset between cases.
  delete (globalThis as any).__webAuthSessions;
});

function enableFeature(): void {
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      identity: {
        team: [
          {
            name: "Alice Example",
            github: "alice",
            slackId: "U_ALICE",
            email: "alice@example.com",
            aliases: ["Alice"],
          },
        ],
      },
      integrations: { github: { userPrAuth: true, oauthClientId: "test-client-id" } },
    }),
  );
  process.env.OPENSESSION_CONFIG = path;
}

function seedToken(login = "alice", token = "gho_test123"): void {
  writeFileSync(
    process.env.OPENSESSION_GITHUB_AUTH_STORE!,
    JSON.stringify({
      users: {
        [login.toLowerCase()]: {
          login,
          token,
          connectedAt: "2026-07-18T00:00:00.000Z",
        },
      },
    }),
  );
}

describe("githubUserAuthSettings", () => {
  test("off by default (no config)", () => {
    const s = githubUserAuthSettings();
    expect(s.enabled).toBe(false);
    expect(githubUserAuthActive()).toBe(false);
    expect(webAuthRequired()).toBe(false);
  });

  test("enabled + client id from config activates the feature", () => {
    enableFeature();
    const s = githubUserAuthSettings();
    expect(s.enabled).toBe(true);
    expect(s.clientId).toBe("test-client-id");
    expect(githubUserAuthActive()).toBe(true);
    expect(webAuthRequired()).toBe(true);
  });

  test("enabled without a client id is not active", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ integrations: { github: { userPrAuth: true } } }));
    process.env.OPENSESSION_CONFIG = path;
    expect(githubUserAuthSettings().enabled).toBe(true);
    expect(githubUserAuthActive()).toBe(false);
  });

  test("env client id wins over config", () => {
    enableFeature();
    process.env.OPENSESSION_GITHUB_CLIENT_ID = "env-client-id";
    expect(githubUserAuthSettings().clientId).toBe("env-client-id");
  });
});

describe("token lookups + runner env", () => {
  test("resolves the session user through the identity table", () => {
    enableFeature();
    seedToken();
    // Configured aliases, Slack ids, email addresses, and GitHub logins all
    // resolve through the same identity table as commit attribution.
    for (const ref of ["Alice", "U_ALICE", "alice@example.com", "alice"]) {
      expect(githubUserLoginForRun(ref)).toBe("alice");
      expect(githubAuthEnv(ref)).toEqual({
        GH_TOKEN: "gho_test123",
        GITHUB_TOKEN: "gho_test123",
      });
    }
  });

  test("empty when the feature is off, the user is unknown, or not connected", () => {
    seedToken();
    expect(githubAuthEnv("Alice")).toEqual({}); // feature off
    enableFeature();
    expect(githubAuthEnv("Some Randomer")).toEqual({}); // unknown user
    expect(githubAuthEnv(null)).toEqual({});
    expect(githubAuthEnv("Bob")).toEqual({}); // unknown, never connected
    expect(githubUserLoginForRun("Bob")).toBeNull();
  });

  test("connectedGithubAccounts never exposes tokens", () => {
    seedToken();
    const accounts = connectedGithubAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].login).toBe("alice");
    expect((accounts[0] as any).token).toBeUndefined();
  });

  test("builds a credential only for the exact connected login", () => {
    enableFeature();
    seedToken("Alice");
    expect(githubCredentialForLogin("alice")).toEqual({
      kind: "user",
      principal: "user:alice",
      env: { GH_TOKEN: "gho_test123", GITHUB_TOKEN: "gho_test123" },
    });
    expect(githubCredentialForLogin("bob")).toBeNull();
  });

  test("rejects a device-flow login that differs from the signed-in user", () => {
    expect(validateGithubTokenLogin("alice", "Alice")).toEqual({ ok: true });
    expect(validateGithubTokenLogin("bob", "alice")).toEqual({
      ok: false,
      error: "GitHub authorized @bob, but the signed-in user is @alice",
    });
  });

  test("removeGithubAccount on an unknown login is a no-op", () => {
    expect(removeGithubAccount("nobody")).toBe(false);
  });
});

describe("web sign-in resolution", () => {
  test("team gate: only configured github logins may sign in", () => {
    expect(teamMemberForLogin("alice")).toBeNull();
    enableFeature();
    expect(teamMemberForLogin("alice")?.name).toBe("Alice Example");
    expect(teamMemberForLogin("Alice")?.name).toBe("Alice Example");
    expect(teamMemberForLogin("some-rando")).toBeNull();
  });

  test("resolves the session cookie and Bearer token from a seeded store", () => {
    const now = Date.now();
    writeFileSync(
      process.env.OPENSESSION_WEB_SESSIONS_STORE!,
      JSON.stringify({
        sessions: [
          {
            token: "tok-abc",
            login: "alice",
            name: "Alice Example",
            createdAt: now,
            lastSeenAt: now,
          },
        ],
      }),
    );
    const byCookie = resolveWebAuth(
      new Request("http://x/", { headers: { cookie: "foo=1; opensession_auth=tok-abc" } }),
    );
    expect(byCookie).toEqual({ login: "alice", name: "Alice Example" });
    const byBearer = resolveWebAuth(
      new Request("http://x/", { headers: { authorization: "Bearer tok-abc" } }),
    );
    expect(byBearer?.login).toBe("alice");
    expect(resolveWebAuth(new Request("http://x/"))).toBeNull();
    expect(
      resolveWebAuth(new Request("http://x/", { headers: { cookie: "opensession_auth=wrong" } })),
    ).toBeNull();
  });
});

describe("keypad bearer auth", () => {
  test("fails closed when KEYPAD_TOKEN is unset", () => {
    expect(
      keypadBearerAuthorized(
        new Request("http://x/api/keypad", {
          headers: { authorization: "Bearer anything" },
        }),
      ),
    ).toBe(false);
  });

  test("accepts only the configured bearer token", () => {
    process.env.KEYPAD_TOKEN = "keypad-test-secret";
    const request = (authorization?: string) =>
      new Request("http://x/api/keypad", {
        headers: authorization ? { authorization } : undefined,
      });

    expect(keypadBearerAuthorized(request("Bearer keypad-test-secret"))).toBe(true);
    expect(keypadBearerAuthorized(request("bearer keypad-test-secret"))).toBe(true);
    expect(keypadBearerAuthorized(request("Bearer wrong-secret"))).toBe(false);
    expect(keypadBearerAuthorized(request())).toBe(false);
  });
});
