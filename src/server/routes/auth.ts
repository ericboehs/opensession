/**
 * Web sign-in routes (GitHub device flow → HttpOnly session cookie). These
 * are the ONLY /backstage/api/* routes exempt from the sign-in gate in
 * opensession.ts — they're how a signed-out browser gets in. Active only
 * when per-user GitHub auth is opted in (web-auth.ts / github-auth.ts);
 * otherwise /auth/status just reports `required: false` and the UI keeps
 * the local name picker.
 */

import type { RouteContext } from "./context";
import {
  createWebSession,
  destroyWebSession,
  resolveWebAuth,
  teamMemberForLogin,
  webAuthClearCookie,
  webAuthRequired,
  webAuthSetCookie,
  webAuthToken,
} from "../web-auth";
import {
  exchangeGithubOauthCode,
  githubAuthorizeUrl,
  githubDeviceFlowResult,
  githubRedirectFlowAvailable,
  pollGithubDeviceFlow,
  removeGithubAccount,
  startGithubDeviceFlow,
  watchGithubDeviceFlow,
} from "../github-auth";
import { configuredServer } from "../config";
import { randomBytes } from "crypto";
import { isLocalProfile, localProfileLogin, localProfileUser } from "../profile";

const STATE_COOKIE = "opensession_oauth_state";

function cookieValue(req: Request, name: string): string | null {
	const cookie = req.headers.get("cookie");
	if (!cookie) return null;
	for (const part of cookie.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name && v.length) return v.join("=");
	}
	return null;
}

/** The redirect_uri — must literally match the OAuth app's registered
 *  callback URL (publicBaseUrl is prefix-less, e.g.
 *  https://os.tella.dev/api/auth/callback). */
function callbackUri(): string {
	return `${configuredServer().publicBaseUrl.replace(/\/$/, "")}/api/auth/callback`;
}

