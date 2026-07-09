/**
 * OpenAI / ChatGPT-subscription auth for the opencode engine's `openai`
 * provider — the OpenAI analog of the meridian bridge (opencode-runner.ts)
 * that serves opencode/anthropic/* on Claude-subscription capacity. This wires
 * opencode/openai/* to our EXISTING ChatGPT-subscription auth (the codex
 * accounts pool, codex-accounts.ts).
 *
 * MECHANISM (chosen empirically 2026-07-08 against opencode 1.17.15): NATIVE.
 * opencode ships first-class ChatGPT-plan OAuth for its `openai` provider
 * (`opencode auth login` → "ChatGPT Pro/Plus"). It stores the credential in
 * its XDG data dir at `$XDG_DATA_HOME/opencode/auth.json` (fallback
 * ~/.local/share/opencode/auth.json) as:
 *
 *   { "openai": { "type":"oauth", "access":"<jwt>", "refresh":"<rt>",
 *                 "expires":<ms epoch>, "accountId":"<chatgpt account id>" } }
 *
 * and — critically — authenticates with the SAME OAuth client_id as the Codex
 * CLI (app_EMoamEEZ73f0CkXaXp7hrann) against the SAME token endpoint
 * (auth.openai.com/oauth/token), routing gpt-5.x turns to the ChatGPT backend
 * (chatgpt.com/backend-api/codex/responses) with the ChatGPT-Account-Id header.
 * So a Codex account's CODEX_HOME/auth.json tokens are DIRECTLY usable by
 * opencode with no format translation of the credential itself — we just
 * reshape the JSON. No plugin, no vendored community artifact, no fingerprint
 * spoofing. Verified live: `opencode run --model openai/gpt-5.4-mini` returned
 * "OK" on the pool ChatGPT (prolite/Plus) account with cost=0 — i.e. served on
 * the subscription, not API billing.
 *
 * ── ROTATION HAZARD & RESOLUTION (the trickiest correctness point) ──────────
 * OpenAI rotates refresh tokens on every successful refresh: the /oauth/token
 * response carries a NEW refresh_token and invalidates the old one. Both
 * codex-runner (through the codex CLI) and opencode refresh through the SAME
 * endpoint with the SAME client_id, so the refresh token is ONE rotating family
 * shared across both engines. If opencode ever performed a refresh it would
 * rotate that family and write the new token only into ITS auth.json — silently
 * invalidating the copy the legacy codex-runner still reads from
 * CODEX_HOME/auth.json, whose next refresh then 400s (the exact HTTP-400 death
 * recorded in project memory: "a copied .credentials snapshot dies after
 * rotation").
 *
 * We make that IMPOSSIBLE, not merely unlikely, by making CODEX_HOME the single
 * source of truth for refresh and opencode a READ-ONLY consumer of access
 * tokens:
 *   1. Seed opencode with the current ACCESS token ONLY (access tokens live
 *      ~10 days and codex itself keeps them fresh), its real expiry parsed from
 *      the JWT `exp`, and a deliberately-INVALID placeholder refresh token.
 *   2. Because the seeded access token is unexpired, opencode uses it directly
 *      and never refreshes (its provider only refreshes when access is missing
 *      or expires < now). If it ever did try (only after the access token has
 *      expired), the placeholder guarantees a loud 400 rather than a successful
 *      rotation that would corrupt CODEX_HOME.
 *   3. Re-seed from CODEX_HOME on every server spawn, so opencode always sees
 *      codex's current access token.
 * Net: opencode can NEVER rotate/invalidate the codex refresh token, so the
 * live codex CLI accounts (used by the legacy codex-runner) keep working
 * untouched. Trade-off, fail-loud not fail-corrupt: if a codex account goes
 * unused for ~10 days its access token expires and an opencode/openai run fails
 * with a clear "expired — run a codex turn to refresh" error until codex
 * refreshes it. We refuse to seed an already-expired token for the same reason.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Each account gets its own XDG_DATA_HOME
 * (~/.backstage-opencode/openai-data/<accountId>) so its auth.json — and
 * opencode's own session db — never share mutable state across accounts. The
 * runner folds XDG_DATA_HOME into the server's config/env identity hash, so a
 * different account respawns the server (never reuses another account's auth).
 * Caveat (documented, mirrors meridian's resume caveats): because opencode's
 * session db lives under the per-account data dir, a bks session that switches
 * OpenAI accounts across runs starts a FRESH opencode session rather than
 * resuming the old one. With the current single-account pool this never fires.
 *
 * ── API-KEY accounts ────────────────────────────────────────────────────────
 * codex accounts of kind "api_key" are a raw OpenAI platform key billed to the
 * org, not a subscription. For those we skip seeding entirely and hand opencode
 * the key via provider.openai.options.apiKey (normal api.openai.com billing).
 */

import { stateDir } from "./rename-compat";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { pickCodexAccount, listCodexAccounts, type CodexAccount } from "./codex-accounts";

const HOME = process.env.HOME || "/home/ubuntu";
const OPENAI_DATA_ROOT = `${stateDir("opencode")}/openai-data`;

/** Deliberately invalid refresh token seeded into opencode's auth.json: it
 *  MUST never hold a usable refresh token (see module header — a successful
 *  refresh would rotate the shared token family and kill CODEX_HOME). */
export const OPENCODE_OPENAI_PLACEHOLDER_REFRESH = "codex-managed-no-refresh";

export type OpenaiAuthMechanism = "oauth-subscription" | "api-key";

