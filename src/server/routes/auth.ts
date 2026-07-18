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
  pollGithubDeviceFlow,
  removeGithubAccount,
  startGithubDeviceFlow,
} from "../github-auth";

export async function handleAuthRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;
	if (!path.startsWith("/backstage/api/auth/")) return undefined;

	if (path === "/backstage/api/auth/status" && req.method === "GET") {
		const identity = resolveWebAuth(req);
		return Response.json({
			required: webAuthRequired(),
			authenticated: !!identity,
			...(identity ? { login: identity.login, name: identity.name } : {}),
		});
	}

	if (path === "/backstage/api/auth/device" && req.method === "POST") {
		if (!webAuthRequired())
			return Response.json({ error: "Sign-in is not enabled" }, { status: 400 });
		const result = await startGithubDeviceFlow();
		if ("error" in result) return Response.json(result, { status: 400 });
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
		const result = await pollGithubDeviceFlow(deviceCode);
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
		return Response.json(
			{ status: "ok", login: result.login, name: session.name },
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
