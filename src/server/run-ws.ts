/**
 * run-ws — the WebSocket transport for sandboxed runs (docs/sandboxes-plan.md
 * §5 Phase 3). Remote sandboxes can't share unix sockets with this host, so
 * both host-to-backstage channels get an outbound-dial WS mode: the sandbox
 * dials OUT to backstage (which already listens on the Tailscale bind), never
 * the other way around.
 *
 *  - `/backstage/run-ws/<hostId>` — the run host's event stream. The host
 *    entry (src/runner-host/host.ts, BKS_RUN_WS_URL) dials it and speaks the
 *    exact NDJSON protocol, one JSON message per text frame. Accepted sockets
 *    are bridged into the SAME HostHandle machinery as the unix-socket path:
 *    `runWsConnector(hostId)` implements host-client's HostConnector, so
 *    reconnect tolerance, respawn-to-resume, ask proxying and host-registry
 *    steer/cancel all carry over untouched.
 *  - `/backstage/rpc-ws` — the michael-* MCP proxy channel. mcp-proxy.ts
 *    (BKS_RPC_WS_URL) dials it with its existing per-run rpc token; each
 *    request frame `{id, path, token, server, tool?, args?}` goes through the
 *    same dispatchRunRpc core as the unix RPC socket and answers with
 *    `{id, status, body}`.
 *
 * Auth: per-run bearer tokens, validated BEFORE the upgrade with a
 * constant-time compare. run-ws tokens are minted at launch (spec.wsToken,
 * registered by the provider's launcher keyed by hostId); rpc-ws reuses the
 * run-rpc token registry. `{t:"ping"}` keepalive frames are answered here
 * with `{t:"pong"}` so quiet connections survive idle timers.
 *
 * Wired into the EXISTING Bun.serve in backstage.ts (fetch route + early
 * dispatch in the websocket open/message/close handlers). Those handlers are
 * captured at first server creation and survive hot reloads, so everything
 * here routes through a globalThis-parked impl table — an edit to this module
 * hot-applies through the old captured wrappers. First wire-up still needs a
 * real restart (routes don't hot-apply at all — CLAUDE.md).
 */

import {
  dispatchRunRpc,
  hasRunTokenTimingSafe,
  timingSafeEqStr,
} from "./run-rpc";
import type { HostConnection, HostConnectionHandlers, HostConnector } from "./host-client";

const g = globalThis as any;

/** The one Bun.serve capability this module needs; keeps the signature
 *  compatible with any Server<T> instantiation (backstage.ts's WSClientData
 *  server AND the verify suites' scratch servers). */
type UpgradableServer = {
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
};

/** hostId → expected bearer for the run's dial-back. */
const wsTokens: Map<string, string> = (g.__runWsTokens ??= new Map());

interface RunWsState {
  ws: any; // ServerWebSocket
  hostId: string;
  /** Frames that arrived before a HostHandle attached (e.g. the hello a fresh
   *  host sends immediately after dialing). Flushed on attach. */
  buffer: unknown[];
  consumer: HostConnectionHandlers | null;
  closed: boolean;
}

/** hostId → the live dialed-in connection (at most one per host; a redial
 *  replaces the previous socket, mirroring host.ts's single-client rule). */
const wsConns: Map<string, RunWsState> = (g.__runWsConns ??= new Map());

/** WS client data marker; backstage.ts's handlers early-return on it. */
export interface SandboxWsData {
  sandboxWs: "run-host" | "rpc";
  hostId?: string;
}

// ── Token registry (launchers mint + register; dispose unregisters) ──────────

export function registerRunWsHost(hostId: string, token: string): void {
  wsTokens.set(hostId, token);
}

export function unregisterRunWsHost(hostId: string): void {
  wsTokens.delete(hostId);
  const st = wsConns.get(hostId);
  if (st) {
    wsConns.delete(hostId);
    st.closed = true;
    try {
      st.ws.close();
    } catch {}
  }
}

// ── Upgrade handling (called from backstage.ts's fetch, and verify suites) ───

function bearerFrom(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  // Fallback for dialers that can't set headers.
  try {
    return new URL(req.url).searchParams.get("token") || "";
  } catch {
    return "";
  }
}

