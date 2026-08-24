/**
 * GitHub App installation tokens (server-to-server).
 *
 * An org-scoped fine-grained PAT can never read check runs: GitHub
 * doesn't offer the Checks permission on PATs at all (App-only). The org's
 * GitHub App (the same one behind per-user sign-in, github-auth.ts) has
 * checks:read, so this module mints short-lived installation access tokens
 * from its private key for the reads the PAT can't do (pr-info's
 * statusCheckRollup). Server-to-server tokens also have their own 5000/hr
 * rate-limit bucket, separate from the bot PAT's.
 *
 * Key file: ~/.opensession-github-app.pem (0600), override with
 * OPENSESSION_GITHUB_APP_KEY. No key file = feature off (getters return
 * null and callers keep their PAT behavior). The JWT issuer is the app
 * client id from the same config as github-auth.ts. Token + installation id
 * are cached on globalThis so hot reloads don't re-mint; tokens live 1h and
 * refresh 5 min early. Scoped to the app's single org installation:
 * same containment story as the App user tokens.
 */
import { createSign } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { githubUserAuthSettings } from "./github-auth";
import { configuredIntegration } from "./config";
import { githubGitCredentialEnv } from "./github-git-credential";
import { writeFileAtomic } from "./shared/atomic-write";
import {
  GITHUB_APP_READ_PERMISSIONS as READ_PERMISSIONS,
  GITHUB_APP_WRITE_PERMISSIONS as WRITE_PERMISSIONS,
} from "../shared/github-app-permissions";

let keyPathOverride: string | undefined;

function keyPath(): string {
  return keyPathOverride ||
    process.env.OPENSESSION_GITHUB_APP_KEY ||
    join(homedir(), ".opensession-github-app.pem");
}

/** Test seam: isolate key mutations from the operator's real key file. */
export function __setGithubAppKeyPathForTest(path: string | undefined): void {
  keyPathOverride = path;
}

type AppTokenCache = {
  token: string;
  expiresAt: number; // ms epoch
  installationId: number;
};

const g = globalThis as {
  // Cached per scope: a read-only token and a write token carry different
  // permission sets, so they cannot share a slot.
  __ghAppTokenCacheRead?: AppTokenCache | null;
  __ghAppTokenCacheWrite?: AppTokenCache | null;
  __ghAppTokenWarned?: boolean;
};

// READ_PERMISSIONS / WRITE_PERMISSIONS are the canonical sets imported at the
// top of the file (shared/github-app-permissions) — the same definition the
// create-app URL grants, so a mint never asks for a scope the App was not
// granted. Still installation-scoped, so an out-of-org write fails at GitHub's
// side just as the scoped bot PAT does (security-model.md, GitHub credential
// scoping). If the App does not hold a set the mint is rejected and the caller
// falls back to the PAT.

function appJwt(clientId: string, key: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
  return `${unsigned}.${sig}`;
}

/**
 * Installation access token for the app's (sole) installation, or null when
 * the app key/client id isn't configured or minting fails. Fail-soft: callers
 * fall back to the bot PAT.
 */
