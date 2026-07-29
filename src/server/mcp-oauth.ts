/**
 * Browser-based OAuth for HTTP MCP servers (docs/feeds-design.md — "easy to
 * connect any MCP, per user as well").
 *
 * Replaces the unusable headless flow (opencode's CLI OAuth listens on the
 * VPS's 127.0.0.1, unreachable from the user's browser): OpenSession runs the
 * OAuth 2.1 + PKCE flow itself with a redirect to
 * `<publicBaseUrl>/backstage/api/connections/mcp-oauth/callback`, so a
 * Connect button works from any signed-in device (iPhone PWA included).
 *
 * Grants are stored per server in ~/.opensession-mcp-oauth.json (0600):
 * one optional `shared` grant (workspace-wide identity, like the Linear/Plain
 * servers today) and per-user grants keyed by canonical team name (same
 * identity table as commit attribution — the github-auth.ts pattern). At run
 * time withDynamicCredentials() injects `Authorization: Bearer <token>` into
 * the server's headers — the run user's own grant when they have one, else
 * the shared grant. Engines never see refresh tokens; rotation happens here
 * (lazy kick + 2-min ticker parked on globalThis, refresh-on-first-use).
 *
 * Discovery follows the MCP auth spec: RFC 9728 protected-resource metadata
 * on the server origin → authorization server → RFC 8414 AS metadata →
 * dynamic client registration (RFC 7591, token_endpoint_auth_method "none").
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomBytes, createHash } from "crypto";
import { configuredServer } from "./config";
import { statePath } from "./rename-compat";
import { resolveTeammate } from "./shared/user-mappings";

const STORE_PATH = statePath(
  ".opensession-mcp-oauth.json",
  ".backstage-mcp-oauth.json",
);

interface OauthEndpoints {
  authorize: string;
  token: string;
  register?: string;
}

interface Grant {
  tokens: {
    accessToken: string;
    refreshToken?: string;
    /** ms epoch; absent = no known expiry. */
    expiresAt?: number;
  };
  updatedAt: string;
  /** Team member (or GitHub login fallback) who completed the flow. */
  connectedBy?: string;
}

interface ServerAuth {
  serverUrl: string;
  resource?: string;
  /** scopes_supported from RFC 9728 metadata — some ASes (Cognito, e.g.
   *  Plain's) reject unknown scopes, so the authorize request must stick to
   *  what the resource advertises. */
  scopes?: string[];
  endpoints: OauthEndpoints;
  clientInfo: { clientId: string };
  shared?: Grant;
  users?: Record<string, Grant>;
}

type Store = Record<string, ServerAuth>;

function readStore(): Store {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Preset OAuth providers — servers whose OAuth is NOT the MCP spec (no RFC
 * 9728 discovery / dynamic registration). Slack: fixed app credentials from
 * the env, user-scope consent, token in authed_user.access_token (xoxp-,
 * "send messages as them"). The grant store/refresh/injection is shared
 * with MCP-spec grants; only start/complete differ.
 */
interface OauthPreset {
  authorize: string;
  token: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Query params for the authorize URL (slack: user_scope). */
  authorizeParams: Record<string, string>;
  /** Pull the token out of the exchange response. */
  extract(res: any): {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };
  /** Env var the grant token is injected as for stdio MCP servers. */
  envVar?: string;
}

const OAUTH_PRESETS: Record<string, OauthPreset> = {
  slack: {
    authorize: "https://slack.com/oauth/v2/authorize",
    token: "https://slack.com/api/oauth.v2.access",
    clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
    clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    authorizeParams: {
      user_scope:
        "channels:read,groups:read,channels:history,groups:history,chat:write,users:read,search:read",
    },
    extract: (res) => ({
      accessToken: res?.authed_user?.access_token,
      refreshToken: res?.authed_user?.refresh_token,
      expiresIn: res?.authed_user?.expires_in,
    }),
    envVar: "SLACK_BOT_TOKEN",
  },
};

export function oauthPresetFor(name: string): OauthPreset | undefined {
  const p = OAUTH_PRESETS[name];
  if (!p) return undefined;
  return process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]
    ? p
    : undefined;
}

function callbackUrl(): string {
  return `${configuredServer().publicBaseUrl}/backstage/api/connections/mcp-oauth/callback`;
}

