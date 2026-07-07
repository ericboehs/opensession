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

// Proxied tool calls can legitimately block for many minutes (michael-humans
// ask_human in block mode waits ~20 min for a teammate; michael-ask's ask_user
// waits on the UI question card + Slack escalation). The MCP SDK's default
// request timeout is 60s, which killed those mid-wait — pass an explicit long
// ceiling instead. Bun.serve gets idleTimeout: 0 below for the same reason
// (its default silently closes any response slower than 10s).
const RPC_TOOL_CALL_TIMEOUT_MS = 30 * 60 * 1000;

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
  const cleanup = async () => {
    try {
      await client.close();
    } catch {}
    try {
      await cfg.instance.close();
    } catch {}
  };
  try {
    await cfg.instance.connect(serverTransport);
    await client.connect(clientTransport);
    if (path === "/mcp/list") {
      const res = await client.listTools();
      await cleanup();
      return json({ tools: res.tools });
    }
    if (path === "/mcp/call") {
      // Long tool calls stream heartbeat whitespace while the call runs: Bun's
      // fetch client aborts any response idle for 300s (hard-coded — a signal
      // doesn't override it), which would kill legitimately-blocking tools
      // like ask_human/ask_user mid-wait. JSON.parse skips leading whitespace,
      // so the proxy's res.json() sees only the final body. Errors ride the
      // body as { error } (the stream is already 200 by then) — the proxy
      // treats a body-level error like a non-OK status.
      const done: Promise<Record<string, unknown>> = client
        .callTool(
          {
            name: String(body?.tool || ""),
            arguments: body?.args ?? {},
          },
          undefined,
          { timeout: RPC_TOOL_CALL_TIMEOUT_MS }
        )
        .then(
          (res) => ({ result: res }),
          (e: any) => ({ error: e?.message || String(e) })
        );
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(enc.encode(" "));
            } catch {}
          }, 30_000);
          void done.then(async (respBody) => {
            clearInterval(heartbeat);
            try {
              controller.enqueue(enc.encode(JSON.stringify(respBody)));
              controller.close();
            } catch {}
            await cleanup();
          });
        },
        cancel() {
          // Caller went away mid-call — release the transports.
          void cleanup();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/json" },
      });
    }
    await cleanup();
    return json({ error: `unknown path ${path}` }, 404);
  } catch (e: any) {
    await cleanup();
    return json({ error: e?.message || String(e) }, 500);
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
    // Bun.serve's default idleTimeout (10s) closes the socket under any
    // response slower than that — proxied tool calls routinely block longer
    // (worktree prep, blocking human asks). 0 = no idle limit; the call-level
    // timeout above is the real ceiling. (Supported at runtime on unix
    // servers; Bun's types only allow it for TCP, hence the cast.)
    idleTimeout: 0,
    fetch: (req: Request) => (g.__runRpcHandler as typeof handleRpc)(req),
  } as unknown as Parameters<typeof Bun.serve>[0]);
  try {
    chmodSync(sock, 0o600);
  } catch {}
  console.log(`[run-rpc] listening on ${sock}`);
}