export async function githubAppInstallationToken(
  opts: { write?: boolean } = {},
): Promise<string | null> {
  const slot = opts.write ? "__ghAppTokenCacheWrite" : "__ghAppTokenCacheRead";
  const cached = g[slot];
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

  const { clientId } = githubUserAuthSettings();
  if (!clientId || !existsSync(keyPath())) return null;
  try {
    const key = await Bun.file(keyPath()).text();
    const jwt = appJwt(clientId, key);
    const headers = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" };

    const githubConfig = configuredIntegration("github");
    const configuredInstallationId =
      typeof githubConfig.installationId === "number"
        ? githubConfig.installationId
        : undefined;
    // Either cache slot can supply the installation id — it does not vary by scope.
    let installationId =
      configuredInstallationId ||
      g.__ghAppTokenCacheRead?.installationId ||
      g.__ghAppTokenCacheWrite?.installationId;
    if (!installationId) {
      const res = await fetch("https://api.github.com/app/installations", { headers });
      const installs = (await res.json()) as Array<{ id: number; account?: { login?: string } }>;
      if (!Array.isArray(installs) || !installs.length) throw new Error("no installations");
      // Prefer an explicit installation owner, then the org captured at setup
      // (appOrg) — the same precedence setup-team.ts uses. Without the appOrg
      // fallback, an org App installed on more than one account has no way to
      // disambiguate and falls back to the bot PAT even though appOrg already
      // names the intended owner.
      const owner = (
        [githubConfig.installationOwner, githubConfig.appOrg].find(
          (value): value is string => typeof value === "string" && !!value.trim(),
        ) ?? ""
      ).toLowerCase();
      const selected = owner
        ? installs.find((installation) => installation.account?.login?.toLowerCase() === owner)
        : installs.length === 1
          ? installs[0]
          : undefined;
      if (!selected) {
        throw new Error(
          owner
            ? `no GitHub App installation for ${owner}`
            : "multiple GitHub App installations; configure integrations.github.installationOwner",
        );
      }
      installationId = selected.id;
    }

    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          permissions: opts.write ? WRITE_PERMISSIONS : READ_PERMISSIONS,
        }),
      }
    );
    const tok = (await res.json()) as { token?: string; expires_at?: string };
    if (!tok.token) throw new Error(`mint failed: ${JSON.stringify(tok).slice(0, 120)}`);
    g[slot] = {
      token: tok.token,
      expiresAt: tok.expires_at ? Date.parse(tok.expires_at) : Date.now() + 55 * 60_000,
      installationId,
    };
    g.__ghAppTokenWarned = false;
    return tok.token;
  } catch (e) {
    if (!g.__ghAppTokenWarned) {
      g.__ghAppTokenWarned = true;
      console.warn(`[github-app] installation token unavailable: ${String(e).slice(0, 200)}`);
    }
    return null;
  }
}

/** The operator-controlled credential cutover. PAT remains the default so a
 * deploy cannot silently change the identity or permissions of live GitHub
 * operations. Selecting `app` is fail-closed: no hidden PAT fallback can mask a
 * broken App installation after the operator deliberately switches. */
export function githubBotCredentialMode(): "pat" | "app" {
  return configuredIntegration("github").botCredential === "app" ? "app" : "pat";
}

/** The selected GitHub credential for REST/GraphQL calls. */
export async function githubToken(
  opts: { write?: boolean } = {},
): Promise<string | null> {
  if (githubBotCredentialMode() === "app")
    return githubAppInstallationToken(opts);
  return process.env.GITHUB_API_TOKEN || null;
}

/** Whether the currently selected bot credential is configured. */
export function githubConfiguredCredential(): boolean {
  return githubBotCredentialMode() === "app"
    ? githubAppConfigured()
    : !!process.env.GITHUB_API_TOKEN;
}

/** Whether a GitHub App can mint installation tokens (client id + private key). */
export function githubAppConfigured(): boolean {
  return !!githubUserAuthSettings().clientId && existsSync(keyPath());
}

/** Persist the App's private key (0600) at the key path — the piece the device-flow
 *  setup never captured, so installation tokens (bot/agent, checks-read) could
 *  never mint. The App-manifest flow returns this PEM at creation. Drops any
 *  cached installation token, which belonged to a previous key. Honors the
 *  OPENSESSION_GITHUB_APP_KEY override so an ops-managed key is never clobbered. */
export function writeGithubAppKey(pem: string): void {
  if (process.env.OPENSESSION_GITHUB_APP_KEY)
    throw new Error("OPENSESSION_GITHUB_APP_KEY is set; not overwriting an ops-managed key");
  writeFileAtomic(keyPath(), pem.endsWith("\n") ? pem : `${pem}\n`, 0o600);
  g.__ghAppTokenCacheRead = null;
  g.__ghAppTokenCacheWrite = null;
}

/** Remove only a UI-managed key. An ops-managed path is external authority and
 * must never be mutated by the Settings removal flow. */
