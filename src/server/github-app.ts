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

const KEY_PATH =
  process.env.OPENSESSION_GITHUB_APP_KEY || join(homedir(), ".opensession-github-app.pem");

type AppTokenCache = {
  token: string;
  expiresAt: number; // ms epoch
  installationId: number;
};

const g = globalThis as { __ghAppTokenCache?: AppTokenCache | null; __ghAppTokenWarned?: boolean };

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

    let installationId = cached?.installationId;
    if (!installationId) {
      const res = await fetch("https://api.github.com/app/installations", { headers });
      const installs = (await res.json()) as Array<{ id: number }>;
      if (!Array.isArray(installs) || !installs.length) throw new Error("no installations");
      installationId = installs[0].id;
    }

    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: "POST", headers }
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
 * Env overlay that makes `gh` authenticate with the installation token
 * (GH_TOKEN beats hosts.yml), or null when unavailable.
 */
export async function githubAppEnv(): Promise<Record<string, string> | null> {
  const token = await githubAppInstallationToken();
  return token ? { GH_TOKEN: token } : null;
}
