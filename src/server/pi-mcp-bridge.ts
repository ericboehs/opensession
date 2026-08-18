/**
 * MCP → Pi tool bridge: turns a run's MCP surface — external servers from
 * mcp-config.json plus the in-process opensession-* servers — into Pi
 * `customTools` (ToolDefinition objects) for the in-process pi engine
 * (pi-runner.ts). Hand-rolled on @modelcontextprotocol/sdk (the v1 stack we
 * already ship everywhere else); mcporter/pi-mcporter were rejected — parallel
 * MCP v2 stack, default interactive-OAuth hazard, and policy living in their
 * config files instead of ours.
 *
 * Policy is enforced by ABSENCE, in our layer:
 *  - External servers resolve ONLY through `filterMcpServers` (per-run
 *    allowlist + per-user `allowedUsers` gating, metadata stripped) — the
 *    same helper every other runner enforces with.
 *  - `deniedToolIds` are dropped BEFORE a ToolDefinition is built, so the
 *    model never sees them. Ids follow the engine-neutral `<server>_<tool>`
 *    convention (opencodeDeniedToolIds); the broad forms `*_<tool>` and bare
 *    `<tool>` are honored too so the money-mover confirm set strips the same
 *    way it does on the opencode engine.
 *
 * Wiring notes:
 *  - In-process servers (instances from inprocess-mcp.ts, built per-session
 *    by interactive-mcp.ts) connect directly over an InMemoryTransport pair —
 *    no stdio proxy hop, no run-rpc token: we're in the same process.
 *  - OAuth-granted servers are omitted here and mounted as coordinator-side
 *    in-process proxies (mcp-oauth-proxy.ts), so provider tokens never enter
 *    Pi state or a model-controlled process.
 *  - stdio servers spawn with getDefaultEnvironment() + the server's own
 *    configured env — never this process's env (it holds Open Session tokens).
 *
 * Lifecycle: connections open during creation because MCP has no offline tool
 * discovery — `tools/list` needs a live connection, so a resolved server
 * connects once at bridge build and the connection is reused for calls (the
 * "unused stdio servers never spawn" ideal is unreachable while the tool
 * catalog must exist up front; per-config catalog caching would fix it and is
 * deliberately out of v1). A server that fails to connect/list degrades to
 * absent tools (warn + audit), never a failed turn; a wedged call times out
 * and fails that call, not the turn. `close()` tears down every client and
 * connected in-process instance.
 *
 * The pi package is imported TYPE-ONLY here: the bridge must be importable
 * (tests, pi-runner module load) without triggering the pi dep tree's cold
 * Bun transpile.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { filterMcpServers, type McpScope } from "./runner-shared";
import { hasMcpOauthGrantForUsers } from "./mcp-oauth";
import type { InProcessMcpServer } from "./inprocess-mcp";

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** Pi tool-result content blocks (structural match for pi-ai's
 *  TextContent/ImageContent — declared locally to keep the import type-only). */
type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PiMcpBridge {
  /** Full post-policy catalog, used by the bridge's compact dispatcher. */
  tools: ToolDefinition<any, any, any>[];
  /**
   * Small MCP surface exposed to Pi. Keeping hundreds of JSON schemas out of
   * every provider request avoids turning a normal code task into a massive
   * cached prompt. Search always returns only tools already admitted to
   * `tools`, and call can execute only a catalogued definition.
   */
  discoveryTools: ToolDefinition<any, any, any>[];
  /** Tear down every transport (and connected in-process instance). */
  close(): Promise<void>;
}

interface ServerConn {
  client: Client;
  /** Present for in-process servers so close() disconnects the instance too. */
  instance?: InProcessMcpServer["instance"];
}

/** `<server>_<tool>` denied-set membership, exact + the broad forms the
 *  money-mover confirm set uses (see opencodeDeniedToolIds: `*_<tool>` and
 *  bare `<tool>` over-block same-named tools by design there — mirror it). */
function isDeniedTool(
  server: string,
  tool: string,
  denied: ReadonlySet<string>,
): boolean {
  return (
    denied.has(`${server}_${tool}`) || denied.has(`*_${tool}`) || denied.has(tool)
  );
}

function isInProcessServer(v: unknown): v is InProcessMcpServer {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { type?: unknown }).type === "sdk" &&
    !!(v as { instance?: unknown }).instance
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** MCP result content → Pi content blocks. text/image map 1:1 (pi
 *  auto-resizes oversize images on entry to history); resource/audio/unknown
 *  blocks and compat/structured-only results JSON-stringify to text. */
function mapContent(res: Record<string, unknown>): PiContent[] {
  const blocks = Array.isArray(res?.content) ? res.content : [];
  const out: PiContent[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b?.type === "image" && typeof b.data === "string") {
      out.push({
        type: "image",
        data: b.data,
        mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png",
      });
    } else if (b != null) {
      out.push({ type: "text", text: JSON.stringify(b) });
    }
  }
  if (!out.length) {
    const fallback = res?.structuredContent ?? res?.toolResult;
    out.push({
      type: "text",
      text: fallback !== undefined ? JSON.stringify(fallback) : "",
    });
  }
  return out;
}

