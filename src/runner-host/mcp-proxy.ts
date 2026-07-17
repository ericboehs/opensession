/**
 * mcp-proxy — a stdio MCP server that forwards tools/list and tools/call to
 * the backstage process over its run-rpc unix socket (src/server/run-rpc.ts).
 *
 * Spawned by Codex as a stdio MCP server, one instance per opensession-* server
 * (BKS_MCP_SERVER names which one). The actual tool implementations close
 * over live backstage state and must execute there, while Codex can only
 * consume external stdio MCP servers.
 *
 * Env (set in the injected MCP config by codex-runner.ts / host.ts):
 *   BKS_RPC_SOCKET  — backstage's run-rpc unix socket path, OR
 *   BKS_RPC_WS_URL  — backstage's /backstage/rpc-ws WebSocket route (remote
 *                     sandboxes, where a unix socket can't cross the boundary)
 *   BKS_RPC_WS_HOST — WS mode: this run's hostId (the rpc-ws upgrade is
 *                     authenticated per ws-transport run, not per rpc token)
 *   BKS_RPC_WS_AUTH — WS mode: the run's wsToken, the upgrade bearer
 *   BKS_RPC_TOKEN   — per-run bearer sent IN each frame (maps to session +
 *                     user via dispatchRunRpc; also the unix-socket bearer)
 *   BKS_MCP_SERVER  — which interactive server to proxy (e.g. opensession-sessions)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SOCK = process.env.BKS_RPC_SOCKET || "";
const WS_URL = process.env.BKS_RPC_WS_URL || "";
const WS_HOST = process.env.BKS_RPC_WS_HOST || "";
const WS_AUTH = process.env.BKS_RPC_WS_AUTH || "";
const TOKEN = process.env.BKS_RPC_TOKEN || "";
const SERVER_NAME = process.env.BKS_MCP_SERVER || "";
if ((!SOCK && !WS_URL) || !TOKEN || !SERVER_NAME || (WS_URL && (!WS_HOST || !WS_AUTH))) {
  console.error(
    "mcp-proxy: BKS_RPC_SOCKET or BKS_RPC_WS_URL (+ BKS_RPC_WS_HOST/BKS_RPC_WS_AUTH), plus BKS_RPC_TOKEN and BKS_MCP_SERVER are required",
  );
  process.exit(2);
}
/** The rpc-ws upgrade authenticates per ws-transport run: hostId in the URL,
 *  wsToken as the bearer (src/server/run-ws.ts). Frames still carry TOKEN. */
const WS_DIAL_URL = WS_URL
  ? `${WS_URL}${WS_URL.includes("?") ? "&" : "?"}host=${encodeURIComponent(WS_HOST)}`
  : "";

/** An error the backstage side answered with — retrying won't change it. */
class RpcError extends Error {}

// ── WS transport: one persistent connection, request/response frames by id ───
// Frames out: {id, path, token, server, tool?, args?}; frames in:
// {id, status, body}. A dropped connection rejects the in-flight waiters as
// retryable — same semantics as a unix-socket connect failure (the attempt is
// re-sent after reconnect until the deadline).

let wsLive: WebSocket | null = null;
let wsDialing: Promise<WebSocket> | null = null;
const wsPending = new Map<
  string,
  { resolve: (v: { status: number; body: any }) => void; reject: (e: unknown) => void }
>();

function ensureWs(): Promise<WebSocket> {
  if (wsLive && wsLive.readyState === WebSocket.OPEN) return Promise.resolve(wsLive);
  if (wsDialing) return wsDialing;
  wsDialing = new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    let sock: WebSocket;
    try {
      // Bun extension: custom headers on the client handshake.
      sock = new WebSocket(WS_DIAL_URL, {
        headers: { authorization: `Bearer ${WS_AUTH}` },
      } as unknown as string[]);
    } catch (e) {
      wsDialing = null;
      reject(e);
      return;
    }
    sock.onopen = () => {
      wsLive = sock;
      wsDialing = null;
      if (!settled) {
        settled = true;
        resolve(sock);
      }
    };
    sock.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg?.t === "pong") return;
      const waiter = wsPending.get(String(msg?.id || ""));
      if (waiter) {
        wsPending.delete(String(msg.id));
        waiter.resolve({ status: Number(msg.status) || 0, body: msg.body });
      }
    };
    sock.onclose = () => {
      if (wsLive === sock) wsLive = null;
      wsDialing = null;
      const err = new Error("rpc-ws connection dropped");
      for (const [id, w] of [...wsPending]) {
        wsPending.delete(id);
        w.reject(err); // retryable — rpc()'s loop re-sends after reconnect
      }
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    sock.onerror = () => {}; // onclose follows and owns the rejection
  });
  return wsDialing;
}

