/**
 * run-rpc — a local unix-socket RPC that lets detached run hosts reach the
 * in-process michael-* MCP servers (michael-sessions / -admin / -goals /
 * -humans / -repos / -goal-self), which can only execute inside the backstage
 * process (they close over live state: SessionControl, pendingAsks, attachRepo…).
 *
 * A run host injects a stdio proxy (src/runner-host/mcp-proxy.ts) per server
 * into its run's MCP config; the proxy forwards tools/list + tools/call here.
 * Because the proxy reconnects with retry, these tools now SURVIVE a backstage
 * restart mid-run — with the old in-process wiring they died with the process.
 *
 * Auth: same-uid is the trust boundary on this box, but automation runs are
 * deliberately fail-closed — every request needs a per-run bearer token that
 * backstage minted when it spawned the host (and re-registers on reattach).
 * Automation-owned runs never get a token, so untrusted ticket text can't
 * reach session-control/self-admin tools through this socket.
 *
 * Execution: per request, the registered builder constructs the SDK MCP server
 * instances for the token's {sessionId, user}, and we call the requested tool
 * through an InMemoryTransport client pair. Building per request keeps this
 * stateless across hot reloads (every mutable bit is parked on globalThis).
 */

import { existsSync, unlinkSync, chmodSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { rpcSocketPath } from "./run-rpc-protocol";

const g = globalThis as any;

export interface RunTokenContext {
  sessionId: string;
  user?: string;
}

// token → run context. Parked on globalThis (hot reload keeps live runs'
// tokens); repopulated from host specs on boot reattach after a real restart.
const tokens: Map<string, RunTokenContext> = (g.__runRpcTokens ??= new Map());

export function registerRunToken(token: string, ctx: RunTokenContext): void {
  tokens.set(token, ctx);
}

export function unregisterRunToken(token: string | undefined): void {
  if (token) tokens.delete(token);
}

/**
 * Builds the interactive MCP server set for a session — the same set the old
 * inProcessMcp wiring passed to runClaude. Registered by backstage.ts on every
 * (re)load; parked on globalThis so the long-lived socket handler always calls
 * the freshest implementation.
 */
export type InteractiveMcpBuilder = (
  sessionId: string,
  user?: string
) => Record<string, any>;

export function registerInteractiveMcpBuilder(b: InteractiveMcpBuilder): void {
  g.__runRpcMcpBuilder = b;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleRpc(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const path = new URL(req.url).pathname;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const ctx = tokens.get(String(body?.token || ""));
  if (!ctx) return json({ error: "unauthorized (unknown run token)" }, 403);

  const builder: InteractiveMcpBuilder | undefined = g.__runRpcMcpBuilder;
  if (!builder) return json({ error: "MCP builder not registered yet" }, 503);

  const serverName = String(body?.server || "");
  const cfg = builder(ctx.sessionId, ctx.user)[serverName];
  if (!cfg?.instance) {
    return json({ error: `no interactive MCP server "${serverName}" for this run` }, 404);
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "backstage-run-rpc", version: "1.0.0" });
  try {
    await cfg.instance.connect(serverTransport);
    await client.connect(clientTransport);
    if (path === "/mcp/list") {
      const res = await client.listTools();
      return json({ tools: res.tools });
    }
    if (path === "/mcp/call") {
      const res = await client.callTool({
        name: String(body?.tool || ""),
        arguments: body?.args ?? {},
      });
      return json({ result: res });
    }
    return json({ error: `unknown path ${path}` }, 404);
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  } finally {
    try {
      await client.close();
    } catch {}
    try {
      await cfg.instance.close();
    } catch {}
  }
}

/** Boot the RPC socket once; safe to call on every reload (handler is
 *  re-pointed through globalThis so new code applies without a rebind). */
export function startRunRpcServer(): void {
  g.__runRpcHandler = handleRpc;
  if (g.__runRpcServer) return;
  const sock = rpcSocketPath(BACKSTAGE_CHATS_DIR);
  try {
    if (existsSync(sock)) unlinkSync(sock);
  } catch {}
  g.__runRpcServer = Bun.serve({
    unix: sock,
    fetch: (req) => (g.__runRpcHandler as typeof handleRpc)(req),
  });
  try {
    chmodSync(sock, 0o600);
  } catch {}
  console.log(`[run-rpc] listening on ${sock}`);
}
