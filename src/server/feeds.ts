/**
 * Feed registry: external-object feeds (Tella videos; eventually Plain
 * tickets, any MCP/API) rendered as sidebar bands. A feed contributes a
 * descriptor (band identity + lanes) and a provider (listItems). Items
 * resolve into workspaces via resolveExternalWorkspace (workspace-resolve.ts)
 * keyed `<refKind>-<itemId>`, and the linkage is stamped as a generic
 * `externalRefs` entry — never a new one-off foreign-key field per source.
 * Design doc: docs/feeds-design.md.
 *
 * Registration is lazy (ensureFeedsRegistered from the routes) so this module
 * has no import-time side effects; providers whose backing connection is
 * absent (e.g. no tella MCP server / no OAuth grant yet) simply don't
 * register, which hides the band. MCP-backed feeds are per-viewer: items are
 * fetched on the requesting user's grant and cached per user.
 */
import type { ExternalRef } from "./types";

export type { ExternalRef };

export interface FeedItem {
  /** Stable external id (e.g. Tella `vid_…`); becomes ExternalRef.id. */
  id: string;
  title: string;
  preview?: string;
  /** Key into the descriptor's lanes; absent = the feed renders flat. */
  lane?: string;
  /** Sort timestamp (ms). Feeds return newest-first regardless. */
  ts?: number;
  /** Canonical external link (view page). */
  url?: string;
  thumbnail?: string;
  /** Source-specific extras the frontend may use (e.g. embedUrl, editUrl). */
  meta?: Record<string, unknown>;
}

export interface FeedLane {
  key: string;
  label: string;
  /** CSS color for the row dot of items in this lane. */
  dot?: string;
}

export interface FeedDescriptor {
  /** Feed id — also the RepoTile/brand icon key (e.g. "tella"). */
  id: string;
  /** Band title in the sidebar. */
  title: string;
  /** ExternalRef.kind stamped on adopted workspaces (usually = id). */
  refKind: string;
  lanes?: FeedLane[];
  /** Brand tile background for the band header. */
  tileBg?: string;
  /**
   * External MCP servers (mcp-config.json names) sessions in this feed's
   * workspaces get — their session allowlist defaults to exactly this list,
   * so a Tella-video chat never sees Plain/Stripe/WorkOS tools. Names not
   * (yet) in mcp-config are skipped by filterMcpServers, so declaring a
   * future server (e.g. "tella") is safe and lights up when it's added.
   */
  mcpServers?: string[];
}

export interface FeedProvider {
  descriptor: FeedDescriptor;
  /** `ctx.user`: the requesting viewer — MCP-backed feeds run on THEIR
   *  grant (workspace grant fallback), so the band is per-viewer. */
  listItems(ctx?: { user?: string }): Promise<FeedItem[]>;
}

interface FeedEntry {
  provider: FeedProvider;
  /** Items cached per viewer (feeds can be per-user — MCP grants). */
  cache: Map<string, { items: FeedItem[]; ts: number }>;
}

// Parked on globalThis like the other state modules so a hot reload (dev)
// keeps the registry; the systemd flow restarts the whole process anyway.
const registry: Map<string, FeedEntry> = ((globalThis as any).__osFeeds ??=
  new Map<string, FeedEntry>());

const ITEMS_TTL = 60_000;

export function registerFeed(provider: FeedProvider): void {
  registry.set(provider.descriptor.id, { provider, cache: new Map() });
}

export function listFeedDescriptors(): FeedDescriptor[] {
  return [...registry.values()].map((e) => e.provider.descriptor);
}

/** Items for one feed, cached ~60s per viewer (every open browser polls). */
export async function getFeedItems(
  feedId: string,
  user?: string,
): Promise<FeedItem[] | null> {
  const entry = registry.get(feedId);
  if (!entry) return null;
  const key = user || "";
  const cached = entry.cache.get(key);
  if (cached && Date.now() - cached.ts < ITEMS_TTL) return cached.items;
  const items = await entry.provider.listItems({ user });
  entry.cache.set(key, { items, ts: Date.now() });
  return items;
}

