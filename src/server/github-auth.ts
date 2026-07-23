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

/** Classic OAuth needs `repo` for PR writes on private repositories. Team
 * membership is resolved from our local identity config, so no org scope. */
const DEVICE_FLOW_SCOPE = "repo";

export interface GithubUserAuthSettings {
  /** Feature switch (config `integrations.github.userPrAuth`). */
  enabled: boolean;
  /** OAuth app client id (device flow + redirect flow); null = not configured. */
  clientId: string | null;
  /** OAuth app client secret — enables the redirect (authorization-code)
   *  sign-in flow. Absent = device flow only. */
  clientSecret: string | null;
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
  const clientSecret =
    process.env.OPENSESSION_GITHUB_CLIENT_SECRET ||
    (typeof o.oauthClientSecret === "string" && o.oauthClientSecret.trim()
      ? o.oauthClientSecret.trim()
      : null);
  return { enabled: o.userPrAuth === true, clientId, clientSecret };
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

function stripStoredAccount({ token: _token, ...rest }: StoredAccount): GithubConnectedAccount {
  return rest;
}

export function connectedGithubAccount(login: string): GithubConnectedAccount | null {
  const account = readStore().users[login.toLowerCase()];
  return account ? stripStoredAccount(account) : null;
}

export function validateGithubTokenLogin(
  actualLogin: string,
  expectedLogin?: string | null
): { ok: true } | { ok: false; error: string } {
  if (!expectedLogin || actualLogin.toLowerCase() === expectedLogin.toLowerCase()) return { ok: true };
  return {
    ok: false,
    error: `GitHub authorized @${actualLogin}, but the signed-in user is @${expectedLogin}`,
  };
}

/**
 * One poll of the device-flow token endpoint. On success, fetches the token's
 * own /user to learn WHO authorized (the login is ground truth from GitHub —
 * never client-supplied) and stores the token under that login.
 */
export async function pollGithubDeviceFlow(
  deviceCode: string,
  expectedLogin?: string | null
): Promise<DeviceFlowPoll> {
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
  return identifyAndStoreToken(token, body.scope, expectedLogin);
}

// ── Server-driven device-flow completion ──
// The device code is entered OUTSIDE the requesting client (Safari, the
// GitHub app, another machine), and mobile clients get suspended or killed
// exactly while that happens — a client-driven poll loop dies with them.
// That's how sign-ins were getting lost: the GitHub grant landed, but nobody
// was polling anymore (or the one response carrying the minted session never
// reached the suspended app). So the SERVER owns the poll loop: the auth
// route calls watchGithubDeviceFlow after starting a flow, the outcome parks
// here until the code's expiry, and the client's /poll just consults it —
// idempotent, so a lost response is simply re-delivered on the next ask.
// Parked on globalThis so a bun --hot reload doesn't strand in-flight flows.

export type DeviceFlowServerState =
  | { status: "pending" }
  | { status: "ok"; login: string; name?: string }
  | { status: "error"; error: string };

type WatchedFlow = DeviceFlowServerState & { expiresAt: number };

const watchedFlows: Map<string, WatchedFlow> = ((globalThis as any).__osWatchedDeviceFlows ??=
  new Map());

function sweepWatchedFlows(): void {
  const now = Date.now();
  for (const [code, flow] of watchedFlows) {
    if (flow.expiresAt < now) watchedFlows.delete(code);
  }
}

/** Poll a just-started device flow to completion server-side. */
export function watchGithubDeviceFlow(flow: DeviceFlowStart): void {
  sweepWatchedFlows();
  if (watchedFlows.has(flow.deviceCode)) return;
  // Results stay retrievable for 10 min past the code's own expiry so a
  // client that resumes late still gets a definitive answer.
  const codeExpiresAt = Date.now() + flow.expiresIn * 1000;
  const keepUntil = codeExpiresAt + 10 * 60_000;
  watchedFlows.set(flow.deviceCode, { status: "pending", expiresAt: keepUntil });
  console.log(
    `[auth] device flow ${flow.userCode} (…${flow.deviceCode.slice(-6)}) started — watching server-side`,
  );
  void (async () => {
    let interval = Math.max(flow.interval, 5);
    while (Date.now() < codeExpiresAt) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      let result: DeviceFlowPoll;
      try {
        result = await pollGithubDeviceFlow(flow.deviceCode);
      } catch {
        continue; // transient — GitHub unreachable etc.
      }
      if (result.status === "pending") continue;
      if (result.status === "slow_down") {
        interval = Math.max(result.interval, interval);
        continue;
      }
      if (result.status === "ok") {
        watchedFlows.set(flow.deviceCode, {
          status: "ok",
          login: result.login,
          name: result.name,
          expiresAt: keepUntil,
        });
        console.log(`[auth] device flow ${flow.userCode} authorized by @${result.login}`);
      } else {
        watchedFlows.set(flow.deviceCode, {
          status: "error",
          error: result.error,
          expiresAt: keepUntil,
        });
        console.log(`[auth] device flow ${flow.userCode} failed: ${result.error}`);
      }
      return;
    }
    watchedFlows.set(flow.deviceCode, {
      status: "error",
      error: "The sign-in code expired — try again.",
      expiresAt: keepUntil,
    });
    console.log(`[auth] device flow ${flow.userCode} expired unused`);
  })();
}

