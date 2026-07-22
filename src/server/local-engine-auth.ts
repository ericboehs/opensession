import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { writeFileAtomic } from "./shared/atomic-write";
import type { ClaudeAccount } from "./claude-accounts";
import type { CodexAccount } from "./codex-accounts";
import { localProfileRoot } from "./profile";

export const LOCAL_CLAUDE_ACCOUNT_ID = "local-claude-cli";
export const LOCAL_CODEX_ACCOUNT_ID = "local-codex-cli";
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export type LocalEngineProvider = "anthropic" | "openai";

interface ClaudeOauthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface LocalEngineDiscoveryOptions {
  home?: string;
  platform?: NodeJS.Platform;
  keychainReader?: () => string | null;
  keychainCachePath?: string;
}

export interface LocalEngineCredentials {
  providers: LocalEngineProvider[];
  claude?: {
    credentialsPath: string;
    source: "file" | "keychain";
    oauth: ClaudeOauthCredentials;
  };
  codex?: {
    home: string;
    authPath: string;
  };
  errors: string[];
}

function parseClaudeCredentials(raw: string): ClaudeOauthCredentials | null {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: Number(oauth.expiresAt) || 0,
    };
  } catch {
    return null;
  }
}

function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function validCodexAuth(path: string): boolean {
  try {
    const auth = JSON.parse(readFileSync(path, "utf-8"));
    const access = auth?.tokens?.access_token;
    if (typeof access !== "string" || !access) return false;
    const expiresAt = jwtExpiryMs(access);
    return expiresAt !== null && expiresAt > Date.now();
  } catch {
    return false;
  }
}

function readClaudeKeychain(): string | null {
  try {
    const result = Bun.spawnSync(
      ["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { stdout: "pipe", stderr: "pipe", timeout: 3_000 },
    );
    if (result.exitCode !== 0) return null;
    const value = result.stdout.toString().trim();
    return value || null;
  } catch {
    return null;
  }
}

function cacheKeychainCredentials(path: string, oauth: ClaudeOauthCredentials): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Meridian only consumes the access token. Do not duplicate the rotating
  // refresh token outside macOS Keychain.
  writeFileAtomic(
    path,
    `${JSON.stringify({
      claudeAiOauth: { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt },
    })}\n`,
  );
  chmodSync(path, 0o600);
}

/**
 * Discover the subscriptions owned by the local machine's CLI user.
 *
 * Credential sources are read fresh on every call so a Claude Code or Codex
 * refresh causes the next OpenCode server ensure to drain onto the new access
 * token. OpenSession never refreshes or writes either CLI-owned source: OAuth
 * refresh tokens rotate, so a second writer could invalidate the CLI login.
 */
export function discoverLocalEngineCredentials(
  options: LocalEngineDiscoveryOptions = {},
): LocalEngineCredentials {
  const home = options.home || process.env.HOME || homedir();
  const platform = options.platform || process.platform;
  const errors: string[] = [];
  const providers: LocalEngineProvider[] = [];
  let claude: LocalEngineCredentials["claude"];
  let codex: LocalEngineCredentials["codex"];

  const claudePath = `${home}/.claude/.credentials.json`;
  if (platform === "darwin") {
    const raw = (options.keychainReader || readClaudeKeychain)();
    const oauth = raw ? parseClaudeCredentials(raw) : null;
    if (raw && oauth && (oauth.expiresAt <= 0 || oauth.expiresAt > Date.now())) {
      const cachePath =
        options.keychainCachePath || `${localProfileRoot()}/auth/claude/.credentials.json`;
      try {
        cacheKeychainCredentials(cachePath, oauth);
        claude = { credentialsPath: cachePath, source: "keychain", oauth };
        providers.push("anthropic");
      } catch (error) {
        errors.push(
          `Claude Code Keychain credentials could not be cached at ${cachePath}: ${error instanceof Error ? error.message : error}`,
        );
      }
    } else if (oauth) {
      errors.push(`Claude Code credentials in macOS Keychain are expired`);
    } else if (raw) {
      errors.push(`macOS Keychain item "${CLAUDE_KEYCHAIN_SERVICE}" is malformed`);
    }
  }
  if (!claude && existsSync(claudePath)) {
    try {
      const raw = readFileSync(claudePath, "utf-8");
      const oauth = parseClaudeCredentials(raw);
      if (oauth && (oauth.expiresAt <= 0 || oauth.expiresAt > Date.now())) {
        claude = { credentialsPath: claudePath, source: "file", oauth };
        providers.push("anthropic");
      } else if (oauth) {
        errors.push(`Claude Code credentials at ${claudePath} are expired`);
      } else {
        errors.push(`Claude Code credentials at ${claudePath} are malformed`);
      }
    } catch (error) {
      errors.push(
        `Claude Code credentials at ${claudePath} could not be read: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const codexHome = `${home}/.codex`;
  const codexAuthPath = `${codexHome}/auth.json`;
  if (existsSync(codexAuthPath)) {
    if (validCodexAuth(codexAuthPath)) {
      codex = { home: codexHome, authPath: codexAuthPath };
      providers.push("openai");
    } else {
      errors.push(`Codex credentials at ${codexAuthPath} have no valid unexpired ChatGPT access token`);
    }
  }

  return { providers, claude, codex, errors };
}

export function localClaudeAccount(): ClaudeAccount | { error: string } {
  const credentials = discoverLocalEngineCredentials();
  if (!credentials.claude) {
    return {
      error:
        credentials.errors.find((error) => error.includes("Claude")) ||
        "Claude Code credentials were not found; run `claude` and log in, then restart OpenSession",
    };
  }
  const { oauth, credentialsPath } = credentials.claude;
  if (oauth.expiresAt > 0 && oauth.expiresAt <= Date.now()) {
    return {
      error:
        "Claude Code's access token is expired. Run `claude` once so the CLI refreshes its login, then retry. " +
        "OpenSession will not rotate the CLI's refresh token behind its back.",
    };
  }
  return {
    id: LOCAL_CLAUDE_ACCOUNT_ID,
    name: "Local Claude Code",
    token: oauth.accessToken,
    credentialsPath,
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

export function localCodexAccount(): CodexAccount | { error: string } {
  const credentials = discoverLocalEngineCredentials();
  if (!credentials.codex) {
    return {
      error:
        credentials.errors.find((error) => error.includes("Codex")) ||
        "Codex CLI credentials were not found; run `codex login`, then restart OpenSession",
    };
  }
  return {
    id: LOCAL_CODEX_ACCOUNT_ID,
    name: "Local Codex CLI",
    kind: "home",
    value: credentials.codex.home,
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

export function localProviderError(provider: string): string | null {
  if (provider !== "anthropic" && provider !== "openai") {
    return `The local profile only supports Claude Code (anthropic) and Codex CLI (openai), not "${provider}"`;
  }
  const credentials = discoverLocalEngineCredentials();
  if (credentials.providers.includes(provider)) return null;
  return provider === "anthropic"
    ? "Claude Code credentials were not found; run `claude` and log in, then restart OpenSession"
    : "Codex CLI credentials were not found or its access token is expired; run `codex login`, then restart OpenSession";
}

export function assertLocalEngineCredentials(): void {
  const credentials = discoverLocalEngineCredentials();
  if (credentials.providers.length) return;
  const detail = credentials.errors.length ? ` (${credentials.errors.join("; ")})` : "";
  throw new Error(
    "OPENSESSION_PROFILE=local found no model subscription credentials. " +
      "Log into Claude Code with `claude` and/or Codex with `codex login`, then restart OpenSession." +
      detail,
  );
}
