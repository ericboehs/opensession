/**
 * public-ingress — the isolated PUBLIC dial-back listener for remote sandboxes
 * (docs/self-hosting-sandboxes.md "Public dial-back ingress").
 *
 * Remote providers (Daytona/E2B) run on third-party compute: their run hosts
 * and MCP proxies must dial back to the server's /run-ws and /rpc-ws
 * WebSocket routes from the public internet. The main
 * Bun.serve binds the tailnet and carries the whole app, so instead of
 * exposing IT, this module runs a SECOND Bun.serve that serves only the
 * narrow sandbox transport and workload-identity surface:
 *
 *   - /run-ws/<hostId>  (WS upgrade — run host event stream)
 *   - /rpc-ws           (WS upgrade — opensession-* MCP proxy channel; same
 *                        historical prefixes accepted)
 *   - /ingress-health              (bare 200 "ok" for monitors/probes)
 *   - /workload-identity/*         (OIDC discovery, JWKS, token exchange)
 *
 * Everything else is a bodyless 404 — no app routes or frontend surface, no
 * disclosure. Auth is exactly run-ws.ts's: per-launch wsTokens keyed by
 * hostId, constant-time compared BEFORE the upgrade (shared handlers, not
 * copies — the token registry is process-global, so a token registered by a
 * launcher is valid on both listeners). On a deployment with no ws-transport
 * runs the registry is empty and every upgrade is a 403.
 *
 * Because this is internet-facing it adds one thing the tailnet path doesn't
 * need: per-IP rate limiting on upgrades and workload-token exchange attempts
 * (in-memory fixed window,
 * UPGRADES_PER_MIN/min → 429). The client IP is the socket peer, or — when
 * the peer is loopback/private, i.e. a local reverse proxy such as the Caddy
 * front that terminates TLS for it — the last X-Forwarded-For hop (the one
 * the proxy itself appended; earlier hops are client-controlled).
 *
 * Config (~/.opensession-sandbox.json → sandbox/config.ts publicIngress block):
 *   {"publicIngress": {"enabled": true, "port": 3860,
 *                      "publicBaseUrl": "wss://sessions.example.com"}}
 * The listener binds 127.0.0.1 by default — front it with a TLS terminator
 * (Caddy path routes / cloudflared tunnel); publicBaseUrl is what remote
 * launches embed as OPENSESSION_RUN_WS_URL/OPENSESSION_RPC_WS_URL (config.ts
 * remoteSandboxCallbackBaseUrl). The main server keeps serving the same
 * routes for the tailnet path (docker-ws) — this listener is additive.
 *
 * Lifecycle: started once from opensession.ts boot on loopback even before a
 * public URL is configured. That makes provider connect a Settings operation,
 * not a server-restart operation; an empty token registry still rejects every
 * upgrade. Changing the listen port/host remains a restart-level operation.
 * The server object is parked on globalThis and reused across `bun --hot`
 * reloads (same pattern as the main serve); route logic goes through an impl
 * table so edits to THIS module hot-apply through the captured handlers.
 */

import {
  handleSandboxWsUpgrade,
  sandboxWsClose,
  sandboxWsMessage,
  sandboxWsOpen,
} from "./run-ws";
import { handleSandboxPortalRelayUpgrade, sandboxPortalRelayClose, sandboxPortalRelayMessage, sandboxPortalRelayOpen } from "./sandbox-portal-relay";
import { publicIngressConfig } from "./sandbox/config";
import { handleWorkloadIdentityRequest } from "./workload-identity";

const g = globalThis as any;

// ── Per-IP upgrade rate limiting (fixed window, in-memory) ───────────────────

const UPGRADES_PER_MIN = 30;
const WINDOW_MS = 60_000;
/** Cap the table so a spoofed-source flood can't grow memory unboundedly. */
const MAX_TRACKED_IPS = 10_000;

interface RateRec {
  count: number;
  resetAt: number;
}

const rateTable: Map<string, RateRec> = (g.__publicIngressRate ??= new Map());

function pruneRateTable(now: number): void {
  if (rateTable.size < MAX_TRACKED_IPS) return;
  for (const [ip, rec] of rateTable) {
    if (rec.resetAt <= now) rateTable.delete(ip);
  }
  // Still full of live windows? Drop oldest-expiring entries — refusing new
  // IPs would let an attacker lock legitimate hosts out instead.
  if (rateTable.size >= MAX_TRACKED_IPS) {
    const excess = rateTable.size - MAX_TRACKED_IPS + 1;
    let i = 0;
    for (const ip of rateTable.keys()) {
      rateTable.delete(ip);
      if (++i >= excess) break;
    }
  }
}

/** True when this attempt is over the per-IP budget (and counts it). */
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = rateTable.get(ip);
  if (!rec || rec.resetAt <= now) {
    pruneRateTable(now);
    rateTable.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > UPGRADES_PER_MIN;
}

function isLocalPeer(addr: string): boolean {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr.startsWith("127.") ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("::ffff:127.")
  );
}

