/**
 * Claude account pool for backstage runs.
 *
 * Each account is a long-lived OAuth token from `claude setup-token` (valid
 * ~1 year, tied to a Max subscription). Runs get the token injected as
 * CLAUDE_CODE_OAUTH_TOKEN in the child env, so switching accounts never
 * touches ~/.claude/.credentials.json — interactive CLI sessions on the VPS
 * keep whatever account they logged in with.
 *
 * Tokens live in ~/.backstage-claude-accounts.json (mode 0600). Usage per
 * account is polled from the OAuth usage endpoint every POLL_INTERVAL_MS and
 * kept in memory; the UI reads it via the /api/claude-accounts routes.
 */

import { chmodSync, existsSync, readFileSync } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";
import { userMatchesAny } from "./shared/user-mappings";

const HOME = process.env.HOME || "/home/ubuntu";
// The env override is a test seam — bun tests point it at a temp store so they
// never read (or clobber) the real account pool. Resolved per call, not at
// module load, so the override works regardless of import order.
function storePath(): string {
  return process.env.BACKSTAGE_CLAUDE_ACCOUNTS_PATH || `${HOME}/.backstage-claude-accounts.json`;
}
// Keep this conservative: the usage endpoint rate-limits per token with
// ~hour-long lockouts (observed Retry-After of ~50m after 10-minute polling).
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// Claude Code's public OAuth client id — the one the CLI itself refreshes with.
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Refresh a credentials-file access token this long before it expires.
const TOKEN_REFRESH_SLACK_MS = 5 * 60 * 1000;
// When a run hits a limit but the usage endpoint gives no reset time,
// sideline the account for this long before retrying it.
const DEFAULT_EXHAUST_MS = 60 * 60 * 1000;
// Treat an account as unusable for new runs at/above this 5-hour utilization.
const EXHAUSTED_UTILIZATION = 97;

export interface ClaudeAccount {
  id: string;
  name: string;
  token: string;
  email?: string;
  plan?: string;
  createdAt: string;
  /**
   * Personal subscription: when set, only runs whose user resolves to this
   * person (same identity table as commit attribution / MCP allowedUsers) use
   * the account — and their runs prefer it over the shared pool, falling back
   * to the pool when it's exhausted. Unset = shared pool account, used by
   * everyone and by automations (which run with no user).
   */
  owner?: string;
  // "missing" once the usage endpoint has returned 403 for this token
  // (`claude setup-token` tokens lack the user:profile scope). Persisted so
  // we never poll such accounts again, across restarts.
  usageScope?: "missing";
  // Optional path to a full OAuth credentials file (same shape as
  // ~/.claude/.credentials.json — the snapshots `claude-plan` keeps under
  // ~/.claude/accounts/<name>/credentials.json). Login credentials carry the
  // user:profile scope that setup-tokens lack, so when set, usage is polled
  // with this file's access token instead of `token`, refreshing it via the
  // OAuth refresh flow and writing rotated tokens back to the file. Runs
  // still use `token`; this only restores usage visibility.
  credentialsPath?: string;
}

interface UsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface AccountUsage {
  fetchedAt: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  // Per-model weekly caps (e.g. Fable) that are separate from the general
  // 5h/7-day windows — an account can be 100% on one of these while its overall
  // capacity is barely touched, which is exactly what makes it look "fine" in
  // the UI while runs on that model get turned away. `label` is the model name.
  scopedLimits?: { label: string; utilization: number | null; resetsAt: string | null }[];
  extraUsage?: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null;
  error?: string;
  errorStatus?: number;
}

export interface ClaudeAccountPublic {
  id: string;
  name: string;
  tokenMasked: string;
  email?: string;
  plan?: string;
  createdAt: string;
  owner?: string;
  usage: AccountUsage | null;
  noUsageScope: boolean;
  credentialsPath?: string;
  exhaustedUntil: string | null;
  usable: boolean;
}

