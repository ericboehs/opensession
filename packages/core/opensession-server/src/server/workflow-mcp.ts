/**
 * Workflow MCP host — the tool half of code mode.
 *
 * A workflow script fans out agent() calls (a full model turn each). Most of
 * what those agents actually do is one MCP call: query Prometheus, read a
 * Plain thread, list Linear issues. This module lets the SCRIPT make those
 * calls directly, so a 40-lookup fan-out costs 40 function calls instead of 40
 * model turns, and only the reduced result re-enters the conversation.
 *
 * One host per workflow run: clients connect lazily per server (first call
 * pays the handshake), are cached for the run's lifetime, and are closed by
 * close() when the run finishes — a stdio server is a child process, so a
 * leaked client is a leaked process. Concurrency, journaling and replay live
 * in workflow-runner.ts; this module is transport + policy only.
 *
 * POLICY (fail-closed, mirrors the engine's run policy — see runner-shared.ts
 * and opencodeRunPolicy):
 *  - the surface starts as filterMcpServers(allowlist, user): an automation's
 *    least-privilege allowlist and the per-user `allowedUsers` gate both apply,
 *    exactly as they would for the run's own tools;
 *  - servers carrying money-moving confirm tools (Stripe) are dropped WHOLE.
 *    A script executes without any per-call approval bridge, so a confirm-gated
 *    tool must never be reachable from one;
 *  - deniedTools (automation runs: Plain customer-facing writes, WorkOS
 *    identity mutation) are refused per call.
 * A script can therefore never reach a tool the run that authored it couldn't.
 */

import { homeDir } from "./paths";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readFileSync } from "fs";
import { filterMcpServers, STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { WORKFLOW_LIMITS } from "./workflow-types";

const HOME = homeDir();

/** Servers dropped wholesale: any server owning a confirm-gated (money-moving)
 *  tool. Derived from the catalog so adding a tool there closes the hole here
 *  too — `mcp__stripe__create_refund` → `stripe`. */
function confirmGatedServers(): Set<string> {
	const out = new Set<string>();
	for (const id of Object.keys(STRIPE_CONFIRM_TOOLS)) {
		const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(id);
		if (m) out.add(m[1]);
	}
	return out;
}

/**
 * Bearer token minted by `opencode mcp auth <server>` for OAuth-only HTTP
 * servers (the config carries no header for those — see the circle entry).
 * Best-effort: a missing/failed lookup just means the call 401s with the
 * server's own message.
 */
function opencodeAuthHeader(server: string): Record<string, string> | undefined {
	try {
		const store = JSON.parse(
			readFileSync(`${HOME}/.local/share/opencode/mcp-auth.json`, "utf-8"),
		) as Record<string, { tokens?: { accessToken?: string } }>;
		const token = store?.[server]?.tokens?.accessToken;
		if (token) return { Authorization: `Bearer ${token}` };
	} catch {}
	return undefined;
}

export interface WorkflowMcpTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface WorkflowMcpHostOpts {
	/** The automation's MCP allowlist; omitted = every server the user may see. */
	allowlist?: string[];
	/** The run's user — drives the per-server `allowedUsers` gate. */
	user?: string;
	/** Per-call denials (automation runs). Keys are `mcp__<server>__<tool>`. */
	deniedTools?: Record<string, string>;
	/** Test-only: stand in for the resolved mcp-config surface. Production
	 *  callers never set this — the real surface comes from filterMcpServers,
	 *  so allowlist/allowedUsers gating can't be bypassed by a caller. */
	configuredForTest?: Record<string, unknown>;
}

/**
 * The server surface a workflow script may call: whatever the run itself may
 * use, minus every server owning a confirm-gated tool. Pure — the caller
 * supplies the already-user-filtered config.
 */
export function workflowMcpServers(
	configured: Record<string, unknown>,
): Record<string, unknown> {
	const gated = confirmGatedServers();
	const out: Record<string, unknown> = {};
	for (const [name, cfg] of Object.entries(configured)) {
		// Money-moving: a script executes with no per-call approval bridge, so
		// these are never reachable from one.
		if (gated.has(name)) continue;
		out[name] = cfg;
	}
	return out;
}

export interface WorkflowMcpHost {
	/** Server names the script may call (no connection made). */
	servers(): string[];
	/** Tool catalog for one server (connects on first use). */
	tools(server: string): Promise<WorkflowMcpTool[]>;
	/** Call one tool. Rejects on unknown/denied server-tool, transport failure,
	 *  or an isError result. */
	call(server: string, tool: string, args: unknown): Promise<unknown>;
	/** Close every connected client (kills stdio children). Idempotent. */
	close(): Promise<void>;
}

/** Cap a resolved value so a chatty tool can't blow up the journal or the
 *  postMessage payload. Strings truncate; structures fall back to truncated
 *  JSON so the script still sees the shape. */
function capValue(value: unknown): unknown {
	const max = WORKFLOW_LIMITS.maxMcpResultChars;
	if (typeof value === "string") {
		return value.length > max ? value.slice(0, max) + "…(truncated)" : value;
	}
	let json: string;
	try {
		json = JSON.stringify(value) ?? "";
	} catch {
		return String(value).slice(0, max);
	}
	if (json.length <= max) return value;
	return json.slice(0, max) + "…(truncated)";
}

/** MCP CallToolResult → a plain JS value the script can work with:
 *  structuredContent when the server provides it, else the text blocks
 *  (JSON-parsed when they parse — most servers return JSON as text). */
function normalizeResult(result: unknown): unknown {
	const res = result as {
		isError?: boolean;
		structuredContent?: unknown;
		content?: Array<{ type?: string; text?: string }>;
	};
	const texts = (res?.content || [])
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string);
	if (res?.isError) {
		throw new Error(texts.join("\n").slice(0, 4000) || "tool returned an error");
	}
	if (res?.structuredContent !== undefined) return capValue(res.structuredContent);
	if (!texts.length) return capValue(res?.content ?? null);
	const joined = texts.join("\n");
	try {
		return capValue(JSON.parse(joined));
	} catch {
		return capValue(joined);
	}
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
			ms,
		);
		(timer as { unref?: () => void }).unref?.();
		work.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

