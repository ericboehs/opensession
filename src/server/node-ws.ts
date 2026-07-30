/**
 * node-ws — the dial-back channel an execution node holds open, and the
 * server-side API for running a command on it.
 *
 * The node dials in rather than the server dialling out. Both ends are on the
 * tailnet so either would work, but dial-back means a node behind a restrictive
 * firewall still attaches, and it matches how the sandbox run hosts already
 * behave (run-ws.ts).
 *
 * Wire protocol, deliberately small:
 *
 *   server -> node   {t:"exec", id, command, cwd?, timeoutMs?}
 *   node   -> server {t:"out",  id, stream:"stdout"|"stderr", data}
 *   node   -> server {t:"exit", id, code}
 *   node   -> server {t:"hello", capabilities}          on connect
 *
 * Live connections are parked on globalThis so a hot reload does not drop every
 * attached node, the same pattern the rest of the server state modules use.
 *
 * SECURITY: a command sent here runs as the node's user, with that user's
 * privileges, on a machine you do not otherwise control from here. Two things
 * bound it — the node must be on the tailnet and authenticate with its own
 * token, and the MCP tool exposing this is interactive-only, so untrusted
 * automation input can never reach it (see nodes-tools.ts).
 */

import { authenticateNode, getNode, isTailnetAddress, touchNode, type ExecNode } from "./nodes";

const g = globalThis as any;