const usageCache = new Map<string, AccountUsage>();
const exhaustedUntil = new Map<string, number>();
const modelExhaustedUntil = new Map<string, number>();
const lastPickedAt = new Map<string, number>();
// After a 429 from the usage endpoint, don't hit that same account again until
// this passes. The endpoint rate-limits per token; one account must not hide
// usage for every other account in the dashboard.
const usageRateLimitedUntil = new Map<string, number>();
const credentialsRefreshBlockedUntil = new Map<string, number>();
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 10 * 60 * 1000;
const FAILED_REFRESH_WAIT_MS = 60 * 60 * 1000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function fetchWithTimeout(url: string, token: string, timeoutMs = 10_000): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function readStore(): ClaudeAccount[] {
  if (!existsSync(storePath())) return [];
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf-8"));
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch (e) {
    console.error("[claude-accounts] Failed to read store:", e);
    return [];
  }
}

function writeStore(accounts: ClaudeAccount[]): void {
  writeFileAtomic(storePath(), JSON.stringify({ accounts }, null, 2) + "\n");
  chmodSync(storePath(), 0o600);
}

export function maskToken(token: string): string {
  if (token.length <= 16) return "…";
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

async function fetchUsage(token: string, rateLimitKey: string): Promise<AccountUsage> {
  const rateLimitedUntil = usageRateLimitedUntil.get(rateLimitKey) ?? 0;
  if (Date.now() < rateLimitedUntil) {
    return {
      fetchedAt: new Date().toISOString(),
      fiveHour: null,
      sevenDay: null,
      error: `usage endpoint rate-limited, retrying after ${new Date(rateLimitedUntil).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC`,
      errorStatus: 429,
    };
  }
  try {
    const res = await fetchWithTimeout(USAGE_URL, token);
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
            : DEFAULT_RATE_LIMIT_WAIT_MS;
        usageRateLimitedUntil.set(rateLimitKey, Date.now() + waitMs);
        console.warn(`[claude-accounts] usage endpoint rate-limited for ${rateLimitKey}; backing off ${Math.round(waitMs / 60000)}m`);
      }
      return {
        fetchedAt: new Date().toISOString(),
        fiveHour: null,
        sevenDay: null,
        error: `usage endpoint returned ${res.status}`,
        errorStatus: res.status,
      };
    }
    const body: any = await res.json();
    const window = (w: any): UsageWindow | null =>
      w ? { utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null } : null;
    // The `limits` array carries per-model weekly caps (kind "weekly_scoped",
    // e.g. Fable) that the top-level five_hour/seven_day fields don't expose.
    const scopedLimits = Array.isArray(body.limits)
      ? body.limits
          .filter((l: any) => l?.kind === "weekly_scoped")
          .map((l: any) => ({
            label: l?.scope?.model?.display_name || l?.scope?.surface || "scoped",
            utilization: typeof l?.percent === "number" ? l.percent : null,
            resetsAt: l?.resets_at ?? null,
          }))
      : [];
    return {
      fetchedAt: new Date().toISOString(),
      fiveHour: window(body.five_hour),
      sevenDay: window(body.seven_day),
      scopedLimits: scopedLimits.length ? scopedLimits : undefined,
      extraUsage: body.extra_usage
        ? {
            enabled: !!body.extra_usage.is_enabled,
            usedCredits: body.extra_usage.used_credits ?? 0,
            monthlyLimit: body.extra_usage.monthly_limit ?? 0,
          }
        : null,
    };
  } catch (e: any) {
    return {
      fetchedAt: new Date().toISOString(),
      fiveHour: null,
      sevenDay: null,
      error: e?.message || String(e),
    };
  }
}

async function fetchProfile(token: string): Promise<{ email?: string; plan?: string }> {
  try {
    const res = await fetchWithTimeout(PROFILE_URL, token);
    if (!res.ok) return {};
    const body: any = await res.json();
    return {
      email: body.account?.email || undefined,
      plan: body.organization?.rate_limit_tier || body.organization?.organization_type || undefined,
    };
  } catch {
    return {};
  }
}

