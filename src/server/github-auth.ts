/**
 * Per-user GitHub authentication (opt-in): interactive sessions run `gh` as
 * the session owner's own GitHub account, so PRs they open are authored by
 * the human — not the bot login the machine's gh CLI is signed into.
 *
 * Opt-in via config (`integrations.github` in ~/.opensession/config.json):
 *
 *   "integrations": {
 *     "github": { "userPrAuth": true, "oauthClientId": "<OAuth app client id>" }
 *   }
 *
 * Both keys are required for the feature to activate; absent/false = today's
 * bot behavior, byte-identical. The client id may also come from
 * OPENSESSION_GITHUB_CLIENT_ID (env wins, per config.ts precedence).
 *
 * Tokens come from GitHub's OAuth device flow (the same mechanism `gh auth
 * login` uses): start → the person enters a code at github.com/login/device →
 * poll for the access token. The OAuth app must have "Enable Device Flow"
 * checked; no client secret is involved. Tokens are stored per GitHub login
 * in ~/.opensession-github-auth.json (0600), are never returned by the API,
 * and are injected only as GH_TOKEN/GITHUB_TOKEN into interactive,
 * non-least-privilege runs (see opencode-runner.ts) — automation runs and
 * anything carrying deniedTools never see them, the same fail-closed posture
 * as `allowedUsers` MCP servers. The run's user resolves to a GitHub login
 * through the SAME identity table as commit attribution (identity.team in
 * config.json → user-mappings.ts), so the mapping is config, not code.
 */

import { chmodSync, readFileSync } from "fs";
import { audit } from "./audit";
import { getConfig } from "./config";
import { writeJsonAtomic } from "./shared/atomic-write";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";
import { githubLoginFor } from "./shared/user-mappings";

const HOME = process.env.HOME || "/home/ubuntu";

/** Env override is for tests/sandboxes; read per call so it can change. */
function storePath(): string {
  return process.env.OPENSESSION_GITHUB_AUTH_STORE || `${HOME}/.opensession-github-auth.json`;
}

/** Scopes requested for user tokens: `repo` covers PR create/edit on private
 *  repos; `read:org` lets gh resolve org membership (same pair gh requests). */
const DEVICE_FLOW_SCOPE = "repo read:org";

export interface GithubUserAuthSettings {
  /** Feature switch (config `integrations.github.userPrAuth`). */
  enabled: boolean;
  /** OAuth app client id for the device flow; null = not configured. */
  clientId: string | null;
}

export interface GithubConnectedAccount {
  login: string;
  /** GitHub profile display name at connect time. */
  name?: string;
  scopes?: string;
  connectedAt: string;
}

interface StoredAccount extends GithubConnectedAccount {
  token: string;
}

interface Store {
  users: Record<string, StoredAccount>; // keyed by lowercased login
}

export function githubUserAuthSettings(): GithubUserAuthSettings {
  const raw = getConfig().integrations?.github;
  const o = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const clientId =
    process.env.OPENSESSION_GITHUB_CLIENT_ID ||
    (typeof o.oauthClientId === "string" && o.oauthClientId.trim()
      ? o.oauthClientId.trim()
      : null);
  return { enabled: o.userPrAuth === true, clientId };
}

/** Feature is usable: switched on AND a client id to run the device flow. */
export function githubUserAuthActive(): boolean {
  const s = githubUserAuthSettings();
  return s.enabled && !!s.clientId;
}

function readStore(): Store {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf-8"));
    const users = raw?.users && typeof raw.users === "object" ? raw.users : {};
    return { users };
  } catch {
    return { users: {} };
  }
}

function writeStore(store: Store): void {
  writeJsonAtomic(storePath(), store);
  try {
    chmodSync(storePath(), 0o600);
  } catch {}
}

// ── Device flow ──────────────────────────────────────────────────────────────

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between polls GitHub asks for. */
  interval: number;
  expiresIn: number;
}

