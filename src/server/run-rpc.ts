/**
 * run-rpc — a local unix-socket RPC that lets detached run hosts reach the
 * in-process opensession-* MCP servers (opensession-sessions / -admin / -goals /
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
import { timingSafeEqual } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { audit } from "./audit";
import { canonicalMcpServerId } from "./rename-compat";
import { rpcSocketPath } from "./run-rpc-protocol";

const g = globalThis as any;

// Proxied tool calls can legitimately block for many minutes (opensession-humans
// ask_human in block mode waits ~20 min for a teammate; opensession-ask's ask_user
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
// Refcounted: a SHARED opencode server carries one stable token that several
// concurrent runs register/unregister (opencode-runner) — the token must stay
// valid until the LAST of them finishes. ctx is the most recent registration:
// it is only the fallback identity for calls that arrive without a per-call
// ocSession tag (see dispatchRunRpc below).
const tokens: Map<string, RunTokenContext & { refs: number }> = (g.__runRpcTokens ??=
  new Map());

export function registerRunToken(token: string, ctx: RunTokenContext): void {
  const existing = tokens.get(token);
  tokens.set(token, { ...ctx, refs: (existing?.refs || 0) + 1 });
}

export function unregisterRunToken(token: string | undefined): void {
  if (!token) return;
  const existing = tokens.get(token);
  if (!existing || existing.refs <= 1) tokens.delete(token);
  else existing.refs -= 1;
}

// opencode session id → the backstage session driving it, registered by
// opencode-runner for the duration of each run on a SHARED server. Tool calls
// proxied from such a server carry the opencode session id (injected by
// opencode-plugin-session-tag.js, stripped back out of the args by
// mcp-proxy.ts), which resolves here to the RIGHT session context — the
// token's own ctx is just the shared server's most recent run. `token` pins
// the mapping to the server that registered it: a call authenticated with a
// different token cannot borrow another server's session identities.
export interface OcSessionContext {
  sessionId: string;
  user?: string;
  token: string;
}

const ocSessions: Map<string, OcSessionContext> = (g.__runRpcOcSessions ??= new Map());

export function registerOcSessionContext(ocSessionId: string, ctx: OcSessionContext): void {
  ocSessions.set(ocSessionId, ctx);
}

export function unregisterOcSessionContext(ocSessionId: string | undefined): void {
  if (ocSessionId) ocSessions.delete(ocSessionId);
}

/** Constant-time string compare (length mismatch short-circuits — the length
 *  of a random UUID token is not a secret). Used by the WS upgrade checks in
 *  src/server/run-ws.ts. NOTE: the tokens registry above is deliberately NOT
 *  consulted by any network-reachable auth check — it stays local to the unix
 *  RPC socket (frame-level context lookup); the WS routes authenticate against
 *  their own per-launch wsToken registry. */
export function timingSafeEqStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
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

// Per-session in-process MCP overrides: an agent loop (Slack) registers the
// exact server objects it built for its run — with loop-specific context the
// generic interactive builder can't reconstruct (channel memory, the Slack
// ask handler, opensession-github's report-back channel) — so the stdio proxies
// execute THOSE for the run's duration. Keyed by bks session id; parked on
// globalThis so a hot reload keeps live runs' overrides.
const sessionServers: Map<string, Record<string, any>> = (g.__runRpcSessionServers ??=
  new Map());

export function registerSessionMcpServers(
  sessionId: string,
  servers: Record<string, any>
): void {
  sessionServers.set(sessionId, servers);
}