interface OauthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function readCredsFile(path: string): OauthCreds | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf-8"))?.claudeAiOauth;
    if (!o?.accessToken || !o?.refreshToken) return null;
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      expiresAt: Number(o.expiresAt) || 0,
    };
  } catch (e) {
    console.warn(`[claude-accounts] Failed to read credentials file ${path}:`, e);
    return null;
  }
}

/**
 * Refresh the access token in a credentials file, writing rotated tokens
 * back (Anthropic rotates refresh tokens on use — the write-back is what
 * keeps the file usable for the next refresh, ours or `claude-plan`'s).
 */
async function refreshCredsFile(path: string, creds: OauthCreds): Promise<OauthCreds | null> {
  const blockedUntil = credentialsRefreshBlockedUntil.get(path) ?? 0;
  if (Date.now() < blockedUntil) return null;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
          : res.status === 429
            ? DEFAULT_RATE_LIMIT_WAIT_MS
            : FAILED_REFRESH_WAIT_MS;
      credentialsRefreshBlockedUntil.set(path, Date.now() + waitMs);
      console.warn(`[claude-accounts] Token refresh for ${path} failed: HTTP ${res.status}`);
      return null;
    }
    const body: any = await res.json();
    if (!body?.access_token) return null;
    const next: OauthCreds = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + (Number(body.expires_in) || 28_800) * 1000,
    };
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.claudeAiOauth = { ...raw.claudeAiOauth, ...next };
    writeFileAtomic(path, JSON.stringify(raw, null, 2) + "\n");
    chmodSync(path, 0o600);
    credentialsRefreshBlockedUntil.delete(path);
    return next;
  } catch (e) {
    credentialsRefreshBlockedUntil.set(path, Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS);
    console.warn(`[claude-accounts] Token refresh for ${path} failed:`, e);
    return null;
  }
}

/**
 * The token to poll usage with, and where it came from. Prefers the
 * credentials file (login scope) when configured, falling back to the
 * setup-token unless that's already known to lack the usage scope.
 */
async function usageToken(
  account: ClaudeAccount
): Promise<{ token: string; source: "credentials" | "setup-token" } | { error: string } | null> {
  if (account.credentialsPath) {
    const creds = readCredsFile(account.credentialsPath);
    if (creds) {
      if (creds.expiresAt > Date.now() + TOKEN_REFRESH_SLACK_MS) {
        return { token: creds.accessToken, source: "credentials" };
      }
      const fresh = await refreshCredsFile(account.credentialsPath, creds);
      if (fresh) return { token: fresh.accessToken, source: "credentials" };
      // Refresh failed but the stored token may still have a few minutes left.
      if (creds.expiresAt > Date.now()) {
        return { token: creds.accessToken, source: "credentials" };
      }
      const blockedUntil = credentialsRefreshBlockedUntil.get(account.credentialsPath) ?? 0;
      if (Date.now() < blockedUntil) {
        return {
          error: `OAuth token refresh is cooling down after a failed refresh; retrying after ${new Date(blockedUntil).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC.`,
        };
      }
      return {
        error:
          "OAuth credentials expired and refresh failed. Re-run `claude` login or `claude-plan auth` for this account, then set the usage credentials path again.",
      };
    }
    return { error: `Couldn't read OAuth credentials at ${account.credentialsPath}` };
  }
  if (account.usageScope === "missing") return null;
  return { token: account.token, source: "setup-token" };
}

/** Persist that this account's token can't read the usage endpoint. */
function markUsageScopeMissing(id: string): void {
  const accounts = readStore();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1 || accounts[idx].usageScope === "missing") return;
  accounts[idx] = { ...accounts[idx], usageScope: "missing" };
  writeStore(accounts);
  console.log(`[claude-accounts] ${accounts[idx].name} token lacks user:profile scope; usage polling disabled`);
}

