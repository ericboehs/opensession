/**
 * Reader for the local cross-session mesh registry.
 *
 * pi-agent-link (github.com/ericboehs/pi-agent-link) makes pi sessions speak
 * Claude Code's own cross-session protocol, so both agents register in the
 * same place. There is no daemon and no broker: every live session drops a
 * JSON descriptor in `~/.claude/sessions/<pid>.json` naming a unix socket it
 * listens on.
 *
 * This module only *reads* that registry and probes liveness. It deliberately
 * does not implement the wire protocol — stage 1 lists sessions and nothing
 * else, so there is no code here that can send a peer anything.
 */

import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

export const MESH_REGISTRY = path.join(homedir(), ".claude", "sessions");

/** Registry files are named for the owning pid. */
const REGISTRY_FILE = /^\d+\.json$/;

/** A probe has to be short: it runs inside a session-list refresh. */
const LIVENESS_TIMEOUT_MS = 250;

export type MeshPeer = {
  pid?: number;
  sessionId?: string;
  name: string;
  cwd: string;
  status: string;
  kind?: string;
  startedAt?: number;
  sock: string;
};

/**
 * A registry entry outlives its process — a session killed with SIGKILL never
 * cleans up. Connecting is the only honest liveness test; a stale descriptor
 * fails immediately with ENOENT or ECONNREFUSED.
 */
function socketLive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(live);
    };
    const socket = connect({ path: sock });
    socket.setTimeout(LIVENESS_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Every live peer in the registry, newest first. Returns an empty list when
 * the registry is absent, which is the normal case on a host where nobody
 * runs the mesh.
 */
export async function listMeshPeers(): Promise<MeshPeer[]> {
  let files: string[];
  try {
    files = await readdir(MESH_REGISTRY);
  } catch {
    return [];
  }

  const peers: MeshPeer[] = [];
  for (const file of files) {
    if (!REGISTRY_FILE.test(file)) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(
        await readFile(path.join(MESH_REGISTRY, file), "utf8"),
      ) as Record<string, unknown>;
    } catch {
      continue; // torn write, or a file that is not ours to parse
    }
    const sock =
      typeof entry.messagingSocketPath === "string"
        ? entry.messagingSocketPath
        : "";
    if (!sock) continue;
    peers.push({
      pid: typeof entry.pid === "number" ? entry.pid : undefined,
      sessionId:
        typeof entry.sessionId === "string" ? entry.sessionId : undefined,
      name: typeof entry.name === "string" ? entry.name : `pid ${entry.pid}`,
      cwd: typeof entry.cwd === "string" ? entry.cwd : "",
      status: typeof entry.status === "string" ? entry.status : "unknown",
      kind: typeof entry.kind === "string" ? entry.kind : undefined,
      startedAt:
        typeof entry.startedAt === "number" ? entry.startedAt : undefined,
      sock,
    });
  }

  const live = await Promise.all(peers.map((p) => socketLive(p.sock)));
  return peers
    .filter((_, i) => live[i])
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}