/** Rate-limit key for a request: the socket peer, or the proxy-appended
 *  (LAST) X-Forwarded-For hop when the peer is a local reverse proxy. */
function clientIp(req: Request, server: IngressServer): string {
  const peer = server.requestIP?.(req)?.address || "unknown";
  if (isLocalPeer(peer)) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",");
      const last = parts[parts.length - 1]?.trim();
      if (last) return last;
    }
  }
  return peer;
}

// ── The listener ──────────────────────────────────────────────────────────────

/** The slice of Bun's Server this module touches (keeps tests simple). */
interface IngressServer {
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
  requestIP?(req: Request): { address: string } | null;
}

async function ingressFetch(req: Request, server: IngressServer): Promise<Response | undefined> {
  let path: string;
  try {
    path = new URL(req.url).pathname;
  } catch {
    return new Response(null, { status: 404 });
  }
  if (path === "/ingress-health") {
    return new Response("ok");
  }
  if (path === "/workload-identity/token" && rateLimited(clientIp(req, server))) {
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(Math.ceil(WINDOW_MS / 1000)) },
    });
  }
  const workloadIdentity = await handleWorkloadIdentityRequest(req);
  if (workloadIdentity) return workloadIdentity;
  if (path === "/sandbox-portal-ws") {
    // Authenticate first so expired sidecars from a coordinator restart cannot
    // spend the shared provider egress IP's whole rate-limit budget and lock a
    // newly minted, valid Portal out. Invalid attempts still count and cap.
    const response = handleSandboxPortalRelayUpgrade(req, server, path);
    if (response?.status === 403 && rateLimited(clientIp(req, server))) {
      return new Response(null, {
        status: 429,
        headers: { "retry-after": String(Math.ceil(WINDOW_MS / 1000)) },
      });
    }
    return response;
  }
  if (path.startsWith("/run-ws/") || path === "/rpc-ws") {
    if (rateLimited(clientIp(req, server))) {
      return new Response(null, {
        status: 429,
        headers: { "retry-after": String(Math.ceil(WINDOW_MS / 1000)) },
      });
    }
    return handleSandboxWsUpgrade(req, server, path);
  }
  // Everything else: a bodyless 404 — never JSON, never a route list.
  return new Response(null, { status: 404 });
}

// Hot-reload indirection (same shape as run-ws.ts): the Bun.serve handlers are
// captured once; they resolve the freshest impl per call through globalThis.
const impl = { ingressFetch };
g.__publicIngressImpl = impl;
const live = (): typeof impl => (g.__publicIngressImpl as typeof impl) ?? impl;

export interface PublicIngressHandle {
  port: number;
  hostname: string;
  stop(closeActive?: boolean): void;
}

/**
 * Start (or reuse) the public ingress listener per the publicIngress config
 * block. Returns null when disabled. `overrides` exist for the test/verify
 * suites (port 0 = ephemeral); production callers pass nothing.
 */
export function startPublicIngress(overrides?: {
  port?: number;
  host?: string;
}): PublicIngressHandle | null {
  const cfg = publicIngressConfig() || {
    enabled: true,
    port: 3860,
    host: "127.0.0.1",
  };
  const existing = g.__publicIngressServer as PublicIngressHandle | undefined;
  if (existing) return existing;
  const server = Bun.serve({
    port: overrides?.port ?? cfg.port,
    hostname: overrides?.host ?? cfg.host,
    fetch(req, srv) {
      return live().ingressFetch(req, srv as unknown as IngressServer);
    },
    websocket: {
      // Host frames can carry large tool results/attachment payloads — match
      // the main server's order of magnitude rather than Bun's 16 MB default.
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        if (!sandboxPortalRelayOpen(ws)) sandboxWsOpen(ws);
      },
      message(ws, message) {
        if (!sandboxPortalRelayMessage(ws, message as any)) sandboxWsMessage(ws, message as any);
      },
      close(ws) {
        if (!sandboxPortalRelayClose(ws)) sandboxWsClose(ws);
      },
    },
  });
  const handle: PublicIngressHandle = {
    port: server.port ?? 0,
    hostname: server.hostname ?? "127.0.0.1",
    stop: (closeActive?: boolean) => {
      server.stop(closeActive);
      if (g.__publicIngressServer === handle) g.__publicIngressServer = undefined;
    },
  };
  g.__publicIngressServer = handle;
  console.log(
    `[public-ingress] sandbox dial-back listener on ${handle.hostname}:${handle.port}` +
      (cfg.publicBaseUrl ? ` (public base ${cfg.publicBaseUrl})` : ""),
  );
  return handle;
}

/** Stop the listener (tests). Production teardown is process exit. */
export function stopPublicIngress(): void {
  (g.__publicIngressServer as PublicIngressHandle | undefined)?.stop(true);
}

/** Test hook: clear the rate table so suites don't bleed into each other. */
export function resetPublicIngressRateLimit(): void {
  rateTable.clear();
}