/** Refresh cached usage for one account; clears exhausted state once reset has passed. */
async function refreshAccountUsage(account: ClaudeAccount): Promise<AccountUsage | null> {
  const tok = await usageToken(account);
  if (!tok) return null;
  if ("error" in tok) {
    const usage = {
      fetchedAt: new Date().toISOString(),
      fiveHour: null,
      sevenDay: null,
      error: tok.error,
    };
    usageCache.set(account.id, usage);
    return usage;
  }
  const cached = usageCache.get(account.id);

  const usage = await fetchUsage(tok.token, account.id);
  if (usage.errorStatus === 403) {
    // Only a setup-token 403 means the scope is permanently missing; a 403
    // on login credentials would be an anomaly worth surfacing, not latching.
    if (tok.source === "setup-token") {
      markUsageScopeMissing(account.id);
      usageCache.delete(account.id);
      return null;
    }
  }
  // On a transient failure (rate limit, 5xx, timeout), keep showing the last
  // good snapshot instead of blanking it with an error.
  if (usage.error && cached && !cached.error) return cached;
  usageCache.set(account.id, usage);

  const until = exhaustedUntil.get(account.id);
  if (until !== undefined && !usage.error) {
    const u = usage.fiveHour?.utilization;
    if (u !== null && u !== undefined && u < EXHAUSTED_UTILIZATION) {
      exhaustedUntil.delete(account.id);
      console.log(`[claude-accounts] ${account.name} usable again (5h at ${u}%)`);
    }
  }
  return usage;
}

export async function refreshAllUsage(): Promise<void> {
  // Sequential, not Promise.all — the endpoint rate-limits aggressively and a
  // burst of N simultaneous requests from one IP makes that worse.
  for (const account of readStore()) {
    if (account.usageScope === "missing" && !account.credentialsPath) continue;
    await refreshAccountUsage(account);
  }
}

export function startUsagePoller(): void {
  if (pollTimer) return;
  const accounts = readStore();
  if (accounts.length > 0) {
    void refreshAllUsage();
  }
  pollTimer = setInterval(() => {
    void refreshAllUsage().catch((e) => console.error("[claude-accounts] Poll failed:", e));
  }, POLL_INTERVAL_MS);
  console.log(`[claude-accounts] Usage poller started (${accounts.length} account(s), every ${POLL_INTERVAL_MS / 60000}m)`);
}

function isExhausted(id: string): boolean {
  const until = exhaustedUntil.get(id);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    exhaustedUntil.delete(id);
    return false;
  }
  return true;
}

function modelExhaustionKey(id: string, model?: string): string {
  return model ? `${id}:${model}` : id;
}

function isModelExhausted(id: string, model?: string): boolean {
  if (!model) return false;
  const key = modelExhaustionKey(id, model);
  const until = modelExhaustedUntil.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    modelExhaustedUntil.delete(key);
    return false;
  }
  return true;
}

/**
 * Whether this account can keep running past its subscription limits by
 * billing usage-credits: extra usage is turned on (at claude.ai) and the
 * monthly credit cap isn't spent yet. A monthlyLimit of 0 counts as no
 * headroom — this gate exists to bound spend, so it fails closed.
 */
function hasCreditHeadroom(a: ClaudeAccount): boolean {
  const extra = usageCache.get(a.id)?.extraUsage;
  return !!extra?.enabled && extra.monthlyLimit > 0 && extra.usedCredits < extra.monthlyLimit;
}

function scopedLimitForModel(usage: AccountUsage | undefined, model?: string): number | null {
  if (!usage || !model) return null;
  if (model === "claude-fable-5" || model.toLowerCase().includes("fable")) {
    const fable = usage.scopedLimits?.find((l) => l.label.toLowerCase() === "fable");
    return fable?.utilization ?? null;
  }
  return null;
}