export async function handleAuthRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;
	if (!path.startsWith("/backstage/api/auth/")) return undefined;

	if (path === "/backstage/api/auth/status" && req.method === "GET") {
		if (isLocalProfile()) {
			const login = localProfileLogin();
			const name = localProfileUser();
			return Response.json({
				required: true,
				authenticated: !!login && !!name,
				local: true,
				...(login && name ? { login, name } : {}),
			});
		}
		const identity = resolveWebAuth(req);
		return Response.json({
			required: webAuthRequired(),
			authenticated: !!identity,
			/** Redirect (authorization-code) flow available — the UI's primary
			 *  sign-in when true; device flow is always there as fallback. */
			redirect: githubRedirectFlowAvailable(),
			...(identity ? { login: identity.login, name: identity.name } : {}),
		});
	}

	// ── Redirect (authorization-code) flow ──
	// GET /api/auth/login → 302 to GitHub authorize, with a CSRF state nonce
	// mirrored in a short-lived cookie. GET /api/auth/callback comes back with
	// ?code&state → exchange (client secret), team gate, session cookie, and a
	// redirect into the app. Sign-in errors land on /?auth_error=… so the
	// sign-in screen can show them.
	if (path === "/backstage/api/auth/login" && req.method === "GET") {
		if (!githubRedirectFlowAvailable())
			return Response.json(
				{ error: "Redirect sign-in is not configured" },
				{ status: 400 },
			);
		const state = randomBytes(16).toString("hex");
		const authorize = githubAuthorizeUrl(callbackUri(), state);
		if (!authorize)
			return Response.json({ error: "Sign-in is not enabled" }, { status: 400 });
		return new Response(null, {
			status: 302,
			headers: {
				Location: authorize,
				"Set-Cookie": `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
			},
		});
	}

	if (path === "/backstage/api/auth/callback" && req.method === "GET") {
		const fail = (msg: string) =>
			new Response(null, {
				status: 302,
				headers: {
					Location: `/?auth_error=${encodeURIComponent(msg)}`,
					"Set-Cookie": `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
				},
			});
		if (!githubRedirectFlowAvailable())
			return fail("Redirect sign-in is not configured");
		const code = ctx.url.searchParams.get("code");
		const state = ctx.url.searchParams.get("state");
		const expected = cookieValue(req, STATE_COOKIE);
		if (!code) return fail(ctx.url.searchParams.get("error_description") || "GitHub returned no code");
		if (!state || !expected || state !== expected)
			return fail("State mismatch — start the sign-in again");
		const result = await exchangeGithubOauthCode(code, callbackUri());
		if (result.status !== "ok")
			return fail(result.status === "error" ? result.error : "Sign-in did not complete");
		if (!teamMemberForLogin(result.login)) {
			removeGithubAccount(result.login);
			return fail(
				`GitHub account @${result.login} is not on the configured team`,
			);
		}
		const session = createWebSession(result.login);
		if (!session) return fail("Could not create a session");
		const headers = new Headers({ Location: "/" });
		headers.append("Set-Cookie", webAuthSetCookie(session.token));
		headers.append(
			"Set-Cookie",
			`${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
		);
		return new Response(null, { status: 302, headers });
	}

	if (path === "/backstage/api/auth/device" && req.method === "POST") {
		if (!webAuthRequired())
			return Response.json({ error: "Sign-in is not enabled" }, { status: 400 });
		const result = await startGithubDeviceFlow();
		if ("error" in result) return Response.json(result, { status: 400 });
		// The server polls GitHub to completion itself — mobile clients get
		// suspended/killed while the code is entered in Safari, so their own
		// poll loop can't be trusted to survive to the finish.
		watchGithubDeviceFlow(result);
		return Response.json(result);
	}

	// One poll of the device flow. On success this BOTH connects the person's
	// PR token (github-auth store) and signs the browser in (session cookie) —
	// one authorize covers both. Non-team logins are rejected and their token
	// discarded.
	if (path === "/backstage/api/auth/device/poll" && req.method === "POST") {
		if (!webAuthRequired())
			return Response.json({ error: "Sign-in is not enabled" }, { status: 400 });
		const body = await req.json().catch(() => null);
		const deviceCode =
			typeof body?.deviceCode === "string" ? body.deviceCode : "";
		if (!deviceCode)
			return Response.json({ error: "deviceCode required" }, { status: 400 });
		// Prefer the server-watched outcome (idempotent — a client whose
		// earlier response got lost to an app suspension just asks again).
		// Direct GitHub polling remains as fallback for flows started before
		// server-side watching existed (e.g. across a process restart).
		const watched = githubDeviceFlowResult(deviceCode);
		console.log(
			`[auth] device/poll …${deviceCode.slice(-6)} → ${watched?.status ?? "unwatched"} (ua: ${req.headers.get("user-agent") ?? "?"})`,
		);
		let result: Awaited<ReturnType<typeof pollGithubDeviceFlow>>;
		if (watched && watched.status === "pending") {
			return Response.json({ status: "pending" });
		} else if (watched && watched.status === "error") {
			return Response.json(watched);
		} else if (watched) {
			result = { status: "ok", login: watched.login, name: watched.name };
		} else {
			result = await pollGithubDeviceFlow(deviceCode);
		}
		if (result.status !== "ok") return Response.json(result);
		if (!teamMemberForLogin(result.login)) {
			removeGithubAccount(result.login);
			return Response.json({
				status: "error",
				error: `GitHub account @${result.login} is not on the configured team (identity.team)`,
			});
		}
		const session = createWebSession(result.login);
		if (!session)
			return Response.json(
				{ status: "error", error: "Could not create a session" },
				{ status: 500 },
			);
		// Native clients (iOS app) can't use the HttpOnly cookie — they ask for
		// the token in the body (`native: true`) and store it in the keychain,
		// sending it back as `Authorization: Bearer`.
		const native = body?.native === true;
		console.log(
			`[auth] device-flow session delivered to ${native ? "native" : "web"} client for @${result.login}`,
		);
		return Response.json(
			{
				status: "ok",
				login: result.login,
				name: session.name,
				...(native ? { token: session.token } : {}),
			},
			{ headers: { "Set-Cookie": webAuthSetCookie(session.token) } },
		);
	}

	if (path === "/backstage/api/auth/logout" && req.method === "POST") {
		const token = webAuthToken(req);
		if (token) destroyWebSession(token);
		return Response.json(
			{ ok: true },
			{ headers: { "Set-Cookie": webAuthClearCookie() } },
		);
	}

	return undefined;
}
