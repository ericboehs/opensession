/**
 * Execution-node registration and management.
 *
 * `POST /api/nodes/register` is the only route a remote machine calls, and the
 * only one that is not operator-authenticated — it authenticates with a
 * short-lived pairing code instead, because a machine being attached does not
 * yet have any credential. Everything protecting it lives in nodes.ts: the
 * caller must be on the tailnet, and the code is one-time and expires in ten
 * minutes.
 *
 * The peer address is taken from the socket, never from the request body. A
 * node that could name its own address could claim to be on the tailnet from
 * anywhere, which would defeat the entire gate.
 */

import { requestUser, type RouteContext } from "./context";
import { disconnectNode } from "../node-ws";
import {
  createPairing,
  isTailnetAddress,
  listNodes,
  listPairings,
  registerNode,
  removeNode,
  touchNode,
  authenticateNode,
  type NodePlatform,
} from "../nodes";

/** Socket peer address, with the proxy hop preferred when fronted locally. */
function peerAddress(ctx: RouteContext): string {
  // hotServe parks the live server here so it survives hot reloads.
  const server = (globalThis as any).__backstageServer as
    | { requestIP?(req: Request): { address: string } | null }
    | undefined;
  const direct = server?.requestIP?.(ctx.req)?.address ?? "";
  // A local reverse proxy (Caddy) shows up as loopback; in that case the last
  // X-Forwarded-For hop is the one the proxy itself appended. Earlier hops are
  // client-controlled and must not be trusted.
  if (direct === "127.0.0.1" || direct === "::1" || direct === "::ffff:127.0.0.1") {
    const forwarded = ctx.req.headers.get("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded.split(",").map((h) => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return direct;
}

function publicNode(node: ReturnType<typeof listNodes>[number]) {
  // tokenHash never leaves the process.
  const { tokenHash, ...rest } = node;
  return rest;
}

export async function handleNodesRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  // ── list ──
  if (path === "/backstage/api/nodes" && req.method === "GET") {
    return Response.json({ nodes: listNodes().map(publicNode) });
  }

  // ── mint a pairing code ──
  if (path === "/backstage/api/nodes/pair" && req.method === "POST") {
    const { code, expiresAt } = createPairing(requestUser(ctx) || undefined);
    return Response.json({ code, expiresAt, pending: listPairings().length });
  }

  // ── register (called by the node itself, with a pairing code) ──
  if (path === "/backstage/api/nodes/register" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }

    const platform = String(body.platform ?? "");
    if (!["darwin", "linux", "win32"].includes(platform)) {
      return Response.json({ error: `unsupported platform '${platform}'` }, { status: 400 });
    }

    const result = registerNode({
      code: String(body.code ?? ""),
      name: String(body.name ?? ""),
      platform: platform as NodePlatform,
      arch: String(body.arch ?? "unknown"),
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
      label: typeof body.label === "string" ? body.label : undefined,
      // From the socket, never the body — see the module doc.
      address: peerAddress(ctx),
    });

    if (!result.ok) {
      // A bad pairing code and an off-tailnet caller are both 403: this is the
      // one unauthenticated route, so it should not help someone distinguish
      // "wrong code" from "wrong network".
      return Response.json({ error: result.error }, { status: 403 });
    }

    return Response.json({
      node: publicNode(result.node),
      // The only time the plaintext token is ever returned.
      token: result.token,
    });
  }

  // ── heartbeat (node proves it is still alive) ──
  if (path === "/backstage/api/nodes/heartbeat" && req.method === "POST") {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const id = req.headers.get("x-opensession-node") ?? "";
    const node = id && token ? authenticateNode(id, token) : undefined;
    if (!node) return Response.json({ error: "unauthorized" }, { status: 401 });

    if (!isTailnetAddress(peerAddress(ctx))) {
      return Response.json({ error: "not on the tailnet" }, { status: 403 });
    }
    touchNode(node.id);
    return Response.json({ ok: true });
  }

  // ── remove ──
  const match = path.match(/^\/backstage\/api\/nodes\/(node-[^/]+)$/);
  if (match && req.method === "DELETE") {
    if (!removeNode(match[1])) {
      return Response.json({ error: "no such node" }, { status: 404 });
    }
    // Authentication happens at upgrade, so removing the record alone would
    // leave an already-attached node running commands until its socket dropped.
    const wasConnected = disconnectNode(match[1]);
    return Response.json({ ok: true, disconnected: wasConnected });
  }

  return undefined;
}
