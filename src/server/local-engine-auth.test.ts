import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  assertLocalEngineCredentials,
  discoverLocalEngineCredentials,
  localClaudeAccount,
  localCodexAccount,
  localOpencodeDataRoot,
  localProviderError,
} from "./local-engine-auth";

const savedHome = process.env.HOME;
let scratch: string[] = [];

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "local-engine-auth-"));
  scratch.push(home);
  return home;
}

function claudeCredentials(expiresAt = Date.now() + 60_000): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "claude-access",
      refreshToken: "claude-refresh",
      expiresAt,
    },
  });
}

function codexCredentials(expiresAt = Date.now() + 60_000): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString("base64url");
  return JSON.stringify({ tokens: { access_token: `header.${payload}.signature` } });
}

describe("local engine credential discovery", () => {
  it("discovers Claude Code and Codex CLI subscriptions without account stores", () => {
    const home = tempHome();
    mkdirSync(`${home}/.claude`, { recursive: true });
    mkdirSync(`${home}/.codex`, { recursive: true });
    writeFileSync(`${home}/.claude/.credentials.json`, claudeCredentials());
    writeFileSync(`${home}/.codex/auth.json`, codexCredentials());

    const found = discoverLocalEngineCredentials({ home, platform: "linux" });
    expect(found.providers).toEqual(["anthropic", "openai"]);
    expect(found.claude?.source).toBe("file");
    expect(found.codex?.home).toBe(`${home}/.codex`);
  });

  it("reads the exact Claude Code Keychain service into a private 0600 cache", () => {
    const home = tempHome();
    const cachePath = `${home}/os1/auth/claude/.credentials.json`;
    let service = "";
    const found = discoverLocalEngineCredentials({
      home,
      platform: "darwin",
      keychainCachePath: cachePath,
      keychainReader: (requestedService) => {
        service = requestedService;
        return { raw: claudeCredentials() };
      },
    });

    expect(service).toBe("Claude Code-credentials");
    expect(found.providers).toEqual(["anthropic"]);
    expect(found.claude?.credentialsPath).toBe(cachePath);
    const cachedOauth = JSON.parse(readFileSync(cachePath, "utf-8"))?.claudeAiOauth;
    expect(cachedOauth?.accessToken).toBe("claude-access");
    expect(cachedOauth?.refreshToken).toBeUndefined();
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it("fails clearly when neither CLI is logged in", () => {
    process.env.HOME = tempHome();
    expect(() => assertLocalEngineCredentials()).toThrow("Log into Claude Code");
  });

  it("preserves a macOS Keychain access failure in the startup error", () => {
    const home = tempHome();
    const found = discoverLocalEngineCredentials({
      home,
      platform: "darwin",
      keychainReader: () => ({ raw: null, error: "macOS Keychain is locked" }),
    });
    expect(found.providers).toEqual([]);
    expect(found.errors).toContain("macOS Keychain is locked");
  });

  it("synthesizes stable pool accounts and refuses an expired Claude access token", () => {
    const home = tempHome();
    mkdirSync(`${home}/.claude`, { recursive: true });
    mkdirSync(`${home}/.codex`, { recursive: true });
    writeFileSync(`${home}/.claude/.credentials.json`, claudeCredentials(Date.now() - 1));
    writeFileSync(`${home}/.codex/auth.json`, codexCredentials());
    process.env.HOME = home;

    expect(localClaudeAccount()).toEqual(expect.objectContaining({ error: expect.stringContaining("expired") }));
    expect(localCodexAccount()).toEqual(expect.objectContaining({ id: "local-codex-cli", value: `${home}/.codex` }));
    expect(existsSync(`${home}/.opensession-codex-accounts.json`)).toBe(false);
  });

  it("rejects missing and unsupported providers instead of falling through to OpenCode auth", () => {
    const home = tempHome();
    mkdirSync(`${home}/.claude`, { recursive: true });
    writeFileSync(`${home}/.claude/.credentials.json`, claudeCredentials());
    process.env.HOME = home;

    expect(localProviderError("anthropic")).toBeNull();
    expect(localClaudeAccount()).toEqual({
      id: "local-claude-cli",
      name: "Local Claude Code",
      token: "claude-access",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    expect(localProviderError("openai")).toContain("Codex CLI credentials");
    expect(localProviderError("xai")).toContain("only supports Claude Code");
    expect(localOpencodeDataRoot("anthropic")).toBe(`${home}/os1/auth/opencode-anthropic`);
  });

  it("does not advertise expired or malformed CLI access tokens", () => {
    const home = tempHome();
    mkdirSync(`${home}/.claude`, { recursive: true });
    mkdirSync(`${home}/.codex`, { recursive: true });
    writeFileSync(`${home}/.claude/.credentials.json`, claudeCredentials(Date.now() - 1));
    writeFileSync(`${home}/.codex/auth.json`, JSON.stringify({ tokens: { access_token: "not-a-jwt" } }));
    process.env.HOME = home;

    const found = discoverLocalEngineCredentials({ home, platform: "linux" });
    expect(found.providers).toEqual([]);
    expect(found.errors.join(" ")).toContain("expired");
    expect(found.errors.join(" ")).toContain("valid unexpired ChatGPT access token");
    expect(localProviderError("anthropic")).toContain("expired");

    writeFileSync(`${home}/.codex/auth.json`, codexCredentials(Date.now() - 60_000));
    expect(discoverLocalEngineCredentials({ home, platform: "linux" }).providers).toEqual([]);
  });
});
