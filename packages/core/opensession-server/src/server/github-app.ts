/**
 * GitHub App installation tokens (server-to-server).
 *
 * The tellahq-scoped fine-grained PAT can never read check runs — GitHub
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
 * refresh 5 min early. Scoped to the app's single tellahq installation —
 * same containment story as the App user tokens.
 */
import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { githubUserAuthSettings } from "./github-auth";
import { configuredIntegration } from "./config";

const KEY_PATH =
  process.env.OPENSESSION_GITHUB_APP_KEY || join(homedir(), ".opensession-github-app.pem");

type AppTokenCache = {
  token: string;
  expiresAt: number; // ms epoch
  installationId: number;
};

const g = globalThis as {
  __ghAppTokenCache?: AppTokenCache | null;
  __ghAppTokenWarned?: boolean;
};

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
export async function githubAppInstallationToken(): Promise<string | null> {
  const cached = g.__ghAppTokenCache;
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

  const { clientId } = githubUserAuthSettings();
  if (!clientId || !existsSync(KEY_PATH)) return null;
  try {
    const key = await Bun.file(KEY_PATH).text();
    const jwt = appJwt(clientId, key);
    const headers = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" };

    const githubConfig = configuredIntegration("github");
    const configuredInstallationId =
      typeof githubConfig.installationId === "number"
        ? githubConfig.installationId
        : undefined;
    let installationId = configuredInstallationId || cached?.installationId;
    if (!installationId) {
      const res = await fetch("https://api.github.com/app/installations", { headers });
      const installs = (await res.json()) as Array<{ id: number; account?: { login?: string } }>;
      if (!Array.isArray(installs) || !installs.length) throw new Error("no installations");
      const owner =
        typeof githubConfig.installationOwner === "string"
          ? githubConfig.installationOwner.toLowerCase()
          : "";
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

    // Downscoped at mint: pr-info only reads, so the token carries no write
    // permission at all — strictly weaker than the bot PAT even if leaked.
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          permissions: {
            checks: "read",
            statuses: "read",
            actions: "read",
            pull_requests: "read",
            contents: "read",
            issues: "read",
            metadata: "read",
          },
        }),
      }
    );
    const tok = (await res.json()) as { token?: string; expires_at?: string };
    if (!tok.token) throw new Error(`mint failed: ${JSON.stringify(tok).slice(0, 120)}`);
    g.__ghAppTokenCache = {
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

/**
 * A one-repository installation token for Runner workspace materialization.
 * It is intentionally separate from the read-only check token above: the
 * Runner receives it only in its one workspace_prepare frame and discards its
 * askpass helper immediately after git finishes. It is never persisted in a
 * session file, host spec, URL, transcript, or Runner registry.
 */
export async function githubAppRepositoryToken(ghRepo: string): Promise<string | null> {
  const [owner, repo] = ghRepo.split("/");
  if (!owner || !repo || ghRepo.split("/").length !== 2) return null;
  // Resolve the installation id through the existing credential path. It keeps
  // installation selection in one place and may populate the shared cache.
  await githubAppInstallationToken();
  const installationId = g.__ghAppTokenCache?.installationId;
  const { clientId } = githubUserAuthSettings();
  if (!installationId || !clientId || !existsSync(KEY_PATH)) return null;
  try {
    const key = await Bun.file(KEY_PATH).text();
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
