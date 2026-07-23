/**
 * Claude subscription pool + Codex (OpenAI) account pool. Tokens only ever returned masked.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { addAccount, listAccountsPublic, refreshAllUsage, removeAccount, setAccountOwner } from "../claude-accounts";
import { addCodexAccount, listCodexAccountsPublic, removeCodexAccount, setCodexAccountOwner } from "../codex-accounts";

export async function handleAccountsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Claude account pool (tokens are never sent back, only masked) ──
	if (path === "/backstage/api/claude-accounts" && req.method === "GET") {
		return Response.json({ accounts: listAccountsPublic() });
	}

	if (path === "/backstage/api/claude-accounts" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body?.name || !body?.token) {
			return Response.json(
				{ error: "name and token are required" },
				{ status: 400 },
			);
		}
		const result = await addAccount(
			body.name,
			body.token,
			typeof body.owner === "string" ? body.owner : undefined,
			typeof body.credentialsPath === "string" ? body.credentialsPath : undefined,
		);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	if (
		path === "/backstage/api/claude-accounts/refresh" &&
		req.method === "POST"
	) {
		await refreshAllUsage();
		return Response.json({ accounts: listAccountsPublic() });
	}

	const accountDelMatch = path.match(
		/^\/backstage\/api\/claude-accounts\/([^/]+)$/,
	);
	if (accountDelMatch && req.method === "DELETE") {
		return removeAccount(decodeURIComponent(accountDelMatch[1]))
			? Response.json({ ok: true })
			: Response.json({ error: "Not found" }, { status: 404 });
	}
	// Set/clear an account's personal owner ({"owner": "Michiel"} or "").
	if (accountDelMatch && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		const updated = setAccountOwner(
			decodeURIComponent(accountDelMatch[1]),
			typeof body?.owner === "string" ? body.owner : undefined,
			typeof body?.credentialsPath === "string"
				? body.credentialsPath
				: undefined,
		);
		return updated
			? Response.json(updated)
			: Response.json({ error: "Not found" }, { status: 404 });
	}

	// ── Codex (OpenAI) account pool ──
	if (path === "/backstage/api/codex-accounts" && req.method === "GET") {
		return Response.json({ accounts: listCodexAccountsPublic() });
	}

	if (path === "/backstage/api/codex-accounts" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (
			!body?.name ||
			!body?.value ||
			!["api_key", "home"].includes(body?.kind)
		) {
			return Response.json(
				{ error: "name, kind (api_key|home) and value are required" },
				{ status: 400 },
			);
		}
		const result = addCodexAccount(
			body.name,
			body.kind,
			body.value,
			typeof body.owner === "string" ? body.owner : undefined,
		);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	const codexAccountDelMatch = path.match(
		/^\/backstage\/api\/codex-accounts\/([^/]+)$/,
	);
	if (codexAccountDelMatch && req.method === "DELETE") {
		return removeCodexAccount(decodeURIComponent(codexAccountDelMatch[1]))
			? Response.json({ ok: true })
			: Response.json({ error: "Not found" }, { status: 404 });
	}
	// Set/clear an account's personal owner ({"owner": "Michiel"} or "").
	if (codexAccountDelMatch && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		const updated = setCodexAccountOwner(
			decodeURIComponent(codexAccountDelMatch[1]),
			typeof body?.owner === "string" ? body.owner : undefined,
		);
		return updated
			? Response.json(updated)
			: Response.json({ error: "Not found" }, { status: 404 });
	}

	return undefined;
}