type Pending = {
  stdout: string[];
  stderr: string[];
  resolve: (value: ExecResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Connection = {
  ws: any;
  node: ExecNode;
  connectedAt: number;
  capabilities: string[];
  pending: Map<string, Pending>;
};

/** nodeId -> live connection. Survives hot reloads. */
const connections: Map<string, Connection> = (g.__opensessionNodeConns ??= new Map());

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export function connectedNodeIds(): string[] {
  return [...connections.keys()];
}

export function isNodeConnected(id: string): boolean {
  return connections.has(id);
}

export function connectedNode(id: string): Connection | undefined {
  return connections.get(id);
}

/**
 * Drop a live channel immediately.
 *
 * Revocation used to only take effect at the next connection attempt, because
 * authentication happens at upgrade. An already-attached node would have kept
 * running commands until its socket happened to drop — which for a machine
 * sitting in an office is "indefinitely". Revoking has to hang up.
 */
export function disconnectNode(id: string, reason = "revoked"): boolean {
  const conn = connections.get(id);
  if (!conn) return false;
  try {
    conn.ws.close(1008, reason);
  } catch {
    // Already gone; nodeWsClose does the bookkeeping either way.
  }
  return true;
}

// ── upgrade ──────────────────────────────────────────────────────────────────

/**
 * Handle a node's WebSocket upgrade. Returns a Response on rejection, or
 * undefined once the socket has been upgraded (Bun takes over from there).
 */
export function handleNodeWsUpgrade(
  req: Request,
  server: { upgrade(req: Request, opts: any): boolean; requestIP?(req: Request): { address: string } | null },
  path: string,
): Response | undefined {
  if (path !== "/backstage/node-ws") return undefined;

  const address = server.requestIP?.(req)?.address ?? "";
  if (!isTailnetAddress(address)) {
    return new Response("forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  // Header, not query string: a token in a URL ends up in access logs.
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  const node = id && token ? authenticateNode(id, token) : undefined;
  if (!node) return new Response("unauthorized", { status: 401 });

  const upgraded = server.upgrade(req, { data: { kind: "node", nodeId: node.id } });
  return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
}

// ── socket lifecycle ─────────────────────────────────────────────────────────

/** Returns true when this socket is a node channel (run-ws's convention). */
export function nodeWsOpen(ws: any): boolean {
  const nodeId = ws.data?.kind === "node" ? ws.data.nodeId : undefined;
  if (!nodeId) return false;

  // A reconnect replaces the old socket; the previous one is stale by
  // definition (a node holds exactly one channel).
  connections.get(nodeId)?.ws?.close?.();

  // Already authenticated at upgrade; re-read for its current metadata.
  const node = getNode(nodeId);
  if (!node) {
    ws.close();
    return true;
  }
  connections.set(nodeId, {
    ws,
    node,
    connectedAt: Date.now(),
    capabilities: node.capabilities,
    pending: new Map(),
  });
  touchNode(nodeId);
  console.log(`[nodes] ${node.name} attached (${nodeId})`);
  return true;
}

export function nodeWsMessage(ws: any, raw: string | Buffer): boolean {
  const nodeId = ws.data?.kind === "node" ? ws.data.nodeId : undefined;
  if (!nodeId) return false;
  const conn = connections.get(nodeId);
  if (!conn) return true;

  let msg: any;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return true;
  }

  switch (msg?.t) {
    case "hello":
      if (Array.isArray(msg.capabilities)) conn.capabilities = msg.capabilities.map(String);
      touchNode(nodeId);
      return true;

    case "out": {
      const pending = conn.pending.get(String(msg.id));
      if (!pending) return true;
      const bucket = msg.stream === "stderr" ? pending.stderr : pending.stdout;
      bucket.push(String(msg.data ?? ""));
      return true;
    }

    case "exit": {
      const key = String(msg.id);
      const pending = conn.pending.get(key);
      if (!pending) return true;
      clearTimeout(pending.timer);
      conn.pending.delete(key);
      pending.resolve({
        code: Number(msg.code ?? 0),
        stdout: pending.stdout.join(""),
        stderr: pending.stderr.join(""),
      });
      return true;
    }
  }
  return true;
}

export function nodeWsClose(ws: any): boolean {
  const nodeId = ws.data?.kind === "node" ? ws.data.nodeId : undefined;
  if (!nodeId) return false;
  const conn = connections.get(nodeId);
  if (!conn || conn.ws !== ws) return true;

  // Fail every in-flight command rather than leaving a caller hanging forever.
  for (const [, pending] of conn.pending) {
    clearTimeout(pending.timer);
    pending.resolve({
      code: -1,
      stdout: pending.stdout.join(""),
      stderr: pending.stderr.join("") + "\n[node disconnected]",
    });
  }
  connections.delete(nodeId);
  console.log(`[nodes] ${conn.node.name} detached (${nodeId})`);
  return true;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 200_000;

let execCounter = 0;

export type ExecOptions = { cwd?: string; timeoutMs?: number };

/**
 * Run a command on an attached node and wait for it to finish.
 *
 * Rejects if the node is not attached — callers should surface that rather than
 * queueing, because a node that is offline may be someone's closed laptop.
 */
export async function execOnNode(
  nodeId: string,
  command: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const conn = connections.get(nodeId);
  if (!conn) throw new Error(`node ${nodeId} is not connected`);

  const id = `x${++execCounter}-${Date.now().toString(36)}`;
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 60 * 60_000);

  return await new Promise<ExecResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = conn.pending.get(id);
      if (!pending) return;
      conn.pending.delete(id);
      resolve({
        code: -1,
        stdout: pending.stdout.join(""),
        stderr: pending.stderr.join(""),
        timedOut: true,
      });
    }, timeoutMs);

    conn.pending.set(id, { stdout: [], stderr: [], resolve, timer });

    try {
      conn.ws.send(JSON.stringify({ t: "exec", id, command, cwd: opts.cwd, timeoutMs }));
    } catch (err) {
      clearTimeout(timer);
      conn.pending.delete(id);
      resolve({ code: -1, stdout: "", stderr: `could not reach node: ${(err as Error).message}` });
    }
  }).then((result) => ({
    ...result,
    // Keep a runaway build log from blowing up a model's context.
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  }));
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const half = Math.floor(MAX_OUTPUT / 2);
  return (
    text.slice(0, half) +
    `\n\n[... ${text.length - MAX_OUTPUT} characters trimmed ...]\n\n` +
    text.slice(-half)
  );
}