function errorText(content: PiContent[]): string {
  return content
    .filter((c): c is Extract<PiContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .filter(Boolean)
    .join("\n");
}

export async function createPiMcpBridge(opts: {
  /** Same as RunAgentOpts.mcpServers ("all" | string[]) — pass [] for none. */
  mcpServers: McpScope;
  user?: string;
  /** OAuth grant identity override (session creator) — same priority order
   *  as buildOpencodeMcpConfig: creator first, prompter second. */
  mcpGrantUser?: string;
  /** `<server>_<tool>` ids (plus broad `*_<tool>`/bare forms) dropped BEFORE
   *  registration — the model never sees them. */
  deniedToolIds: ReadonlySet<string>;
  /** RunAgentOpts.inProcessMcp — instances from inprocess-mcp.ts. */
  inProcessMcp?: Record<string, unknown>;
  onAudit?: (e: { server: string; tool: string; ok: boolean; ms: number }) => void;
  /** Per tool call (and per connect/list at creation). Default 120s. */
  callTimeoutMs?: number;
}): Promise<PiMcpBridge> {
  const timeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const grantUsers = [opts.user];
  let closed = false;

  // Every ServerConn ever built, memoized or not, so close() reaches clients
  // whose connect never resolved (client.close() tears the transport down
  // mid-connect, killing a wedged stdio child).
  const live = new Set<ServerConn>();
  const conns = new Map<string, Promise<ServerConn>>();

  const connectExternal = async (
    name: string,
    cfg: Record<string, unknown>,
  ): Promise<ServerConn> => {
    const client = new Client({ name: "opensession-pi-bridge", version: "1.0.0" });
    const rec: ServerConn = { client };
    live.add(rec);
    let transport: Transport;
    if (cfg.type === "http" || cfg.type === "sse" || cfg.url) {
      const url = String(cfg.url);
      const headers = { ...((cfg.headers as Record<string, string>) || {}) };
      const requestInit = Object.keys(headers).length ? { headers } : undefined;
      // sse: requestInit covers the POST side; the GET event stream can't
      // carry custom headers through EventSource — matches the engine-side
      // limitation, and our configured servers are streamable-http.
      transport =
        cfg.type === "sse"
          ? new SSEClientTransport(new URL(url), { requestInit })
          : new StreamableHTTPClientTransport(new URL(url), { requestInit });
    } else if (cfg.command) {
      transport = new StdioClientTransport({
        command: String(cfg.command),
        args: (cfg.args as string[]) || [],
        // Safe inherit-set + the server's own configured credentials — never
        // this process's env (it holds Open Session tokens).
        env: {
          ...getDefaultEnvironment(),
          ...((cfg.env as Record<string, string>) || {}),
        },
      });
    } else {
      throw new Error(`MCP server "${name}" has neither url nor command`);
    }
    await client.connect(transport);
    return rec;
  };

  const connectInProcess = async (
    server: InProcessMcpServer,
  ): Promise<ServerConn> => {
    const client = new Client({ name: "opensession-pi-bridge", version: "1.0.0" });
    const rec: ServerConn = { client, instance: server.instance };
    live.add(rec);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    return rec;
  };

  const ensure = (name: string, factory: () => Promise<ServerConn>) => {
    let p = conns.get(name);
    if (!p) {
      p = factory();
      conns.set(name, p);
      p.catch(() => conns.delete(name));
    }
    return p;
  };

  const listAllTools = async (client: Client) => {
    const out: Array<Record<string, any>> = [];
    let cursor: string | undefined;
    do {
      const res = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: timeoutMs,
      });
      out.push(...(res.tools as Array<Record<string, any>>));
      cursor = res.nextCursor;
    } while (cursor);
    return out;
  };

  const bridgedTool = (
    server: string,
    tool: Record<string, any>,
    getConn: () => Promise<ServerConn>,
  ): ToolDefinition<any, any, any> => {
    const id = `${server}_${tool.name}`;
    return {
      name: id,
      label:
        typeof tool.title === "string" && tool.title
          ? tool.title
          : `${server}: ${tool.name}`,
      description:
        typeof tool.description === "string" && tool.description
          ? tool.description
          : `${tool.name} (MCP tool from ${server})`,
      // MCP inputSchema is JSON Schema; TypeBox IS JSON Schema — passthrough.
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as any,
      execute: async (_toolCallId, params, signal) => {
        const started = Date.now();
        try {
          if (closed) throw new Error("MCP bridge is closed");
          const conn = await withTimeout(
            getConn(),
            timeoutMs,
            `MCP server "${server}" connect timed out`,
          );
          const res = (await conn.client.callTool(
            { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
            undefined,
            { timeout: timeoutMs, maxTotalTimeout: timeoutMs, signal },
          )) as Record<string, unknown>;
          const content = mapContent(res);
          // Pi convention: tool errors are THROWN, not encoded in the result.
          if (res.isError) throw new Error(errorText(content) || `${id} failed`);
          opts.onAudit?.({ server, tool: tool.name, ok: true, ms: Date.now() - started });
          return { content, details: undefined };
        } catch (e) {
          opts.onAudit?.({ server, tool: tool.name, ok: false, ms: Date.now() - started });
          throw e instanceof Error ? e : new Error(String(e));
        }
      },
    };
  };

  // ── Resolve the server set ─────────────────────────────────────────────────
  const entries: Array<{ name: string; factory: () => Promise<ServerConn> }> = [];
  const external = filterMcpServers(
    opts.mcpServers,
    opts.user,
    opts.mcpGrantUser ? grantUsers : undefined,
  ) as Record<string, Record<string, unknown>>;
  for (const [name, cfg] of Object.entries(external)) {
    // Personal OAuth servers arrive below as coordinator-side in-process
    // proxies. Do not build a second connection whose config could contain or
    // fall back to a provider credential.
    if (hasMcpOauthGrantForUsers(name, grantUsers)) continue;
    entries.push({ name, factory: () => connectExternal(name, cfg) });
  }
  for (const [name, v] of Object.entries(opts.inProcessMcp ?? {})) {
    if (!isInProcessServer(v)) continue;
    if (entries.some((e) => e.name === name)) continue; // external name wins; never double-mount
    entries.push({ name, factory: () => connectInProcess(v) });
  }

  // ── List + register (deny BEFORE defineTool; dead servers degrade) ─────────
  const tools: ToolDefinition<any, any, any>[] = [];
  const seen = new Set<string>();
  for (const { name, factory } of entries) {
    const started = Date.now();
    let listed: Array<Record<string, any>>;
    try {
      const conn = await withTimeout(
        ensure(name, factory),
        timeoutMs,
        `MCP server "${name}" connect timed out`,
      );
      listed = await listAllTools(conn.client);
    } catch (e) {
      console.warn(`[pi-mcp-bridge] server "${name}" unavailable, skipping:`, e);
      opts.onAudit?.({ server: name, tool: "tools/list", ok: false, ms: Date.now() - started });
      continue;
    }
    for (const t of listed) {
      if (typeof t?.name !== "string" || !t.name) continue;
      if (isDeniedTool(name, t.name, opts.deniedToolIds)) continue;
      const def = bridgedTool(name, t, () => ensure(name, factory));
      if (seen.has(def.name)) continue;
      seen.add(def.name);
      tools.push(def);
    }
  }

  // Pi forwards every custom tool's JSON schema through the Agent SDK on
  // every model request. The full catalog is often hundreds of tools, which
  // can turn into a several-hundred-thousand-token cached prefix and make a
  // healthy turn look wedged. Keep the catalog server-side and expose a
  // two-step surface instead. This is discovery, not an access grant: both
  // tools close over the already policy-filtered `tools` list above.
  const byName = new Map(tools.map((definition) => [definition.name, definition]));
  const searchable = tools.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    haystack: `${definition.name} ${definition.label} ${definition.description}`.toLowerCase(),
  }));
  const searchCatalog: ToolDefinition<any, any, any> = {
    name: "mcp_search",
    label: "Search MCP tools",
    description:
      "Search the available MCP tool catalog before calling mcp_call. " +
      "Use the returned tool name and argument schema exactly.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What capability you need" },
        limit: { type: "number", description: "Maximum matches to return, 1 to 12 (default 6)" },
      },
      required: ["query"],
    } as any,
    async execute(_toolCallId, params) {
      const query = String((params as { query?: unknown })?.query ?? "").trim().toLowerCase();
      if (!query) throw new Error("mcp_search requires a query");
      const requested = Number((params as { limit?: unknown })?.limit);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(12, Math.floor(requested))) : 6;
      const terms = query.split(/\s+/).filter(Boolean);
      const matches = searchable
        .map((entry) => ({
          entry,
          score: terms.reduce((score, term) => score + (entry.haystack.includes(term) ? 1 : 0), 0),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
        .slice(0, limit);
      const text = matches.length
        ? matches
            .map(
              ({ entry }) =>
                `${entry.name}: ${entry.description}\narguments: ${JSON.stringify(entry.parameters)}`,
            )
            .join("\n\n")
        : `No permitted MCP tools matched "${query}". Try broader capability words.`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
  const callCatalog: ToolDefinition<any, any, any> = {
    name: "mcp_call",
    label: "Call MCP tool",
    description:
      "Call a tool returned by mcp_search. Pass its exact name and an arguments object matching its schema.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name returned by mcp_search" },
        arguments: { type: "object", description: "Arguments for that tool" },
      },
      required: ["name", "arguments"],
    } as any,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const name = String((params as { name?: unknown })?.name ?? "");
      const definition = byName.get(name);
      if (!definition) throw new Error(`MCP tool "${name}" is unavailable. Search the catalog first.`);
      const args = (params as { arguments?: unknown })?.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("mcp_call arguments must be an object");
      }
      return definition.execute(toolCallId, args as any, signal, onUpdate, ctx);
    },
  };
  const discoveryTools = tools.length ? [searchCatalog, callCatalog] : [];

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const rec of live) {
      try {
        await rec.client.close();
      } catch {}
      try {
        await rec.instance?.close();
      } catch {}
    }
    live.clear();
    conns.clear();
  };

  return { tools, discoveryTools, close };
}
