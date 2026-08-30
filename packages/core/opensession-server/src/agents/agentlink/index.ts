/**
 * Agent Link — surfaces pi and Claude Code sessions running on this host.
 *
 * Stage 1 (see docs/agent-link-bridge.md): read-only listing. Live mesh peers
 * appear as a sidebar feed band, and in the session list with
 * `source: "agent-link"`. No transcript, no steering.
 *
 * The feed is the surface that actually renders. `/api/sessions` rows are
 * derived into sidebar entries by workspace (frontend/lib/sidebar-workspaces
 * returns nothing for a row with no `workspaceId`, and its only fallback is a
 * `/worktrees/` path), and a terminal session working in an ordinary checkout
 * has neither. Feeds are the documented seam for external objects, so the
 * band is where these belong; the session rows remain for API consumers.
 *
 * Security posture:
 *  - Nothing here can send a peer anything; the send path is not implemented.
 *  - Peer-supplied strings (name, cwd, status) are data. They are projected
 *    into list rows and never interpreted.
 *  - Integration agents do not load under OPENSESSION_DEV=1, so a dev
 *    instance never shows the operator's real terminal sessions.
 */

import type { AgentModule } from "../types";
import type { FeedItem, FeedProvider } from "../../server/feeds";
import {
  registerExternalSessionProvider,
  unregisterExternalSessionProvider,
  type ExternalSessionRow,
} from "../../server/external-sessions";
import { listMeshPeers, type MeshPeer } from "./mesh-registry";
import { listWorkspaces } from "../../server/workspaces";

/** External-ref kind for a mesh peer. Feed items are opened into a workspace
 *  carrying this kind plus the peer's session id. */
const FEED_REF_KIND = "agentlink";

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

/**
 * The workspace a peer has been opened into, if any.
 *
 * Opening a feed item resolves a workspace carrying `externalRef
 * {kind: "agentlink", id}`, but that workspace is session-less, and
 * `/api/workspaces?active=1` — the list the UI actually renders — keeps only
 * workspaces some session row points at. Linking the row back to the
 * workspace is what makes it appear: it satisfies the active filter, and it
 * gives sidebar-workspaces the `workspaceId` it requires to draw a row at all.
 */
function workspaceIdForPeer(peer: MeshPeer): string | undefined {
  if (!peer.sessionId) return undefined;
  try {
    for (const ws of listWorkspaces()) {
      for (const ref of ws.externalRefs || []) {
        if (ref.kind === FEED_REF_KIND && ref.id === peer.sessionId)
          return ws.id;
      }
    }
  } catch {
    // The workspace store is not essential to listing peers.
  }
  return undefined;
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
    workspaceId: workspaceIdForPeer(peer),
    createdAt: started,
    lastActivity: started,
    archived: false,
  };
}

/** Lane keys double as the descriptor's lane list — see getFeed(). */
const LANE_RUNNING = "running";
const LANE_IDLE = "idle";

/** `/Users/me/Code/x` reads better as `~/Code/x` in a narrow sidebar. */
function tildify(dir: string): string {
  const home = process.env.HOME;
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

function toFeedItem(peer: MeshPeer): FeedItem {
  const running = isRunning(peer.status);
  return {
    // Becomes ExternalRef.id, so it has to outlive a poll. A mesh session id
    // is unique; a pid is only unique while the process lives, but it is the
    // only handle a peer without one gives us.
    id: peer.sessionId ?? `pid:${peer.pid ?? peer.sock}`,
    title: peer.name,
    // Peer-supplied text. Rendered as a label, never interpreted.
    preview: peer.cwd ? tildify(peer.cwd) : undefined,
    lane: running ? LANE_RUNNING : LANE_IDLE,
    ts: peer.startedAt,
    meta: {
      cwd: peer.cwd,
      status: peer.status,
      ...(peer.pid !== undefined ? { pid: peer.pid } : {}),
      ...(peer.kind ? { kind: peer.kind } : {}),
      ...(peer.entrypoint ? { entrypoint: peer.entrypoint } : {}),
    },
  };
}

/** Registry entries are written by whichever agent owns the session. Claude
 *  Code registers `cli`; pi-agent-link registers `pi`. Only pi sessions are
 *  in scope: they are the ones whose transcript this server can read, so a
 *  Claude peer could only ever render as a row that opens to nothing. */
const PI_ENTRYPOINT = "pi";

/** Live pi peers. Entries without an entrypoint are excluded rather than
 *  assumed: a mislabelled Claude session would show a row with no transcript. */
async function livePiPeers(): Promise<MeshPeer[]> {
  const peers = await listMeshPeers();
  return peers.filter((p) => p.entrypoint === PI_ENTRYPOINT);
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

  /**
   * The sidebar band. Unlike the config feeds, items come from a local
   * registry read rather than an MCP tool call, so there is no per-viewer
   * grant to honor and every viewer sees the same peers — they are processes
   * on this host, not objects in someone's external account.
   *
   * No `mcpServers`: a mesh peer is not an MCP source, and declaring one
   * would widen what sessions opened from this band can reach.
   *
   * Note the feeds layer caches items for 60s, so a peer's status can lag by
   * that much in the band even though the provider itself refreshes at 5s.
   */
  getFeed(): FeedProvider | null {
    return {
      descriptor: {
        id: "agentlink",
        title: "Agent Link",
        refKind: FEED_REF_KIND,
        lanes: [
          { key: LANE_RUNNING, label: "Running", dot: "var(--blue)" },
          { key: LANE_IDLE, label: "Idle", dot: "var(--text-faint)" },
        ],
        // Opening an item resolves a (session-less) workspace and foregrounds
        // this tab. The iframe is served by routes/agentlink.ts and renders
        // the peer's pi transcript as escaped text.
        panel: {
          label: "Transcript",
          embedUrlTemplate: "/agentlink/peer/{id}",
        },
        searchMeta: ["cwd", "status"],
      },
      listItems: async () => {
        try {
          return (await livePiPeers()).map(toFeedItem);
        } catch (err) {
          // A band that throws takes the sidebar's feed rail with it; an
          // empty band just reads as "nothing running".
          this.lastError = err instanceof Error ? err.message : String(err);
          return [];
        }
      },
    };
  }

  private async list(): Promise<ExternalSessionRow[]> {
    const now = Date.now();
    if (now < this.cache.expiresAt) return this.cache.rows;
    try {
      const rows = (await livePiPeers()).map(toRow);
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
