/**
 * Agent Link — surfaces pi and Claude Code sessions running on this host.
 *
 * Stage 1 (see docs/agent-link-bridge.md): read-only listing. Live mesh peers
 * appear in the session list with `source: "agent-link"`, marked slim,
 * external and read-only. No transcript, no steering.
 *
 * Security posture:
 *  - Nothing here can send a peer anything; the send path is not implemented.
 *  - Peer-supplied strings (name, cwd, status) are data. They are projected
 *    into list rows and never interpreted.
 *  - Integration agents do not load under OPENSESSION_DEV=1, so a dev
 *    instance never shows the operator's real terminal sessions.
 */

import type { AgentModule } from "../types";
import {
  registerExternalSessionProvider,
  unregisterExternalSessionProvider,
  type ExternalSessionRow,
} from "../../server/external-sessions";
import { listMeshPeers, type MeshPeer } from "./mesh-registry";

export const AGENT_LINK_SOURCE = "agent-link";

/** Probing every socket on each list refresh would be wasteful: the sidebar
 *  refreshes far more often than a terminal session starts or exits. */
const CACHE_TTL_MS = 5_000;

/** A pid is reused; a mesh session id is not. Prefer it, fall back to pid, and
 *  namespace either so a foreign id can never collide with a real session. */
function rowId(peer: MeshPeer): string {
  return `${AGENT_LINK_SOURCE}:${peer.sessionId ?? peer.pid ?? peer.sock}`;
}

/** pi-agent-link publishes `idle`, `thinking`, and `tool:<name>`. Anything
 *  other than idle means a turn is in flight. */
function isRunning(status: string): boolean {
  return status !== "idle" && status !== "unknown";
}

function toRow(peer: MeshPeer): ExternalSessionRow {
  const started = peer.startedAt
    ? new Date(peer.startedAt).toISOString()
    : undefined;
  return {
    id: rowId(peer),
    source: AGENT_LINK_SOURCE,
    slim: true,
    external: true,
    readOnly: true,
    title: peer.name,
    // Stage 1 does not resolve a peer's cwd to a registered repository, and
    // claiming a repo we have not verified would mis-group the row. Say so
    // explicitly rather than letting a missing `repo` imply the default
    // checkout.
    repoLess: true,
    worktreeDir: peer.cwd || undefined,
    isRunning: isRunning(peer.status),
    runState: peer.status,
    mode: peer.kind,
    createdAt: started,
    lastActivity: started,
    archived: false,
  };
}

export class AgentLinkAgent implements AgentModule {
  name = "agentlink";

  private cache: { rows: ExternalSessionRow[]; expiresAt: number } = {
    rows: [],
    expiresAt: 0,
  };
  private lastCount = 0;
  private lastError: string | null = null;

  getRoutes() {
    // No webhooks: the mesh is local and pull-based.
    return new Map<string, (req: Request, url: URL) => Promise<Response>>();
  }

  async startup(): Promise<void> {
    registerExternalSessionProvider({
      source: AGENT_LINK_SOURCE,
      list: () => this.list(),
    });
  }

  async shutdown(): Promise<void> {
    unregisterExternalSessionProvider(AGENT_LINK_SOURCE);
  }

  health(): Record<string, unknown> {
    return {
      peers: this.lastCount,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private async list(): Promise<ExternalSessionRow[]> {
    const now = Date.now();
    if (now < this.cache.expiresAt) return this.cache.rows;
    try {
      const rows = (await listMeshPeers()).map(toRow);
      this.cache = { rows, expiresAt: now + CACHE_TTL_MS };
      this.lastCount = rows.length;
      this.lastError = null;
      return rows;
    } catch (err) {
      // Serve the last good answer rather than flickering rows out of the
      // sidebar on one bad read.
      this.lastError = err instanceof Error ? err.message : String(err);
      this.cache = { rows: this.cache.rows, expiresAt: now + CACHE_TTL_MS };
      return this.cache.rows;
    }
  }
}