/** Outcome of a server-watched flow (null: unknown code, or pre-watch flow). */
export function githubDeviceFlowResult(deviceCode: string): DeviceFlowServerState | null {
  sweepWatchedFlows();
  const flow = watchedFlows.get(deviceCode);
  if (!flow) return null;
  const { expiresAt: _expiresAt, ...state } = flow;
  return state;
}

/** Shared tail of both OAuth flows: learn WHO the token belongs to (GET /user
 *  with the token itself — the login is ground truth from GitHub, never
 *  client-supplied) and store it under that login. */
async function identifyAndStoreToken(
  token: string,
  scope?: unknown,
  expectedLogin?: string | null
): Promise<DeviceFlowPoll> {
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

  const ownership = validateGithubTokenLogin(login, expectedLogin);
  if (!ownership.ok) return { status: "error", error: ownership.error };

  const store = readStore();
  store.users[login.toLowerCase()] = {
    login,
    token,
    ...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
    ...(typeof scope === "string" ? { scopes: scope } : {}),
    connectedAt: new Date().toISOString(),
  };
  writeStore(store);
  audit({ kind: "github_auth_connect", login, scopes: scope });
  return { status: "ok", login, ...(user.name ? { name: user.name } : {}) };
}

// ── Redirect (authorization-code) flow ───────────────────────────────────────

/** Redirect flow available: feature on + client id + client secret. */
export function githubRedirectFlowAvailable(): boolean {
  const s = githubUserAuthSettings();
  return s.enabled && !!s.clientId && !!s.clientSecret;
}

/** The GitHub authorize URL for the redirect flow (caller provides the state
 *  it also set as a cookie, and the redirect_uri registered on the app). */
export function githubAuthorizeUrl(redirectUri: string, state: string): string | null {
  const { clientId } = githubUserAuthSettings();
  if (!githubRedirectFlowAvailable() || !clientId) return null;
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: DEVICE_FLOW_SCOPE,
    state,
  });
  return `https://github.com/login/oauth/authorize?${q}`;
}

/** Exchange a callback `code` for a token and store it (same tail as the
 *  device flow — identity comes from GET /user with the token). */
export async function exchangeGithubOauthCode(
  code: string,
  redirectUri: string
): Promise<DeviceFlowPoll> {
  const { clientId, clientSecret } = githubUserAuthSettings();
  if (!clientId || !clientSecret) {
    return { status: "error", error: "Redirect flow is not configured (client id/secret)" };
  }
  const res = await fetchWithTimeout("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body: any = await res.json().catch(() => null);
  if (!body) return { status: "error", error: `GitHub token endpoint failed (${res.status})` };
  if (body.error) {
    return { status: "error", error: body.error_description || body.error };
  }
  const token: string | undefined = body.access_token;
  if (!token) return { status: "error", error: "GitHub returned no access token" };
  return identifyAndStoreToken(token, body.scope);
}

// ── Store queries ────────────────────────────────────────────────────────────

/** Connected accounts, tokens stripped (UI/API safe). */
export function connectedGithubAccounts(): GithubConnectedAccount[] {
  return Object.values(readStore().users)
    .map(stripStoredAccount)
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

export interface GithubCredential {
  kind: "service" | "user";
  principal: string;
  env: Record<string, string>;
}

export const serviceGithubCredential: GithubCredential = {
  kind: "service",
  principal: "service",
  env: {},
};

/** Exact-login lookup for an already authenticated web request. */
export function githubCredentialForLogin(login: string): GithubCredential | null {
  if (!githubUserAuthActive()) return null;
  const account = readStore().users[login.toLowerCase()];
  if (!account?.token) return null;
  return {
    kind: "user",
    principal: `user:${account.login.toLowerCase()}`,
    env: { GH_TOKEN: account.token, GITHUB_TOKEN: account.token },
  };
}