function accountUtilization(a: ClaudeAccount, model?: string): number {
  const usage = usageCache.get(a.id);
  const fiveHour = usage?.fiveHour?.utilization ?? 0;
  const scoped = scopedLimitForModel(usage, model);
  return scoped === null ? fiveHour : Math.max(fiveHour, scoped);
}

/**
 * `allowExtraUsage` (per-run policy, e.g. an automation's usageCredits flag)
 * lets an account stay usable past the utilization ceiling as long as it has
 * usage-credits headroom — that's what "keep running on credits" means at the
 * picker layer. Run-observed exhaustion (a limit error from an actual run)
 * still sidelines it: that error only happens when credits are unavailable too.
 */
function isAccountUsableFor(a: ClaudeAccount, model?: string, allowExtraUsage?: boolean): boolean {
  if (isExhausted(a.id) || isModelExhausted(a.id, model)) return false;
  if (accountUtilization(a, model) < EXHAUSTED_UTILIZATION) return true;
  return !!allowExtraUsage && hasCreditHeadroom(a);
}

function toPublic(a: ClaudeAccount): ClaudeAccountPublic {
  const usage = usageCache.get(a.id) || null;
  const until = exhaustedUntil.get(a.id);
  const fiveHour = usage?.fiveHour?.utilization ?? null;
  return {
    id: a.id,
    name: a.name,
    tokenMasked: maskToken(a.token),
    email: a.email,
    plan: a.plan,
    createdAt: a.createdAt,
    owner: a.owner,
    usage,
    noUsageScope: a.usageScope === "missing" && !a.credentialsPath,
    credentialsPath: a.credentialsPath,
    exhaustedUntil: until !== undefined && until > Date.now() ? new Date(until).toISOString() : null,
    usable:
      !isExhausted(a.id) &&
      (fiveHour === null || fiveHour < EXHAUSTED_UTILIZATION),
  };
}

export function listAccountsPublic(): ClaudeAccountPublic[] {
  return readStore().map(toPublic);
}

/**
 * A session can pin a specific subscription (see BackstageSessionFile.accountId).
 * Return it when it exists and is currently usable for `model`; undefined when
 * it's gone or exhausted, so the caller falls back to the normal pool pick
 * (a pin is a preference, never a hard requirement that could wedge a run).
 */
export function getUsableAccountById(
  id: string,
  model?: string,
  allowExtraUsage?: boolean
): ClaudeAccount | undefined {
  const a = readStore().find((x) => x.id === id);
  return a && isAccountUsableFor(a, model, allowExtraUsage) ? a : undefined;
}

/** The raw account record, usable or not — for validating pins and telling a
 *  deleted account apart from an exhausted one. */
export function getAccountById(id: string): ClaudeAccount | undefined {
  return readStore().find((x) => x.id === id);
}

export function hasAccounts(): boolean {
  return readStore().length > 0;
}

