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

const HOME = process.env.HOME || "/home/ubuntu";
const STORE_PATH = `${HOME}/.backstage-claude-accounts.json`;
// Keep this conservative: the usage endpoint rate-limits per token with
// ~hour-long lockouts (observed Retry-After of ~50m after 10-minute polling).
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
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
  // "missing" once the usage endpoint has returned 403 for this token
  // (`claude setup-token` tokens lack the user:profile scope). Persisted so
  // we never poll such accounts again, across restarts.
  usageScope?: "missing";
}

interface UsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface AccountUsage {
  fetchedAt: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
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
  usage: AccountUsage | null;
  noUsageScope: boolean;
  exhaustedUntil: string | null;
  usable: boolean;
}

const usageCache = new Map<string, AccountUsage>();
const exhaustedUntil = new Map<string, number>();
const lastPickedAt = new Map<string, number>();
// After a 429 from the usage endpoint, don't hit it again until this passes
// (429s carry Retry-After of up to ~1h, and blocked requests still count).
let usageRateLimitedUntil = 0;
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 10 * 60 * 1000;
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
  if (!existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch (e) {
    console.error("[claude-accounts] Failed to read store:", e);
    return [];
  }
}

function writeStore(accounts: ClaudeAccount[]): void {
  writeFileAtomic(STORE_PATH, JSON.stringify({ accounts }, null, 2) + "\n");
  chmodSync(STORE_PATH, 0o600);
}

export function maskToken(token: string): string {
  if (token.length <= 16) return "…";
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

async function fetchUsage(token: string): Promise<AccountUsage> {
  if (Date.now() < usageRateLimitedUntil) {
    return {
      fetchedAt: new Date().toISOString(),
      fiveHour: null,
      sevenDay: null,
      error: `usage endpoint rate-limited, retrying after ${new Date(usageRateLimitedUntil).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC`,
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
        usageRateLimitedUntil = Date.now() + waitMs;
        console.warn(`[claude-accounts] usage endpoint rate-limited; backing off ${Math.round(waitMs / 60000)}m`);
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
    return {
      fetchedAt: new Date().toISOString(),
      fiveHour: window(body.five_hour),
      sevenDay: window(body.seven_day),
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
  if (account.usageScope === "missing") return null;
  const cached = usageCache.get(account.id);

  const usage = await fetchUsage(account.token);
  if (usage.errorStatus === 403) {
    markUsageScopeMissing(account.id);
    usageCache.delete(account.id);
    return null;
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
    if (account.usageScope === "missing") continue;
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

function toPublic(a: ClaudeAccount): ClaudeAccountPublic {
  const usage = usageCache.get(a.id) || null;
  const until = exhaustedUntil.get(a.id);
  const fiveHour = usage?.fiveHour?.utilization;
  return {
    id: a.id,
    name: a.name,
    tokenMasked: maskToken(a.token),
    email: a.email,
    plan: a.plan,
    createdAt: a.createdAt,
    usage,
    noUsageScope: a.usageScope === "missing",
    exhaustedUntil: until !== undefined && until > Date.now() ? new Date(until).toISOString() : null,
    usable:
      !isExhausted(a.id) &&
      (fiveHour === null || fiveHour === undefined || fiveHour < EXHAUSTED_UTILIZATION),
  };
}

export function listAccountsPublic(): ClaudeAccountPublic[] {
  return readStore().map(toPublic);
}

export function hasAccounts(): boolean {
  return readStore().length > 0;
}

export async function addAccount(
  name: string,
  token: string
): Promise<ClaudeAccountPublic | { error: string }> {
  const trimmedName = name.trim();
  const trimmedToken = token.trim();
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
  const usage = await fetchUsage(trimmedToken);
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
    ...(usage.errorStatus === 403 ? { usageScope: "missing" as const } : {}),
  };
  writeStore([...accounts, account]);
  if (!usage.error) usageCache.set(account.id, usage);
  console.log(`[claude-accounts] Added account ${trimmedName} (${profile.email || "unknown email"})`);
  return toPublic(account);
}

export function removeAccount(id: string): boolean {
  const accounts = readStore();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  writeStore(next);
  usageCache.delete(id);
  exhaustedUntil.delete(id);
  return true;
}

/**
 * Pick the best account for a new run, spreading load across the pool:
 * lowest cached 5-hour utilization wins, but accounts within the same
 * 10%-utilization bucket round-robin on least-recently-picked. (The usage
 * cache refreshes every poll interval, so without the tiebreak concurrent
 * runs between polls would all pile onto one account.) Returns undefined
 * when no token accounts are configured or all are sidelined.
 */
export function pickAccount(exclude?: Set<string>): ClaudeAccount | undefined {
  const candidates = readStore().filter((a) => !exclude?.has(a.id) && !isExhausted(a.id));
  if (candidates.length === 0) return undefined;
  const picked = candidates
    .map((a) => ({
      a,
      bucket: Math.floor((usageCache.get(a.id)?.fiveHour?.utilization ?? 0) / 10),
      picked: lastPickedAt.get(a.id) ?? 0,
    }))
    .filter(({ bucket }) => bucket * 10 < EXHAUSTED_UTILIZATION)
    .sort((x, y) => x.bucket - y.bucket || x.picked - y.picked)[0]?.a;
  if (picked) lastPickedAt.set(picked.id, Date.now());
  return picked;
}

/**
 * Sideline an account after a run hit its usage limit. Uses the 5-hour reset
 * time when known (refreshes usage in the background to confirm), otherwise a
 * fixed cool-off.
 */
export function markExhausted(id: string): void {
  const account = readStore().find((a) => a.id === id);
  const cached = usageCache.get(id);
  const resetsAt = cached?.fiveHour?.resetsAt ? Date.parse(cached.fiveHour.resetsAt) : NaN;
  const until = Number.isFinite(resetsAt) && resetsAt > Date.now()
    ? resetsAt
    : Date.now() + DEFAULT_EXHAUST_MS;
  exhaustedUntil.set(id, until);
  console.warn(
    `[claude-accounts] ${account?.name || id} marked exhausted until ${new Date(until).toISOString()}`
  );
  if (account) void refreshAccountUsage(account);
}