export async function startGithubDeviceFlow(): Promise<DeviceFlowStart | { error: string }> {
  const { enabled, clientId } = githubUserAuthSettings();
  if (!enabled) return { error: "GitHub user auth is not enabled (config integrations.github.userPrAuth)" };
  if (!clientId) return { error: "No OAuth client id configured (integrations.github.oauthClientId)" };
  const res = await fetchWithTimeout("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: DEVICE_FLOW_SCOPE }),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.device_code) {
    return { error: body?.error_description || body?.error || `GitHub device flow failed (${res.status})` };
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri || "https://github.com/login/device",
    interval: typeof body.interval === "number" ? body.interval : 5,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
  };
}

export type DeviceFlowPoll =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "ok"; login: string; name?: string }
  | { status: "error"; error: string };

/**
 * One poll of the device-flow token endpoint. On success, fetches the token's
 * own /user to learn WHO authorized (the login is ground truth from GitHub —
 * never client-supplied) and stores the token under that login.
 */
export async function pollGithubDeviceFlow(deviceCode: string): Promise<DeviceFlowPoll> {
  const { clientId } = githubUserAuthSettings();
  if (!clientId) return { status: "error", error: "No OAuth client id configured" };
  const res = await fetchWithTimeout("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const body: any = await res.json().catch(() => null);
  if (!body) return { status: "error", error: `GitHub token endpoint failed (${res.status})` };
  if (body.error === "authorization_pending") return { status: "pending" };
  if (body.error === "slow_down") {
    return { status: "slow_down", interval: typeof body.interval === "number" ? body.interval : 10 };
  }
  if (body.error) {
    return { status: "error", error: body.error_description || body.error };
  }
  const token: string | undefined = body.access_token;
  if (!token) return { status: "error", error: "GitHub returned no access token" };

  const userRes = await fetchWithTimeout("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opensession",
    },
  });
  const user: any = await userRes.json().catch(() => null);
  const login: string | undefined = user?.login;
  if (!userRes.ok || !login) {
    return { status: "error", error: "Token issued but GET /user failed — not stored" };
  }

  const store = readStore();
  store.users[login.toLowerCase()] = {
    login,
    token,
    ...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
    ...(typeof body.scope === "string" ? { scopes: body.scope } : {}),
    connectedAt: new Date().toISOString(),
  };
  writeStore(store);
  audit({ kind: "github_auth_connect", login, scopes: body.scope });
  return { status: "ok", login, ...(user.name ? { name: user.name } : {}) };
}

// ── Store queries ────────────────────────────────────────────────────────────

/** Connected accounts, tokens stripped (UI/API safe). */
export function connectedGithubAccounts(): GithubConnectedAccount[] {
  return Object.values(readStore().users)
    .map(({ token: _token, ...rest }) => rest)
    .sort((a, b) => a.login.localeCompare(b.login));
}

export function removeGithubAccount(login: string): boolean {
  const store = readStore();
  const key = login.toLowerCase();
  if (!store.users[key]) return false;
  delete store.users[key];
  writeStore(store);
  audit({ kind: "github_auth_disconnect", login });
  return true;
}

/**
 * The GitHub login a run's user maps to IF the feature is active and that
 * person has connected — i.e. "this run authenticates as them". Null keeps
 * the bot behavior.
 */
export function githubUserLoginForRun(user?: string | null): string | null {
  if (!githubUserAuthActive()) return null;
  const login = githubLoginFor(user);
  if (!login) return null;
  return readStore().users[login.toLowerCase()] ? login : null;
}

/**
 * Env for a run that should act as its owner on GitHub: GH_TOKEN (gh CLI's
 * highest-precedence credential) + GITHUB_TOKEN (octokit-style tooling).
 * Empty when the feature is off, the user is unknown/unmapped, or they never
 * connected — callers can spread it unconditionally. Callers are responsible
 * for the trust gate (interactive, non-least-privilege runs only).
 */
export function githubAuthEnv(user?: string | null): Record<string, string> {
  const login = githubUserLoginForRun(user);
  if (!login) return {};
  const token = readStore().users[login.toLowerCase()]?.token;
  if (!token) return {};
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}