export function createWorkflowMcpHost(
	opts: WorkflowMcpHostOpts,
): WorkflowMcpHost {
	const gated = confirmGatedServers();
	const configured =
		opts.configuredForTest ??
		(filterMcpServers(opts.allowlist ?? "all", opts.user) as Record<string, unknown>);
	const allowed = workflowMcpServers(configured) as Record<string, any>;
	const denied = opts.deniedTools || {};

	// name → connection promise (cached, including in-flight).
	const clients = new Map<string, Promise<Client>>();
	let closed = false;

	async function connect(server: string): Promise<Client> {
		const cfg = allowed[server];
		const client = new Client(
			{ name: "opensession-workflow", version: "1.0.0" },
			{ capabilities: {} },
		);
		const isHttp = cfg.type === "http" || cfg.type === "sse" || !!cfg.url;
		if (isHttp) {
			const url = new URL(String(cfg.url));
			const headers: Record<string, string> = {
				...(cfg.headers || {}),
			};
			if (!headers.Authorization && !headers.authorization) {
				Object.assign(headers, opencodeAuthHeader(server) || {});
			}
			const init = { requestInit: { headers } };
			try {
				await client.connect(new StreamableHTTPClientTransport(url, init));
			} catch (e) {
				// Older servers only speak the SSE transport.
				await client.connect(new SSEClientTransport(url, init as any));
			}
			return client;
		}
		if (!cfg.command) {
			throw new Error(`MCP server "${server}" has neither a url nor a command`);
		}
		await client.connect(
			new StdioClientTransport({
				command: String(cfg.command),
				args: (cfg.args || []).map(String),
				// The SDK's default environment is already a minimal safe set
				// (PATH/HOME/…); the server's own credentials come from its config
				// entry — never the server process's full secret-bearing env.
				env: { ...getDefaultEnvironment(), ...(cfg.env || {}) },
				stderr: "ignore",
			}),
		);
		return client;
	}

	function clientFor(server: string): Promise<Client> {
		const cached = clients.get(server);
		if (cached) return cached;
		const promise = withTimeout(
			connect(server),
			WORKFLOW_LIMITS.mcpConnectTimeoutMs,
			`connecting to MCP server "${server}"`,
		).catch((e) => {
			// Don't cache a failed handshake — a later call may succeed.
			clients.delete(server);
			throw e;
		});
		clients.set(server, promise);
		return promise;
	}

	function assertAllowed(server: string, tool?: string): void {
		if (closed) throw new Error("workflow finished — MCP host is closed");
		if (!allowed[server]) {
			const names = Object.keys(allowed).sort().join(", ");
			const gatedNote = gated.has(server)
				? ` — "${server}" is confirm-gated and never reachable from a workflow script; propose the action in your result for a human to run`
				: "";
			throw new Error(
				`no MCP server "${server}" available to this workflow${gatedNote}. Available: ${names || "(none)"}`,
			);
		}
		if (tool) {
			const reason = denied[`mcp__${server}__${tool}`];
			if (reason) throw new Error(`${server}.${tool} is not available: ${reason}`);
		}
	}

	return {
		servers(): string[] {
			return Object.keys(allowed).sort();
		},

		async tools(server: string): Promise<WorkflowMcpTool[]> {
			assertAllowed(server);
			const client = await clientFor(server);
			const listed = await withTimeout(
				client.listTools(),
				WORKFLOW_LIMITS.mcpCallTimeoutMs,
				`listing ${server} tools`,
			);
			return (listed.tools || [])
				.filter((t) => !denied[`mcp__${server}__${t.name}`])
				.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema,
				}));
		},

		async call(server: string, tool: string, args: unknown): Promise<unknown> {
			assertAllowed(server, tool);
			const client = await clientFor(server);
			const result = await withTimeout(
				client.callTool({
					name: tool,
					arguments: (args ?? {}) as Record<string, unknown>,
				}),
				WORKFLOW_LIMITS.mcpCallTimeoutMs,
				`${server}.${tool}`,
			);
			return normalizeResult(result);
		},

		async close(): Promise<void> {
			closed = true;
			const pending = [...clients.values()];
			clients.clear();
			await Promise.all(
				pending.map(async (p) => {
					try {
						const client = await p;
						await client.close();
					} catch {
						// A client that never connected (or already died) needs no
						// teardown — never let cleanup surface as a run failure.
					}
				}),
			);
		},
	};
}