/**
 * The MCP allowlist for a session whose workspace carries these refs: the
 * union of the matching feeds' declared servers. Returns undefined when no
 * matching feed declares any — callers then leave the session unrestricted
 * (an EMPTY allowlist would be normalized back to "all servers" by
 * run-session, so "scoped" is only expressible as a non-empty list).
 */
export async function feedMcpServersForRefs(
  refs: Array<{ kind: string }>,
): Promise<string[] | undefined> {
  await ensureFeedsRegistered();
  const out = new Set<string>();
  for (const entry of registry.values()) {
    const d = entry.provider.descriptor;
    if (!d.mcpServers?.length) continue;
    if (refs.some((r) => r.kind === d.refKind))
      for (const s of d.mcpServers) out.add(s);
  }
  return out.size ? [...out] : undefined;
}

/**
 * The opening-context block for a session whose workspace carries these refs:
 * names the linked objects, adds the scratch-dir note for scratch sessions,
 * and for Tella refs appends the video's metadata + chapters + transcript
 * excerpt (the Plain ticket-context analogue). Used by BOTH create paths and
 * the first prompt of prompt-less creates (tab-strip "+" siblings) — a chat
 * in a feed workspace must get this no matter how it was born. Returns null
 * when there's nothing to say. Callers wrap it (wrapContext) themselves.
 */
export async function externalRefsOpeningContext(
  refs: ExternalRef[] | undefined,
  opts: { scratch?: boolean; user?: string } = {},
): Promise<string | null> {
  if (!refs?.length) return null;
  const lines = refs
    .map(
      (r) =>
        `- ${r.kind} ${r.id}${r.title ? ` — "${r.title}"` : ""}${r.url ? ` (${r.url})` : ""}`,
    )
    .join("\n");
  let out = `This chat belongs to a workspace linked to external object(s):\n${lines}`;
  if (opts.scratch)
    out +=
      "\n\nYour working directory is a scratch space (not a git repo) — download media, run ffmpeg, write files there freely. Use the available MCP tools for the linked service when the task concerns the object itself.";
  for (const r of refs.filter((x) => x.kind === "tella")) {
    try {
      const { getVideo, formatVideoContext } = await import(
        "../agents/tella/api"
      );
      const video = await getVideo(r.id, opts.user);
      if (video)
        out += `\n\nTella video context for ${r.id}:\n\n${formatVideoContext(video)}`;
    } catch (e) {
      console.error(`[feeds] Tella video lookup failed for ${r.id}:`, e);
    }
  }
  return out;
}

let registered = false;
/** Idempotently register the built-in providers (called from the routes). */
export async function ensureFeedsRegistered(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerTellaFeed } = await import("../agents/tella/feed");
  registerTellaFeed();
  // Once per boot: sweep scratch dirs whose workspace is gone (deleted
  // workspaces clean up inline in deleteWorkspace; this catches dirs from
  // before that hook and workspace-less creates). 14-day grace on mtime.
  sweepOrphanScratchDirs().catch(() => {});
}

const SCRATCH_ORPHAN_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

async function sweepOrphanScratchDirs(): Promise<void> {
  const { readdirSync, rmSync, statSync, existsSync } = await import("fs");
  const { stateDir } = await import("./rename-compat");
  const { getWorkspace } = await import("./workspaces");
  const root = stateDir("scratch");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    try {
      if (getWorkspace(entry)) continue;
      const full = `${root}/${entry}`;
      if (Date.now() - statSync(full).mtimeMs < SCRATCH_ORPHAN_GRACE_MS)
        continue;
      rmSync(full, { recursive: true, force: true });
      console.log(`[feeds] Swept orphan scratch dir ${entry}`);
    } catch {}
  }
}
