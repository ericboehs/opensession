/**
 * Connections: MCP servers (incl. per-user restriction), third-party model providers, the Plain triage-router config.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { getAgents } from "../agents-registry";
import { addMcpServer, getConnections, removeMcpServer, setMcpAllowedUsers } from "../connections";
import { refreshOpencodePickerModels } from "../models";
import { BRIDGE_PROVIDER_IDS, PROVIDER_ID_RE, addPickerModel, maskProviderKey, opencodeProviders, readOpencodeBridgeConfig, removeOpencodeProvider, removePickerModel, setOpencodeProvider } from "../opencode-config";

export async function handleConnectionsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Connections ──
	if (path === "/backstage/api/connections" && req.method === "GET") {
		const force = url.searchParams.get("refresh") === "1";
		const mcpServers = await getConnections(force);
		const agentHealth: Record<string, unknown> = {};
		for (const a of getAgents()) agentHealth[a.name] = a.health();
		return Response.json({ mcpServers, agents: agentHealth });
	}

	if (path === "/backstage/api/connections/mcp" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const result = addMcpServer(body);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	const mcpDelMatch = path.match(
		/^\/backstage\/api\/connections\/mcp\/([^/]+)$/,
	);
	if (mcpDelMatch && req.method === "DELETE") {
		const result = removeMcpServer(decodeURIComponent(mcpDelMatch[1]));
		if ("error" in result) return Response.json(result, { status: 404 });
		return Response.json(result);
	}

	// Restrict an existing MCP server to specific users (or clear the
	// restriction with an empty/absent list).
	if (mcpDelMatch && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		const allowedUsers = Array.isArray(body?.allowedUsers)
			? body.allowedUsers
			: undefined;
		const result = setMcpAllowedUsers(
			decodeURIComponent(mcpDelMatch[1]),
			allowedUsers,
		);
		if ("error" in result) return Response.json(result, { status: 404 });
		return Response.json(result);
	}

	// ── Model providers (Settings → Model providers) ──
	// Third-party OpenCode providers (xai, openrouter, groq, …): API key +
	// optional baseURL in ~/.opensession-opencode.json (0600, keys only ever
	// returned masked), plus their picker model ids. anthropic/openai are
	// rejected — they run on the subscription bridges, not raw keys.
	if (
		path === "/backstage/api/settings/model-providers" &&
		req.method === "GET"
	) {
		const pickerModels = readOpencodeBridgeConfig()?.pickerModels || [];
		return Response.json({
			providers: Object.entries(opencodeProviders()).map(([id, p]) => ({
				id,
				apiKeyMasked: maskProviderKey(p.apiKey),
				...(p.baseURL ? { baseURL: p.baseURL } : {}),
				models: pickerModels.filter((m) =>
					m.startsWith(`opencode/${id}/`),
				),
			})),
			pickerModels,
		});
	}

	const modelProviderMatch = path.match(
		/^\/backstage\/api\/settings\/model-providers\/([^/]+)$/,
	);
	if (modelProviderMatch && req.method === "PUT") {
		const id = decodeURIComponent(modelProviderMatch[1]);
		if (!PROVIDER_ID_RE.test(id)) {
			return Response.json(
				{
					error:
						"Provider id must be lowercase letters, digits and dashes (e.g. xai, openrouter)",
				},
				{ status: 400 },
			);
		}
		if (BRIDGE_PROVIDER_IDS.has(id)) {
			return Response.json(
				{
					error: `"${id}" runs on the subscription bridges (Settings → Models), not a raw API key`,
				},
				{ status: 400 },
			);
		}
		const body = await req.json().catch(() => null);
		if (!body || typeof body !== "object") {
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		}
		const apiKey =
			typeof body.apiKey === "string"
				? // Strip all whitespace — pasted keys often carry line-wrap newlines.
					body.apiKey.replace(/\s+/g, "")
				: undefined;
		const baseURL =
			typeof body.baseURL === "string" ? body.baseURL.trim() : undefined;
		const models = Array.isArray(body.models)
			? body.models.filter(
					(m: unknown): m is string => typeof m === "string",
				)
			: undefined;
		try {
			setOpencodeProvider(id, { apiKey, baseURL });
			if (models) {
				// `models` replaces this provider's picker entries wholesale.
				const prefix = `opencode/${id}/`;
				for (const m of readOpencodeBridgeConfig()?.pickerModels || []) {
					if (m.startsWith(prefix)) removePickerModel(m);
				}
				for (const m of models) {
					// Accept "grok-4", "xai/grok-4" or "opencode/xai/grok-4".
					let tail = m.trim();
					if (tail.startsWith("opencode/"))
						tail = tail.slice("opencode/".length);
					if (tail.startsWith(`${id}/`)) tail = tail.slice(id.length + 1);
					if (tail) addPickerModel(`${prefix}${tail}`);
				}
			}
			refreshOpencodePickerModels();
			const stored = opencodeProviders()[id] || {};
			const pickerModels = readOpencodeBridgeConfig()?.pickerModels || [];
			return Response.json({
				provider: {
					id,
					apiKeyMasked: maskProviderKey(stored.apiKey),
					...(stored.baseURL ? { baseURL: stored.baseURL } : {}),
					models: pickerModels.filter((m) =>
						m.startsWith(`opencode/${id}/`),
					),
				},
			});
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to save provider" },
				{ status: 400 },
			);
		}
	}

	if (modelProviderMatch && req.method === "DELETE") {
		const id = decodeURIComponent(modelProviderMatch[1]);
		try {
			const removed = removeOpencodeProvider(id);
			const prefix = `opencode/${id}/`;
			let cleared = 0;
			for (const m of readOpencodeBridgeConfig()?.pickerModels || []) {
				if (m.startsWith(prefix)) {
					removePickerModel(m);
					cleared++;
				}
			}
			refreshOpencodePickerModels();
			if (!removed && !cleared) {
				return Response.json({ error: "Not found" }, { status: 404 });
			}
			return Response.json({ ok: true });
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to remove provider" },
				{ status: 500 },
			);
		}
	}

	// ── GitHub user auth (PRs as the session owner, opt-in via config) ──
	// Device-flow connect per teammate; tokens live server-side (0600) and are
	// never returned here. See src/server/github-auth.ts.
	if (path === "/backstage/api/connections/github" && req.method === "GET") {
		const { githubUserAuthSettings, connectedGithubAccounts } = await import(
			"../github-auth"
		);
		const { configuredIdentity } = await import("../config");
		const settings = githubUserAuthSettings();
		const accounts = connectedGithubAccounts();
		const connected = new Set(accounts.map((a) => a.login.toLowerCase()));
		return Response.json({
			enabled: settings.enabled,
			clientIdConfigured: !!settings.clientId,
			accounts,
			team: configuredIdentity()
				.team.filter((m) => m.github)
				.map((m) => ({
					name: m.name,
					github: m.github,
					connected: connected.has(m.github!.toLowerCase()),
				})),
		});
	}

	if (
		path === "/backstage/api/connections/github/device" &&
		req.method === "POST"
	) {
		const { startGithubDeviceFlow } = await import("../github-auth");
		const result = await startGithubDeviceFlow();
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	if (
		path === "/backstage/api/connections/github/device/poll" &&
		req.method === "POST"
	) {
		const body = await req.json().catch(() => null);
		const deviceCode =
			typeof body?.deviceCode === "string" ? body.deviceCode : "";
		if (!deviceCode)
			return Response.json({ error: "deviceCode required" }, { status: 400 });
		const { pollGithubDeviceFlow } = await import("../github-auth");
		return Response.json(await pollGithubDeviceFlow(deviceCode));
	}

	const ghAccountMatch = path.match(
		/^\/backstage\/api\/connections\/github\/account\/([^/]+)$/,
	);
	if (ghAccountMatch && req.method === "DELETE") {
		const { removeGithubAccount } = await import("../github-auth");
		const removed = removeGithubAccount(decodeURIComponent(ghAccountMatch[1]));
		if (!removed)
			return Response.json({ error: "Not connected" }, { status: 404 });
		return Response.json({ ok: true });
	}

	// ── Plain triage router (spam gate + model routing for new tickets) ──
	// The prompt is editable so routing can be tweaked without a deploy;
	// the JSON output contract is appended in code and can't be broken here.
	if (
		path === "/backstage/api/connections/plain-router" &&
		req.method === "GET"
	) {
		const { getRouterConfig, DEFAULT_ROUTER_PROMPT, DEFAULT_BASIC_MODEL } =
			await import("../../agents/plain/ticket-router");
		return Response.json({
			...getRouterConfig(),
			defaultPrompt: DEFAULT_ROUTER_PROMPT,
			defaultBasicModel: DEFAULT_BASIC_MODEL,
		});
	}

	if (
		path === "/backstage/api/connections/plain-router" &&
		req.method === "PUT"
	) {
		const body = (await req.json().catch(() => null)) as {
			prompt?: string;
			basicModel?: string;
		} | null;
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const { setRouterConfig } = await import(
			"../../agents/plain/ticket-router"
		);
		const result = setRouterConfig(body);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	return undefined;
}
