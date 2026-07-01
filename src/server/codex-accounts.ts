/**
 * Codex account pool for backstage runs — the OpenAI-side sibling of
 * claude-accounts.ts.
 *
 * Two credential kinds:
 *  - "api_key": an OpenAI API key, injected via the SDK's `apiKey` option
 *    (usage billed to the platform org).
 *  - "home": a CODEX_HOME directory containing an auth.json from
 *    `codex login` on a ChatGPT plan. Runs get CODEX_HOME pointed at it, so
 *    each account keeps its own auth/refresh state. The VPS's own login at
 *    ~/.codex stays untouched unless no accounts are configured, in which
 *    case runs fall back to it.
 *
 * There's no public usage endpoint for Codex plans, so unlike the Claude pool
 * there's no utilization polling — rotation is least-recently-picked, with
 * accounts sidelined for a cool-off when a run hits a rate/usage limit.
 */

import { chmodSync, existsSync, readFileSync, readdirSync } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";

const HOME = process.env.HOME || "/home/ubuntu";
const STORE_PATH = `${HOME}/.backstage-codex-accounts.json`;
const DEFAULT_EXHAUST_MS = 60 * 60 * 1000;

export interface CodexAccount {
  id: string;
  name: string;
  kind: "api_key" | "home";
  /** API key (kind=api_key) or CODEX_HOME directory path (kind=home). */
  value: string;
  createdAt: string;
}

export interface CodexAccountPublic {
  id: string;
  name: string;
  kind: "api_key" | "home";
  valueMasked: string;
  createdAt: string;
  exhaustedUntil: string | null;
  usable: boolean;
}

const exhaustedUntil = new Map<string, number>();
const lastPickedAt = new Map<string, number>();

function readStore(): CodexAccount[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch (e) {
    console.error("[codex-accounts] Failed to read store:", e);
    return [];
  }
}

function writeStore(accounts: CodexAccount[]): void {
  writeFileAtomic(STORE_PATH, JSON.stringify({ accounts }, null, 2) + "\n");
  chmodSync(STORE_PATH, 0o600);
}

function maskValue(account: CodexAccount): string {
  if (account.kind === "home") return account.value; // a path, not a secret
  const v = account.value;
  if (v.length <= 12) return "…";
  return `${v.slice(0, 8)}…${v.slice(-4)}`;
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

function toPublic(a: CodexAccount): CodexAccountPublic {
  const until = exhaustedUntil.get(a.id);
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    valueMasked: maskValue(a),
    createdAt: a.createdAt,
    exhaustedUntil: until !== undefined && until > Date.now() ? new Date(until).toISOString() : null,
    usable: !isExhausted(a.id),
  };
}

export function listCodexAccountsPublic(): CodexAccountPublic[] {
  return readStore().map(toPublic);
}

export function hasCodexAccounts(): boolean {
  return readStore().length > 0;
}

export function addCodexAccount(
  name: string,
  kind: "api_key" | "home",
  value: string
): CodexAccountPublic | { error: string } {
  const trimmedName = name.trim();
  const trimmedValue = value.trim();
  if (!trimmedName) return { error: "Name is required" };
  if (!trimmedValue) return { error: "Value is required" };

  if (kind === "api_key" && !/^sk-/.test(trimmedValue)) {
    return { error: "API key doesn't look like an OpenAI key (expected sk-…)." };
  }
  if (kind === "home") {
    if (!existsSync(`${trimmedValue}/auth.json`)) {
      return {
        error:
          `No auth.json found in "${trimmedValue}". Run \`CODEX_HOME=${trimmedValue} codex login\` ` +
          "on the VPS first (or copy an existing ~/.codex/auth.json into it).",
      };
    }
  }

  const accounts = readStore();
  if (accounts.some((a) => a.name === trimmedName)) {
    return { error: `An account named "${trimmedName}" already exists` };
  }
  if (accounts.some((a) => a.value === trimmedValue)) {
    return { error: "This credential is already registered" };
  }

  const account: CodexAccount = {
    id: crypto.randomUUID(),
    name: trimmedName,
    kind,
    value: trimmedValue,
    createdAt: new Date().toISOString(),
  };
  writeStore([...accounts, account]);
  console.log(`[codex-accounts] Added ${kind} account ${trimmedName}`);
  return toPublic(account);
}

export function removeCodexAccount(id: string): boolean {
  const accounts = readStore();
  const next = accounts.filter((a) => a.id !== id);
  if (next.length === accounts.length) return false;
  writeStore(next);
  exhaustedUntil.delete(id);
  lastPickedAt.delete(id);
  return true;
}

/**
 * Pick an account for a new run: least-recently-picked among the non-sidelined.
 * Returns undefined when none are configured/usable — the run then falls back
 * to the VPS's own ~/.codex login.
 */
export function pickCodexAccount(exclude?: Set<string>): CodexAccount | undefined {
  const candidates = readStore().filter((a) => !exclude?.has(a.id) && !isExhausted(a.id));
  if (candidates.length === 0) return undefined;
  const picked = candidates
    .map((a) => ({ a, picked: lastPickedAt.get(a.id) ?? 0 }))
    .sort((x, y) => x.picked - y.picked)[0].a;
  lastPickedAt.set(picked.id, Date.now());
  return picked;
}

/** All configured accounts (with secrets — server-side use only). */
export function listCodexAccounts(): CodexAccount[] {
  return readStore();
}

/**
 * Every CODEX_HOME where threads may live: the VPS's own ~/.codex (used by
 * api_key accounts and account-less runs) plus each home-kind account dir.
 */
export function codexHomes(): Array<{ home: string; account?: CodexAccount }> {
  const out: Array<{ home: string; account?: CodexAccount }> = [
    { home: `${HOME}/.codex` },
  ];
  for (const a of readStore()) {
    if (a.kind === "home") out.push({ home: a.value, account: a });
  }
  return out;
}

/** uuidv7 thread ids encode their creation time in the first 48 bits. */
function uuidv7Ms(id: string): number | null {
  const hex = id.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  return parseInt(hex, 16);
}

/**
 * Locate a thread's rollout jsonl (sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl)
 * across all CODEX_HOMEs, and which account owns it. Checks the uuidv7-derived
 * day ± 1 to be safe around midnight.
 */
export function findCodexRollout(
  threadId: string
): { path: string; account?: CodexAccount } | null {
  const ms = uuidv7Ms(threadId);
  if (!ms) return null;
  const days: string[] = [];
  for (const delta of [0, -1, 1]) {
    const d = new Date(ms + delta * 86_400_000);
    days.push(
      `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`
    );
  }
  for (const { home, account } of codexHomes()) {
    for (const day of days) {
      const dir = `${home}/sessions/${day}`;
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (f.endsWith(`-${threadId}.jsonl`)) return { path: `${dir}/${f}`, account };
        }
      } catch {}
    }
  }
  return null;
}

/** Sideline an account after a run hit a rate/usage limit. */
export function markCodexExhausted(id: string): void {
  const account = readStore().find((a) => a.id === id);
  const until = Date.now() + DEFAULT_EXHAUST_MS;
  exhaustedUntil.set(id, until);
  console.warn(
    `[codex-accounts] ${account?.name || id} marked exhausted until ${new Date(until).toISOString()}`
  );
}