/** RFC 9728 → RFC 8414 discovery for an MCP server URL. */
async function discover(serverUrl: string): Promise<{
  resource?: string;
  scopes?: string[];
  endpoints: OauthEndpoints;
}> {
  const origin = new URL(serverUrl).origin;
  let asBase = origin;
  let resource: string | undefined;
  let scopes: string[] | undefined;
  try {
    const pr = (await (
      await fetch(`${origin}/.well-known/oauth-protected-resource`, {
        signal: AbortSignal.timeout(10_000),
      })
    ).json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    if (pr.authorization_servers?.[0]) asBase = pr.authorization_servers[0];
    resource = pr.resource;
    if (Array.isArray(pr.scopes_supported) && pr.scopes_supported.length)
      scopes = pr.scopes_supported;
  } catch {}
  for (const wk of [
    `${asBase.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    `${asBase.replace(/\/$/, "")}/.well-known/openid-configuration`,
  ]) {
    try {
      const meta = (await (
        await fetch(wk, { signal: AbortSignal.timeout(10_000) })
      ).json()) as Record<string, string>;
      if (meta.authorization_endpoint && meta.token_endpoint)
        return {
          resource,
          scopes,
          endpoints: {
            authorize: meta.authorization_endpoint,
            token: meta.token_endpoint,
            register: meta.registration_endpoint,
          },
        };
    } catch {}
  }
  throw new Error(`No OAuth authorization-server metadata for ${serverUrl}`);
}

/** Ensure a registered public client for this server (cached in the store). */
async function ensureServerAuth(
  name: string,
  serverUrl: string,
): Promise<ServerAuth> {
  const store = readStore();
  const cur = store[name];
  if (cur?.clientInfo?.clientId && cur.serverUrl === serverUrl) return cur;
  const { resource, scopes, endpoints } = await discover(serverUrl);
  if (!endpoints.register)
    throw new Error(
      `${name}: authorization server offers no dynamic client registration`,
    );
  const reg = (await (
    await fetch(endpoints.register, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "OpenSession",
        redirect_uris: [callbackUrl()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(10_000),
    })
  ).json()) as { client_id?: string; error_description?: string };
  if (!reg.client_id)
    throw new Error(
      `${name}: client registration failed (${reg.error_description || "no client_id"})`,
    );
  const next: ServerAuth = {
    serverUrl,
    resource,
    ...(scopes ? { scopes } : {}),
    endpoints,
    clientInfo: { clientId: reg.client_id },
    ...(cur ? { shared: cur.shared, users: cur.users } : {}),
  };
  const fresh = readStore();
  fresh[name] = next;
  writeStore(fresh);
  return next;
}

// Pending flows keyed by state (10-min TTL); parked on globalThis so a
// frontend-triggered hot reload doesn't strand an in-flight consent.
interface PendingFlow {
  name: string;
  verifier: string;
  teamName?: string; // absent = shared grant
  createdAt: number;
}
const pending: Map<string, PendingFlow> = ((globalThis as any).__osMcpOauth ??=
  new Map<string, PendingFlow>());
const PENDING_TTL_MS = 10 * 60_000;

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint the authorize URL for a server. `forUser` (any user ref — name,
 * github login, slack id) makes it a per-user grant; absent = shared.
 */
export async function startMcpOauthFlow(
  name: string,
  serverUrl: string,
  forUser?: string,
): Promise<{ url: string }> {
  const teamName = forUser ? resolveTeammate(forUser)?.name : undefined;
  if (forUser && !teamName)
    throw new Error(`"${forUser}" doesn't resolve to a configured teammate`);
  const preset = oauthPresetFor(name);
  if (preset) {
    const state = b64url(randomBytes(24));
    pending.set(state, {
      name,
      verifier: "",
      teamName,
      createdAt: Date.now(),
    });
    const url = new URL(preset.authorize);
    url.searchParams.set("client_id", process.env[preset.clientIdEnv]!);
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("state", state);
    for (const [k, v] of Object.entries(preset.authorizeParams))
      url.searchParams.set(k, v);
    // Ensure a store entry exists so grants have a home.
    const store = readStore();
    store[name] = store[name] || {
      serverUrl,
      endpoints: { authorize: preset.authorize, token: preset.token },
      clientInfo: { clientId: process.env[preset.clientIdEnv]! },
    };
    writeStore(store);
    return { url: url.toString() };
  }
  const auth = await ensureServerAuth(name, serverUrl);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  for (const [k, v] of pending)
    if (Date.now() - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  pending.set(state, { name, verifier, teamName, createdAt: Date.now() });
  const url = new URL(auth.endpoints.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", auth.clientInfo.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Scope to what the resource advertises when it does (strict ASes like
  // Cognito reject unknown scopes); the permissive default otherwise.
  url.searchParams.set(
    "scope",
    auth.scopes?.join(" ") || "openid profile email offline_access",
  );
  url.searchParams.set("prompt", "consent");
  if (auth.resource) url.searchParams.set("resource", auth.resource);
  return { url: url.toString() };
}

/** Complete a flow from the callback redirect. Returns what got connected. */
export async function completeMcpOauthFlow(
  state: string,
  code: string,
  completedBy?: string,
): Promise<{ name: string; teamName?: string }> {
  const flow = pending.get(state);
  if (!flow || Date.now() - flow.createdAt > PENDING_TTL_MS)
    throw new Error("This connect link expired — start again from Connections");
  pending.delete(state);
  const preset = oauthPresetFor(flow.name);
  if (preset) {
    const body = new URLSearchParams({
      code,
      client_id: process.env[preset.clientIdEnv]!,
      client_secret: process.env[preset.clientSecretEnv]!,
      redirect_uri: callbackUrl(),
    });
    const res = (await (
      await fetch(preset.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as any;
    const tok = preset.extract(res);
    if (!tok.accessToken)
      throw new Error(
        `Token exchange failed: ${res?.error || "no user token in response"}`,
      );
    const grant: Grant = {
      tokens: {
        accessToken: tok.accessToken,
        ...(tok.refreshToken ? { refreshToken: tok.refreshToken } : {}),
        ...(tok.expiresIn
          ? { expiresAt: Date.now() + tok.expiresIn * 1000 }
          : {}),
      },
      updatedAt: new Date().toISOString(),
      ...(completedBy ? { connectedBy: completedBy } : {}),
    };
    const fresh = readStore();
    const entry = fresh[flow.name];
    if (!entry) throw new Error(`Registration for ${flow.name} vanished`);
    if (flow.teamName)
      entry.users = { ...(entry.users || {}), [flow.teamName]: grant };
    else entry.shared = grant;
    writeStore(fresh);
    return { name: flow.name, teamName: flow.teamName };
  }
  const store = readStore();
  const auth = store[flow.name];
  if (!auth) throw new Error(`No pending registration for ${flow.name}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    client_id: auth.clientInfo.clientId,
    code_verifier: flow.verifier,
  });
  if (auth.resource) body.set("resource", auth.resource);
  const res = (await (
    await fetch(auth.endpoints.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    })
  ).json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.access_token)
    throw new Error(
      `Token exchange failed: ${res.error_description || res.error || "no access_token"}`,
    );
  const grant: Grant = {
    tokens: {
      accessToken: res.access_token,
      ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
      ...(res.expires_in
        ? { expiresAt: Date.now() + res.expires_in * 1000 }
        : {}),
    },
    updatedAt: new Date().toISOString(),
    ...(completedBy ? { connectedBy: completedBy } : {}),
  };
  const fresh = readStore();
  const entry = fresh[flow.name];
  if (!entry) throw new Error(`Registration for ${flow.name} vanished`);
  if (flow.teamName) {
    entry.users = { ...(entry.users || {}), [flow.teamName]: grant };
  } else {
    entry.shared = grant;
  }
  writeStore(fresh);
  return { name: flow.name, teamName: flow.teamName };
}

const REFRESH_AHEAD_MS = 5 * 60_000;

async function refreshGrant(
  name: string,
  auth: ServerAuth,
  who: "shared" | string,
): Promise<void> {
  const grant = who === "shared" ? auth.shared : auth.users?.[who];
  if (!grant?.tokens.refreshToken) return;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: grant.tokens.refreshToken,
    client_id: auth.clientInfo.clientId,
  });
  if (auth.resource) body.set("resource", auth.resource);
  try {
    const res = (await (
      await fetch(auth.endpoints.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!res.access_token) return;
    const next: Grant = {
      ...grant,
      tokens: {
        accessToken: res.access_token,
        refreshToken: res.refresh_token || grant.tokens.refreshToken,
        ...(res.expires_in
          ? { expiresAt: Date.now() + res.expires_in * 1000 }
          : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    const store = readStore();
    const entry = store[name];
    if (!entry) return;
    if (who === "shared") entry.shared = next;
    else entry.users = { ...(entry.users || {}), [who]: next };
    writeStore(store);
  } catch (e) {
    console.error(`[mcp-oauth] refresh failed for ${name}/${who}:`, e);
  }
}

async function refreshExpiring(): Promise<void> {
  const store = readStore();
  for (const [name, auth] of Object.entries(store)) {
    const targets: Array<"shared" | string> = [
      ...(auth.shared ? (["shared"] as const) : []),
      ...Object.keys(auth.users || {}),
    ];
    for (const who of targets) {
      const g = who === "shared" ? auth.shared : auth.users?.[who];
      const exp = g?.tokens.expiresAt;
      if (g?.tokens.refreshToken && exp && exp - Date.now() < REFRESH_AHEAD_MS)
        await refreshGrant(name, auth, who);
    }
  }
}

// Lazy 2-minute refresh ticker (parked on globalThis; started on first store
// use, so no entry-file side-effect import is needed).
function ensureTicker(): void {
  const g = globalThis as any;
  if (g.__osMcpOauthTicker) return;
  g.__osMcpOauthTicker = setInterval(() => {
    refreshExpiring().catch(() => {});
  }, 2 * 60_000);
  refreshExpiring().catch(() => {});
}

/**
 * The Authorization header value for a server, for a run by `user` — the
 * user's own grant first (per-user MCP identity), else the shared grant.
 * Sync (called from filterMcpServers); a stale token still gets returned
 * while the ticker refreshes in the background — the server 401s at worst,
 * which reads as "tools unavailable this turn", never a crashed run.
 */
export function mcpAuthHeader(name: string, user?: string): string | undefined {
  return mcpUserGrantHeader(name, user) ?? mcpSharedGrantHeader(name);
}

/** The user's own grant ONLY (no shared fallback) — lets callers order
 *  identities explicitly (e.g. session creator first, then prompter). */
export function mcpUserGrantHeader(
  name: string,
  user?: string,
): string | undefined {
  if (!user) return undefined;
  const teamName = resolveTeammate(user)?.name;
  if (!teamName) return undefined;
  return grantHeader(name, readStore()[name]?.users?.[teamName], teamName);
}

/** The workspace-wide grant ONLY. */
export function mcpSharedGrantHeader(name: string): string | undefined {
  return grantHeader(name, readStore()[name]?.shared, "shared");
}

function grantHeader(
  name: string,
  grant: Grant | undefined,
  who: string,
): string | undefined {
  ensureTicker();
  const auth = readStore()[name];
  if (!auth || !grant) return undefined;
  const { accessToken, expiresAt, refreshToken } = grant.tokens;
  if (expiresAt && expiresAt - Date.now() < REFRESH_AHEAD_MS && refreshToken)
    refreshGrant(name, auth, who).catch(() => {});
  if (expiresAt && expiresAt < Date.now()) return undefined;
  return `Bearer ${accessToken}`;
}

/** Connection status for the UI: who's connected on each grant. */
export function mcpOauthStatus(
  name: string,
): { shared?: { connectedBy?: string; updatedAt: string }; users: string[] } {
  const auth = readStore()[name];
  return {
    ...(auth?.shared
      ? {
          shared: {
            connectedBy: auth.shared.connectedBy,
            updatedAt: auth.shared.updatedAt,
          },
        }
      : {}),
    users: Object.keys(auth?.users || {}),
  };
}

// OAuth-capability probe (RFC 9728 protected-resource metadata on the
// server origin), cached 1h — drives "Connect my account" visibility for
// servers that run on a static workspace key today (e.g. posthog).
const capableCache = new Map<string, { capable: boolean; ts: number }>();
export async function isOauthCapable(serverUrl: string): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return false;
  }
  const cached = capableCache.get(origin);
  if (cached && Date.now() - cached.ts < 60 * 60_000) return cached.capable;
  let capable = false;
  try {
    const res = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
      signal: AbortSignal.timeout(6_000),
    });
    capable = res.ok;
  } catch {}
  capableCache.set(origin, { capable, ts: Date.now() });
  return capable;
}

/** Raw grant token (no "Bearer " prefix) — stdio env injection. */
export function mcpUserGrantToken(
  name: string,
  user?: string,
): string | undefined {
  const h = mcpUserGrantHeader(name, user);
  return h?.replace(/^Bearer\s+/i, "");
}

/** Any grant at all for this server (shared or any user's)? */
export function hasMcpOauthGrant(name: string, user?: string): boolean {
  if (user) return !!mcpAuthHeader(name, user);
  const auth = readStore()[name];
  return !!auth?.shared || Object.keys(auth?.users || {}).length > 0;
}

/** Drop a grant (Disconnect in the UI). */
export function removeMcpOauthGrant(name: string, forUser?: string): boolean {
  const store = readStore();
  const auth = store[name];
  if (!auth) return false;
  if (forUser) {
    const teamName = resolveTeammate(forUser)?.name;
    if (!teamName || !auth.users?.[teamName]) return false;
    delete auth.users[teamName];
  } else {
    if (!auth.shared) return false;
    delete auth.shared;
  }
  writeStore(store);
  return true;
}