export function unregisterSessionMcpServers(sessionId: string): void {
  sessionServers.delete(sessionId);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A dispatched RPC request. `immediate` carries a ready status+body (auth
 * failures, lookups, tools/list). `call` is a tool call in flight: `done`
 * resolves to `{ result }` or `{ error }` once the tool finishes (transports
 * are cleaned up internally) — the transport layer decides how to wait it out
 * (HTTP streams heartbeats around it; the WS bridge just awaits it).
 */
export type RunRpcDispatch =
  | { kind: "immediate"; status: number; body: Record<string, unknown> }
  | { kind: "call"; done: Promise<Record<string, unknown>> };

const imm = (status: number, body: Record<string, unknown>): RunRpcDispatch => ({
  kind: "immediate",
  status,
  body,
});

/**
 * Transport-agnostic core shared by the unix-socket HTTP handler below and
 * the WS bridge (src/server/run-ws.ts): validate the run token, build the
 * server, run tools/list or tools/call. Never throws.
 */
export async function dispatchRunRpc(path: string, body: any): Promise<RunRpcDispatch> {
  const token = String(body?.token || "");
  let ctx: RunTokenContext | undefined = tokens.get(token);
  if (!ctx) return imm(403, { error: "unauthorized (unknown run token)" });

  // Per-call session refinement (shared opencode servers): the proxied call
  // names the opencode session it came from; resolve it to the backstage
  // session that owns it — but only when that mapping was registered under
  // the SAME token (a spoofed/stale id falls back to the token's own ctx).
  const ocSession = String(body?.ocSession || "");
  if (ocSession) {
    const oc = ocSessions.get(ocSession);
    if (oc && timingSafeEqStr(oc.token, token)) ctx = { sessionId: oc.sessionId, user: oc.user };
  }

  const builder: InteractiveMcpBuilder | undefined = g.__runRpcMcpBuilder;
  if (!builder) return imm(503, { error: "MCP builder not registered yet" });

  // Legacy michael-* ids still arrive from journaled runs resumed across the
  // 2026-07-09 opensession-* rename — normalize before lookup.
  const serverName = canonicalMcpServerId(String(body?.server || ""));
  const perSession = sessionServers.get(ctx.sessionId);
  const cfg =
    (perSession
      ? Object.fromEntries(
          Object.entries(perSession).map(([n, s]) => [canonicalMcpServerId(n), s]),
        )[serverName]
      : undefined) ?? builder(ctx.sessionId, ctx.user)[serverName];
  if (!cfg?.instance) {
    // tools/list for a server this session doesn't carry (shared servers list
    // the union of in-process servers in their config) answers with an empty
    // tool list rather than an error — the proxy stays healthy and the
    // session simply sees no tools from it. Calls still 404.
    if (path === "/mcp/list") return imm(200, { tools: [] });
    return imm(404, { error: `no interactive MCP server "${serverName}" for this run` });
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
      return imm(200, { tools: res.tools });
    }
    if (path === "/mcp/call") {
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
        )
        .then(async (respBody) => {
          await cleanup();
          return respBody;
        });
      return { kind: "call", done };
    }
    await cleanup();
    return imm(404, { error: `unknown path ${path}` });
  } catch (e: any) {
    await cleanup();
    return imm(500, { error: e?.message || String(e) });
  }
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
  const dispatched = await dispatchRunRpc(path, body);
  if (dispatched.kind === "immediate") {
    return json(dispatched.body, dispatched.status);
  }
  // Long tool calls stream heartbeat whitespace while the call runs: Bun's
  // fetch client aborts any response idle for 300s (hard-coded — a signal
  // doesn't override it), which would kill legitimately-blocking tools
  // like ask_human/ask_user mid-wait. JSON.parse skips leading whitespace,
  // so the proxy's res.json() sees only the final body. Errors ride the
  // body as { error } (the stream is already 200 by then) — the proxy
  // treats a body-level error like a non-OK status. If the caller goes away
  // mid-call, the call still runs to completion (bounded by the call-level
  // timeout) and dispatchRunRpc's internal cleanup releases the transports.
  const done = dispatched.done;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(" "));
        } catch {}
      }, 30_000);
      void done.then((respBody) => {
        clearInterval(heartbeat);
        try {
          controller.enqueue(enc.encode(JSON.stringify(respBody)));
          controller.close();
        } catch {}
      });
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/json" },
  });
}

/** Boot the RPC socket once; safe to call on every reload (handler is
 *  re-pointed through globalThis so new code applies without a rebind). */
export function startRunRpcServer(): void {
  g.__runRpcHandler = handleRpc;
  // `bun test` guard: this runs as a module side effect (interactive-mcp.ts),
  // so ANY test whose import chain reaches this file would otherwise unlink
  // and steal the LIVE server's socket, then exit and leave a dead inode at
  // the path — every interactive run wedges in MCP init until a restart
  // (2026-07-16 and again 2026-07-17, a fleet-wide outage). bun test sets
  // NODE_ENV=test; the Bun.main check is a belt for suites that override it.
  if (process.env.NODE_ENV === "test" || /\.test\.tsx?$/.test(Bun.main || "")) {
    return;
  }
  if (g.__runRpcServer) {
    startRunRpcSocketHeal();
    return;
  }
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
  startRunRpcSocketHeal();
}

/** True when a connect to the socket PATH is answered. Distinguishes a healthy
 *  bind from the stolen-socket state: an external process (a test run) that
 *  unlinked + re-bound the path and exited leaves a dead inode there while our
 *  server keeps "listening" on the orphaned one — connects get refused. */
async function rpcSocketPathAlive(sock: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      Bun.connect({
        unix: sock,
        socket: {
          open(s) {
            resolve();
            try {
              s.end();
            } catch {}
          },
          data() {},
          close() {},
          error(_s, e) {
            reject(e);
          },
          connectError(_s, e) {
            reject(e);
          },
        },
      }).catch(reject);
    });
    return true;
  } catch {
    return false;
  }
}

/** Self-heal ticker: if the socket path stops answering (unlinked, or stolen
 *  by another process that then exited), drop the orphaned listener and
 *  rebind. Turns the stolen-socket incident class from "every interactive run
 *  wedges until a human restarts the service" into a ≤30s blip. */
function startRunRpcSocketHeal(): void {
  if (g.__runRpcHealTicker) return;
  g.__runRpcHealTicker = setInterval(() => {
    void (async () => {
      if (!g.__runRpcServer) return;
      const sock = rpcSocketPath(BACKSTAGE_CHATS_DIR);
      if (await rpcSocketPathAlive(sock)) return;
      console.warn(`[run-rpc] socket path dead or stolen — rebinding ${sock}`);
      audit({ msg: "run_rpc_socket_heal", socket: sock });
      try {
        (g.__runRpcServer as { stop?: (force?: boolean) => void })?.stop?.(true);
      } catch {}
      g.__runRpcServer = undefined;
      startRunRpcServer();
    })();
  }, 30_000);
  (g.__runRpcHealTicker as { unref?: () => void }).unref?.();
}