function handleUpgrade(
  req: Request,
  server: UpgradableServer,
  path: string,
): Response | undefined {
  if (path === "/backstage/rpc-ws") {
    const token = bearerFrom(req);
    if (!hasRunTokenTimingSafe(token)) {
      return new Response("unauthorized", { status: 403 });
    }
    const data: SandboxWsData = { sandboxWs: "rpc" };
    if (!server.upgrade(req, { data })) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  }
  const m = path.match(/^\/backstage\/run-ws\/([A-Za-z0-9_.-]+)$/);
  if (!m) return new Response("not found", { status: 404 });
  const hostId = m[1];
  const expected = wsTokens.get(hostId);
  const presented = bearerFrom(req);
  if (!expected || !presented || !timingSafeEqStr(expected, presented)) {
    return new Response("unauthorized", { status: 403 });
  }
  const data: SandboxWsData = { sandboxWs: "run-host", hostId };
  if (!server.upgrade(req, { data })) {
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  return undefined;
}

// ── WS event dispatch (early-return hooks for backstage.ts's handlers) ───────

function wsOpen(ws: any): boolean {
  const data = ws.data as Partial<SandboxWsData> | undefined;
  if (data?.sandboxWs === "run-host" && data.hostId) {
    const prev = wsConns.get(data.hostId);
    if (prev && prev.ws !== ws) {
      // Redial replaces the previous socket (host.ts keeps only one client).
      prev.closed = true;
      try {
        prev.ws.close();
      } catch {}
    }
    const st: RunWsState = {
      ws,
      hostId: data.hostId,
      buffer: [],
      consumer: null,
      closed: false,
    };
    (ws as any).__runWsState = st;
    wsConns.set(data.hostId, st);
    console.log(`[run-ws] host ${data.hostId.slice(0, 11)} dialed in`);
    return true;
  }
  if (data?.sandboxWs === "rpc") return true;
  return false;
}

function wsMessage(ws: any, message: string | Buffer): boolean {
  const data = ws.data as Partial<SandboxWsData> | undefined;
  if (data?.sandboxWs === "run-host") {
    const st: RunWsState | undefined = (ws as any).__runWsState;
    if (!st) return true;
    let msg: any;
    try {
      msg = JSON.parse(String(message));
    } catch {
      console.warn(`[run-ws] dropping malformed frame from ${st.hostId}`);
      return true;
    }
    if (msg?.t === "ping") {
      // Answer keepalives here — they must work even while no HostHandle is
      // attached (backstage mid-reattach).
      try {
        ws.send('{"t":"pong"}');
      } catch {}
      return true;
    }
    if (st.consumer) st.consumer.onMsg(msg);
    else st.buffer.push(msg);
    return true;
  }
  if (data?.sandboxWs === "rpc") {
    void handleRpcFrame(ws, message);
    return true;
  }
  return false;
}

function wsClose(ws: any): boolean {
  const data = ws.data as Partial<SandboxWsData> | undefined;
  if (data?.sandboxWs === "run-host") {
    const st: RunWsState | undefined = (ws as any).__runWsState;
    if (st && !st.closed) {
      st.closed = true;
      if (wsConns.get(st.hostId) === st) wsConns.delete(st.hostId);
      st.consumer?.onClose();
    }
    return true;
  }
  return data?.sandboxWs === "rpc";
}

async function handleRpcFrame(ws: any, message: string | Buffer): Promise<void> {
  let frame: any;
  try {
    frame = JSON.parse(String(message));
  } catch {
    return;
  }
  if (frame?.t === "ping") {
    try {
      ws.send('{"t":"pong"}');
    } catch {}
    return;
  }
  const id = String(frame?.id || "");
  if (!id) return;
  const reply = (status: number, body: unknown) => {
    try {
      ws.send(JSON.stringify({ id, status, body }));
    } catch {}
  };
  try {
    // Same core as the unix RPC socket — token re-validated per frame.
    const d = await dispatchRunRpc(String(frame?.path || ""), frame);
    if (d.kind === "immediate") reply(d.status, d.body);
    else reply(200, await d.done); // WS needs no heartbeat wrapper — pings keep the socket alive
  } catch (e: any) {
    reply(500, { error: e?.message || String(e) });
  }
}

// ── HostConnector over a dialed-in run-ws connection ──────────────────────────

function makeRunWsConnector(hostId: string): HostConnector {
  return {
    async connect(handlers: HostConnectionHandlers): Promise<HostConnection> {
      const st = wsConns.get(hostId);
      if (!st || st.closed) {
        throw new Error(`no live run-ws connection for ${hostId} yet`);
      }
      st.consumer = handlers;
      for (const m of st.buffer.splice(0)) handlers.onMsg(m as any);
      return {
        send: (msg) => {
          if (st.closed) return false;
          try {
            // Bun's ServerWebSocket.send returns 0 when the socket is
            // closed/closing — report that as undeliverable so steers queue.
            return st.ws.send(JSON.stringify(msg)) !== 0;
          } catch {
            return false;
          }
        },
        close: () => {
          try {
            st.ws.close();
          } catch {}
        },
      };
    },
    dispose() {
      unregisterRunWsHost(hostId);
    },
  };
}

// ── Hot-reload indirection ────────────────────────────────────────────────────
// backstage.ts's Bun.serve handlers are captured once (the server object is
// reused across --hot reloads); they call the exported wrappers below, which
// resolve the freshest impl through globalThis on every call.

const impl = {
  handleUpgrade,
  wsOpen,
  wsMessage,
  wsClose,
  makeRunWsConnector,
};
g.__runWsImpl = impl;
type Impl = typeof impl;
const live = (): Impl => (g.__runWsImpl as Impl) ?? impl;

/** Route handler for /backstage/run-ws/:hostId and /backstage/rpc-ws.
 *  Returns undefined when the socket was upgraded. */
export function handleSandboxWsUpgrade(
  req: Request,
  server: UpgradableServer,
  path: string,
): Response | undefined {
  return live().handleUpgrade(req, server, path);
}

/** Early-dispatch hooks for the shared websocket handlers; true = handled. */
export function sandboxWsOpen(ws: any): boolean {
  return live().wsOpen(ws);
}
export function sandboxWsMessage(ws: any, message: string | Buffer): boolean {
  return live().wsMessage(ws, message);
}
export function sandboxWsClose(ws: any): boolean {
  return live().wsClose(ws);
}

/** HostConnector for a run whose host dials back over WS (spec.wsToken set). */
export function runWsConnector(hostId: string): HostConnector {
  return live().makeRunWsConnector(hostId);
}