export async function addAccount(
  name: string,
  token: string,
  owner?: string,
  credentialsPath?: string
): Promise<ClaudeAccountPublic | { error: string }> {
  const trimmedName = name.trim();
  // Strip ALL whitespace, not just the ends — a token copied from the
  // `claude setup-token` terminal output often arrives with line-wrap
  // newlines in the middle.
  const trimmedToken = token.replace(/\s+/g, "");
  const trimmedOwner = owner?.trim() || undefined;
  const trimmedCredentialsPath = credentialsPath?.trim() || undefined;
  if (!trimmedName) return { error: "Name is required" };
  if (!/^sk-ant-/.test(trimmedToken)) {
    return { error: "Token doesn't look like a Claude OAuth token (expected sk-ant-…). Generate one with `claude setup-token`." };
  }
  const accounts = readStore();
  if (accounts.some((a) => a.name === trimmedName)) {
    return { error: `An account named "${trimmedName}" already exists` };
  }
  if (accounts.some((a) => a.token === trimmedToken)) {
    return { error: "This token is already registered" };
  }

  // Best-effort validation via the usage endpoint. Only a 401 proves the
  // token is bad: `claude setup-token` tokens get a 403 here (no user:profile
  // scope) and the endpoint 429s aggressively — neither means the token can't
  // run Claude Code.
  const usage = await fetchUsage(trimmedToken, `add:${trimmedName}`);
  if (usage.errorStatus === 401) {
    return { error: `Token validation failed: ${usage.error}` };
  }
  if (usage.error) {
    console.warn(`[claude-accounts] Adding ${trimmedName} without usage validation: ${usage.error}`);
  }
  const profile = await fetchProfile(trimmedToken);

  const account: ClaudeAccount = {
    id: crypto.randomUUID(),
    name: trimmedName,
    token: trimmedToken,
    email: profile.email,
    plan: profile.plan,
    createdAt: new Date().toISOString(),
    ...(trimmedOwner ? { owner: trimmedOwner } : {}),
    ...(trimmedCredentialsPath ? { credentialsPath: trimmedCredentialsPath } : {}),
    ...(usage.errorStatus === 403 ? { usageScope: "missing" as const } : {}),
  };
  writeStore([...accounts, account]);
  if (!usage.error) usageCache.set(account.id, usage);
  console.log(
    `[claude-accounts] Added account ${trimmedName} (${profile.email || "unknown email"})${trimmedOwner ? ` — personal sub of ${trimmedOwner}` : " — shared pool"}`
  );
  return toPublic(account);
}

/** Set or clear (empty/undefined) an account's personal owner. */
export function setAccountOwner(
  id: string,
  owner: string | undefined,
  credentialsPath?: string | undefined
): ClaudeAccountPublic | null {
  const accounts = readStore();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const trimmed = owner?.trim() || undefined;
  const next = { ...accounts[idx] };
  if (trimmed) next.owner = trimmed;
  else delete next.owner;
  if (credentialsPath !== undefined) {
    const trimmedPath = credentialsPath.trim();
    if (trimmedPath) next.credentialsPath = trimmedPath;
    else delete next.credentialsPath;
    usageCache.delete(id);
    if (accounts[idx].credentialsPath) credentialsRefreshBlockedUntil.delete(accounts[idx].credentialsPath);
    if (trimmedPath) credentialsRefreshBlockedUntil.delete(trimmedPath);
  }
  accounts[idx] = next;
  writeStore(accounts);
  console.log(
    `[claude-accounts] ${next.name} is now ${trimmed ? `the personal sub of ${trimmed}` : "a shared pool account"}`
  );
  return toPublic(next);
}

export function removeAccount(id: string): boolean {
  const accounts = readStore();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  writeStore(next);
  usageCache.delete(id);
  exhaustedUntil.delete(id);
  for (const key of [...modelExhaustedUntil.keys()]) {
    if (key.startsWith(`${id}:`)) modelExhaustedUntil.delete(key);
  }
  return true;
}

/**
 * Pick the best account for a new run.
 *
 * Personal subs first: when `user` is set and owns accounts (matched through
 * the same identity table as commit attribution), the least-used of those
 * wins — the shared pool is their backup once the personal sub is exhausted
 * or sidelined. Runs with no `user` (automations) and users with no personal
 * sub draw from the pool (owner-less accounts) only; another user's personal
 * account is never eligible.
 *
 * Within each group: lowest cached 5-hour utilization wins, but accounts in
 * the same 10%-utilization bucket round-robin on least-recently-picked. (The
 * usage cache refreshes every poll interval, so without the tiebreak
 * concurrent runs between polls would all pile onto one account.) Returns
 * undefined when nothing eligible is configured or all of it is sidelined.
 */
