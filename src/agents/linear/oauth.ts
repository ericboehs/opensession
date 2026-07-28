/**
 * Linear OAuth flow and token management.
 */
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import {
  configuredIntegration,
  configuredServer,
  personaName,
} from "../../server/config";

const LINEAR_CLIENT_ID = process.env.LINEAR_CLIENT_ID || "";
const LINEAR_CLIENT_SECRET = process.env.LINEAR_CLIENT_SECRET || "";
const TOKENS_FILE = `${process.env.HOME}/.linear-agent-tokens.json`;

function redirectUri(): string {
  const configured = configuredIntegration("linear").oauthRedirectUrl;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : `${configuredServer().publicBaseUrl.replace(/\/+$/, "")}/oauth/callback`;
}

export interface LinearTokens {
  [orgId: string]: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

export async function loadTokens(): Promise<LinearTokens> {
  try {
    const file = Bun.file(TOKENS_FILE);
    if (await file.exists()) {
      return JSON.parse(await file.text());
    }
    return {};
  } catch {
    return {};
  }
}

export async function saveTokens(tokens: LinearTokens): Promise<void> {
  writeJsonAtomic(TOKENS_FILE, tokens);
}

export async function refreshToken(orgId: string, tokens: LinearTokens): Promise<boolean> {
  const tokenData = tokens[orgId];
  if (!tokenData?.refreshToken) {
    console.error(`[linear] No refresh token for org: ${orgId}`);
    return false;
  }

  console.log(`[linear] Refreshing token for org: ${orgId}`);

  try {
    const response = await fetchWithTimeout("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: LINEAR_CLIENT_ID,
        client_secret: LINEAR_CLIENT_SECRET,
        refresh_token: tokenData.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data = await response.json();
    if (data.access_token) {
      tokens[orgId] = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || tokenData.refreshToken,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
      await saveTokens(tokens);
      console.log(`[linear] Token refreshed successfully for org: ${orgId}`);
      return true;
    } else {
      console.error(`[linear] Failed to refresh token:`, data);
      return false;
    }
  } catch (e) {
    console.error(`[linear] Error refreshing token:`, e);
    return false;
  }
}

export async function getValidToken(orgId: string, tokens: LinearTokens): Promise<string | null> {
  const tokenData = tokens[orgId];
  if (!tokenData) return null;

  const isExpired = tokenData.expiresAt && tokenData.expiresAt < Date.now() + 5 * 60 * 1000;
  if (isExpired) {
    const refreshed = await refreshToken(orgId, tokens);
    if (!refreshed) return null;
  }

  return tokens[orgId]?.accessToken || null;
}

export function handleAuthorize(): Response {
  const params = new URLSearchParams({
    client_id: LINEAR_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "app:assignable read write",
    actor: "app",
  });
  return Response.redirect(`https://linear.app/oauth/authorize?${params}`, 302);
}

export async function handleCallback(url: URL, tokens: LinearTokens): Promise<Response> {
  const code = url.searchParams.get("code");
  if (!code) {
    return new Response("Missing code", { status: 400 });
  }

  const response = await fetchWithTimeout("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: LINEAR_CLIENT_ID,
      client_secret: LINEAR_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json();
  if (data.access_token) {
    const orgResponse = await fetchWithTimeout("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.access_token}`,
      },
      body: JSON.stringify({ query: "{ organization { id name } }" }),
    });
    const orgData = await orgResponse.json();
    const orgId = orgData.data?.organization?.id;
    const orgName = orgData.data?.organization?.name;

    if (orgId) {
      tokens[orgId] = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
      await saveTokens(tokens);
      return new Response(
        `<html><body><h1>${personaName()} authorized for ${orgName}!</h1><p>I'm ready to receive assignments.</p></body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }
  }

  return new Response(`Authorization failed: ${JSON.stringify(data)}`, { status: 400 });
}