export interface OpenaiAccountBinding {
  account: CodexAccount;
  mechanism: OpenaiAuthMechanism;
  /** Extra env for the opencode serve process (XDG_DATA_HOME for oauth). */
  extraEnv: Record<string, string>;
  /** opencode `provider` config override (apiKey for api-key accounts). */
  providerOverride?: Record<string, unknown>;
}

/** ms-epoch expiry from a JWT's `exp` claim, or null if unparseable. */
function jwtExpMs(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Masked account label for audit events (never the raw token/path secret). */
export function maskOpenaiAccount(account: CodexAccount): string {
  return `${account.name} (${account.id.slice(0, 8)}, ${account.kind})`;
}

/**
 * Pick a codex account to serve an opencode/openai/* run. Mirrors
 * pickMeridianAccount's structure: an explicit override id list
 * (bridge.openaiAccounts in ~/.backstage-opencode.json) restricts to designated
 * accounts in list order; otherwise the normal codex pool pick
 * (least-recently-used, exhaustion-aware).
 *
 * NB: unlike the Claude pool, CodexAccount has no `owner` field today — every
 * codex account is a shared pool account, so there is no personal-vs-pool
 * distinction (and thus no "another user's personal account" to fail closed
 * against) to enforce here yet. If codex accounts gain owners, add the same
 * fail-closed owner filter pickMeridianAccount uses.
 */
export function pickOpenaiAccount(
  model: string,
  ids?: string[]
): CodexAccount | { error: string } {
  const all = listCodexAccounts();
  if (!all.length) {
    return {
      error:
        "no codex accounts configured — opencode/openai/* needs a ChatGPT-subscription " +
        "(kind: home) or API-key codex account (add one in Connections)",
    };
  }
  if (ids?.length) {
    for (const id of ids) {
      const a = all.find((x) => x.id === id);
      if (a) return a;
    }
    const known = ids.join(", ");
    return { error: `no designated openai account is configured (bridge.openaiAccounts: ${known})` };
  }
  const picked = pickCodexAccount(undefined, model);
  if (picked) return picked;
  return { error: "no usable codex account for opencode/openai (all currently sidelined)" };
}

/**
 * Does opencode itself hold a native `opencode auth login` openai credential
 * (the fallthrough the runner uses when no codex account is picked)? Checked
 * at the same XDG path opencode's server process will read, so a sandboxed
 * run — no host auth mounted — can fail with an honest named error instead
 * of opencode's bare "model not found" (the provider is simply omitted from
 * the generated config when there is no credential).
 */
export function opencodeHasNativeOpenaiAuth(): boolean {
  const base = process.env.XDG_DATA_HOME || `${HOME}/.local/share`;
  try {
    const j = JSON.parse(readFileSync(`${base}/opencode/auth.json`, "utf-8"));
    return !!j?.openai;
  } catch {
    return false;
  }
}

/**
 * Bind a picked codex account into opencode-serve env + provider config. For
 * "home" (ChatGPT subscription) accounts this seeds a per-account opencode
 * auth.json from CODEX_HOME/auth.json — access-token-only with a placeholder
 * refresh — and returns XDG_DATA_HOME isolation env. For "api_key" accounts it
 * returns a provider apiKey override and no seeding. Returns {error} (never
 * throws) so the runner can surface a clean error event.
 */
export function bindOpenaiAccount(account: CodexAccount): OpenaiAccountBinding | { error: string } {
  if (account.kind === "api_key") {
    return {
      account,
      mechanism: "api-key",
      extraEnv: {},
      providerOverride: { openai: { options: { apiKey: account.value } } },
    };
  }

  // kind === "home": seed opencode's per-account auth.json from CODEX_HOME.
  const srcPath = `${account.value}/auth.json`;
  if (!existsSync(srcPath)) {
    return {
      error: `codex account "${account.name}" has no auth.json at ${srcPath} — run \`CODEX_HOME=${account.value} codex login\` with a ChatGPT plan`,
    };
  }
  let src: any;
  try {
    src = JSON.parse(readFileSync(srcPath, "utf-8"));
  } catch (e: any) {
    return { error: `failed to read ${srcPath}: ${e?.message || e}` };
  }
  const access = src?.tokens?.access_token;
  const accountId = src?.tokens?.account_id;
  if (!access || typeof access !== "string") {
    return {
      error: `codex account "${account.name}" auth.json has no ChatGPT access_token (an API-key login? run \`codex login\` on a ChatGPT plan)`,
    };
  }
  const expMs = jwtExpMs(access);
  if (expMs !== null && expMs <= Date.now()) {
    return {
      error: `codex account "${account.name}" ChatGPT access token is expired — run a codex turn (or \`codex login\`) to refresh it, then retry`,
    };
  }

  const dataHome = `${OPENAI_DATA_ROOT}/${account.id}`;
  const authDir = `${dataHome}/opencode`;
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const seeded = {
    openai: {
      type: "oauth",
      access,
      // Placeholder, deliberately invalid — see module header.
      refresh: OPENCODE_OPENAI_PLACEHOLDER_REFRESH,
      expires: expMs ?? Date.now() + 3_600_000,
      ...(accountId ? { accountId } : {}),
    },
  };
  const outPath = `${authDir}/auth.json`;
  writeFileSync(outPath, JSON.stringify(seeded));
  chmodSync(outPath, 0o600);

  return { account, mechanism: "oauth-subscription", extraEnv: { XDG_DATA_HOME: dataHome } };
}