export function pickAccount(
  exclude?: Set<string>,
  user?: string,
  model?: string,
  allowExtraUsage?: boolean
): ClaudeAccount | undefined {
  const eligible = readStore().filter(
    (a) => !exclude?.has(a.id) && isAccountUsableFor(a, model, allowExtraUsage)
  );
  const best = (list: ClaudeAccount[]): ClaudeAccount | undefined =>
    list
      .map((a) => ({
        a,
        bucket: Math.floor(accountUtilization(a, model) / 10),
        picked: lastPickedAt.get(a.id) ?? 0,
      }))
      // Credit-headroom accounts sort by their (high) utilization bucket, so
      // subscription capacity is always drained before paid credits.
      .filter(({ a, bucket }) => bucket * 10 < EXHAUSTED_UTILIZATION || (!!allowExtraUsage && hasCreditHeadroom(a)))
      .sort((x, y) => x.bucket - y.bucket || x.picked - y.picked)[0]?.a;
  const personal = user
    ? best(eligible.filter((a) => a.owner && userMatchesAny(user, [a.owner])))
    : undefined;
  const picked = personal ?? best(eligible.filter((a) => !a.owner));
  if (picked) lastPickedAt.set(picked.id, Date.now());
  return picked;
}

/**
 * The subset of the account store a specific run is allowed to see off-box —
 * used by the remote-sandbox launcher (src/server/sandbox/adapters/bootstrap.ts)
 * to upload a SCOPED pool file instead of the whole store: other people's
 * personal subscriptions must never land on third-party compute.
 *
 * Rules (mirrors pickAccount's personal-first/pool-fallback eligibility):
 *  - `accountId` pinned and usable by this run (shared pool account, or the
 *    run user's own personal account) → ONLY that account.
 *  - otherwise → every shared pool (owner-less) account, plus the run user's
 *    own personal accounts. Another user's personal account is never included;
 *    runs with no user (automations — refused sandboxing anyway) get pool only.
 */
export function accountsForRemoteUpload(user?: string, accountId?: string): ClaudeAccount[] {
  const allowed = (a: ClaudeAccount) => !a.owner || (!!user && userMatchesAny(user, [a.owner]));
  const all = readStore();
  if (accountId) {
    const pinned = all.find((a) => a.id === accountId);
    if (pinned && allowed(pinned)) return [pinned];
    // Pin missing or not this run's to use — fall through to the scoped set
    // (fail-closed: never widen to someone else's personal account).
  }
  return all.filter(allowed);
}

/** Test seam: inject a usage snapshot for an account (bun tests only). */
export function __setUsageCacheForTest(id: string, usage: AccountUsage): void {
  usageCache.set(id, usage);
}

/**
 * Sideline an account after a run hit its usage limit. Uses the 5-hour reset
 * time when known (refreshes usage in the background to confirm), otherwise a
 * fixed cool-off.
 */
export function markExhausted(id: string, model?: string): void {
  const account = readStore().find((a) => a.id === id);
  const cached = usageCache.get(id);
  const scoped =
    model && (model === "claude-fable-5" || model.toLowerCase().includes("fable"))
      ? cached?.scopedLimits?.find((l) => l.label.toLowerCase() === "fable")
      : undefined;
  const resetsAt = scoped?.resetsAt
    ? Date.parse(scoped.resetsAt)
    : cached?.fiveHour?.resetsAt
      ? Date.parse(cached.fiveHour.resetsAt)
      : NaN;
  const until = Number.isFinite(resetsAt) && resetsAt > Date.now()
    ? resetsAt
    : Date.now() + DEFAULT_EXHAUST_MS;
  if (scoped && model) modelExhaustedUntil.set(modelExhaustionKey(id, model), until);
  else exhaustedUntil.set(id, until);
  console.warn(
    `[claude-accounts] ${account?.name || id}${model ? ` (${model})` : ""} marked exhausted until ${new Date(until).toISOString()}`
  );
  if (account) void refreshAccountUsage(account);
}
