/**
 * mcp-proxy — a stdio MCP server that forwards tools/list and tools/call to
 * the backstage process over its run-rpc unix socket (src/server/run-rpc.ts).
 *
 * Spawned by Codex as a stdio MCP server, one instance per michael-* server
 * (BKS_MCP_SERVER names which one). The actual tool implementations close
 * over live backstage state and must execute there, while Codex can only
 * consume external stdio MCP servers.
 *
 * Env (set in the injected MCP config by codex-runner.ts):
 *   BKS_RPC_SOCKET — backstage's run-rpc unix socket path
 *   BKS_RPC_TOKEN  — per-run bearer minted at spawn (maps to session + user)
 *   BKS_MCP_SERVER — which interactive server to proxy (e.g. michael-sessions)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SOCK = process.env.BKS_RPC_SOCKET || "";
const TOKEN = process.env.BKS_RPC_TOKEN || "";
const SERVER_NAME = process.env.BKS_MCP_SERVER || "";
if (!SOCK || !TOKEN || !SERVER_NAME) {
  console.error("mcp-proxy: BKS_RPC_SOCKET, BKS_RPC_TOKEN and BKS_MCP_SERVER are required");
  process.exit(2);
}

/** An error the backstage side answered with — retrying won't change it. */
class RpcError extends Error {}

/**
 * POST to backstage over the unix socket. Connection-level failures (socket
 * gone / refused — backstage restarting) retry until the deadline; anything
 * backstage actually answered surfaces immediately.
 */
async function rpc(path: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const res = await fetch(`http://backstage${path}`, {
        method: "POST",
        // Bun extension: route the request over a unix socket.
        unix: SOCK,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN, server: SERVER_NAME, ...body }),
      } as any);
      let data: any = null;
      try {
        data = await res.json();
      } catch {}
      if (!res.ok) throw new RpcError(data?.error || `backstage RPC ${res.status}`);
      return data;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      lastErr = e; // connect failure — backstage likely restarting
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `backstage unreachable at ${SOCK} for ${Math.round(timeoutMs / 1000)}s: ${lastErr}`
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const server = new Server(
  { name: `backstage-proxy-${SERVER_NAME}`, version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const data = await rpc("/mcp/list", {});
  return { tools: data.tools || [] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const data = await rpc("/mcp/call", {
      tool: req.params.name,
      args: req.params.arguments ?? {},
    });
    return data.result;
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Tool call failed: ${e?.message || e}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