// Keepalive: quiet minutes-long tool calls must not look idle to Bun.serve's
// per-socket timer on the backstage side.
if (WS_URL) {
  setInterval(() => {
    try {
      if (wsLive?.readyState === WebSocket.OPEN) wsLive.send('{"t":"ping"}');
    } catch {}
  }, 30_000).unref?.();
}

async function rpcOnceWs(path: string, body: Record<string, unknown>): Promise<any> {
  const sock = await ensureWs();
  const id = crypto.randomUUID();
  const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    wsPending.set(id, { resolve, reject });
    try {
      sock.send(JSON.stringify({ id, path, token: TOKEN, server: SERVER_NAME, ...body }));
    } catch (e) {
      wsPending.delete(id);
      reject(e);
    }
  });
  const data = res.body;
  if (res.status !== 200) throw new RpcError(data?.error || `backstage RPC ${res.status}`);
  if (data && typeof data === "object" && typeof data.error === "string" && data.error) {
    throw new RpcError(data.error);
  }
  return data;
}

async function rpcOnceSocket(path: string, body: Record<string, unknown>): Promise<any> {
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
  // Long tool calls stream a 200 with heartbeat padding and report failures
  // in the body instead of the status — treat those as answered errors too.
  if (data && typeof data === "object" && typeof data.error === "string" && data.error) {
    throw new RpcError(data.error);
  }
  return data;
}

/**
 * One RPC to backstage over whichever transport is configured. Connection-
 * level failures (socket gone / WS dropped — backstage restarting) retry
 * until the deadline; anything backstage actually answered surfaces
 * immediately.
 */
async function rpc(path: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      return await (WS_URL ? rpcOnceWs(path, body) : rpcOnceSocket(path, body));
    } catch (e) {
      if (e instanceof RpcError) throw e;
      lastErr = e; // connect failure — backstage likely restarting
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `backstage unreachable at ${WS_URL || SOCK} for ${Math.round(timeoutMs / 1000)}s: ${lastErr}`
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
  // tools/list happens during the engine's MCP init, BEFORE the turn's first
  // output — so its retry budget must stay well under the runner's 90s
  // liveness guard. With the old 120s default, a dead rpc socket (backstage
  // down, or the stolen-socket incident 2026-07-17) wedged every interactive
  // turn into a liveness kill; at 20s the server just comes up with this
  // proxy marked failed and the run proceeds without opensession-* tools.
  const data = await rpc("/mcp/list", {}, 20_000);
  return { tools: data.tools || [] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    // On SHARED opencode servers, opencode-plugin-session-tag.js injects the
    // opencode session id into the tool arguments so calls can be routed to
    // the right backstage session. Strip it back out of the args (the tools'
    // schemas don't know it) and forward it as a sibling field for run-rpc's
    // per-call session resolution.
    const args: Record<string, unknown> = { ...(req.params.arguments ?? {}) };
    const ocSession = args.__bks_oc_session;
    delete args.__bks_oc_session;
    // Tool calls may block for many minutes (e.g. ask_human/ask_user waiting on
    // a teammate) — allow reconnect retries well past the backstage side's
    // 30-minute per-call ceiling (run-rpc.ts) instead of the default 2 minutes.
    const data = await rpc(
      "/mcp/call",
      {
        tool: req.params.name,
        args,
        ...(typeof ocSession === "string" && ocSession ? { ocSession } : {}),
      },
      32 * 60_000
    );
    return data.result;
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Tool call failed: ${e?.message || e}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