export function removeGithubAppKey(): void {
  // The App config may be UI-managed while its key path is ops-managed. In
  // that mixed mode, preserve the external file but still invalidate tokens.
  if (!process.env.OPENSESSION_GITHUB_APP_KEY)
    rmSync(keyPath(), { force: true });
  g.__ghAppTokenCacheRead = null;
  g.__ghAppTokenCacheWrite = null;
}

/** Keep the key and matching config mutation in one recoverable transaction.
 * `undefined` leaves the key alone, `null` removes it, and a string replaces
 * it. If the config commit fails, restore the exact prior key atomically. */
export async function commitGithubAppKeyMutation<T>(
  key: string | null | undefined,
  commitConfig: () => T | Promise<T>,
): Promise<T> {
  if (key === undefined || (key === null && process.env.OPENSESSION_GITHUB_APP_KEY)) {
    if (key === null) {
      g.__ghAppTokenCacheRead = null;
      g.__ghAppTokenCacheWrite = null;
    }
    return commitConfig();
  }
  if (key !== null && process.env.OPENSESSION_GITHUB_APP_KEY)
    throw new Error("OPENSESSION_GITHUB_APP_KEY is set; not overwriting an ops-managed key");

  const path = keyPath();
  const previous = existsSync(path) ? await Bun.file(path).text() : null;
  if (key === null) removeGithubAppKey();
  else writeGithubAppKey(key);
  try {
    return await commitConfig();
  } catch (error) {
    if (previous === null) rmSync(path, { force: true });
    else writeFileAtomic(path, previous, 0o600);
    g.__ghAppTokenCacheRead = null;
    g.__ghAppTokenCacheWrite = null;
    throw error;
  }
}

/**
 * A one-repository installation token for Runner workspace materialization.
 * It is intentionally separate from the read-only check token above: the
 * Runner receives it only in its one workspace_prepare frame and discards its
 * askpass helper immediately after git finishes. It is never persisted in a
 * session file, host spec, URL, transcript, or Runner registry.
 */
export async function githubAppRepositoryToken(ghRepo: string): Promise<string | null> {
  if (githubBotCredentialMode() !== "app") return null;
  const [owner, repo] = ghRepo.split("/");
  if (!owner || !repo || ghRepo.split("/").length !== 2) return null;
  // Resolve the installation id through the existing credential path. It keeps
  // installation selection in one place and may populate the shared cache.
  await githubAppInstallationToken();
  const installationId =
    g.__ghAppTokenCacheRead?.installationId || g.__ghAppTokenCacheWrite?.installationId;
  const { clientId } = githubUserAuthSettings();
  if (!installationId || !clientId || !existsSync(keyPath())) return null;
  try {
    const key = await Bun.file(keyPath()).text();
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appJwt(clientId, key)}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          repositories: [repo],
          permissions: {
            contents: "write",
            pull_requests: "write",
            metadata: "read",
          },
        }),
      },
    );
    const token = (await res.json()) as { token?: string; expires_at?: string };
    if (!res.ok || !token.token) throw new Error(`mint failed (${res.status})`);
    return token.token;
  } catch (error) {
    console.warn(`[github-app] repository token unavailable for ${owner}/${repo}: ${String(error).slice(0, 160)}`);
    return null;
  }
}

/**
 * Env overlay that makes `gh` authenticate with the installation token
 * (GH_TOKEN beats hosts.yml), or null when unavailable.
 */
export async function githubAppEnv(): Promise<Record<string, string> | null> {
  const token = await githubAppInstallationToken();
  return token ? { GH_TOKEN: token } : null;
}

/** Ephemeral Git + gh capability for one trusted GitHub code run. The token is
 * process-local and never written into Git config, URLs, session files, or the
 * run journal. */
export async function githubServiceCredentialEnv(
  ghRepo?: string,
): Promise<Record<string, string>> {
  const token =
    githubBotCredentialMode() === "app"
      ? ghRepo
        ? await githubAppRepositoryToken(ghRepo)
        : await githubAppInstallationToken({ write: true })
      : process.env.GITHUB_API_TOKEN || null;
  return token ? githubGitCredentialEnv(token) : {};
}
