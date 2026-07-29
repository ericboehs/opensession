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
import {
  dotGet,
  readConfigFeeds,
  type ConfigFeed,
  type FeedPanelSpec,
} from "./feeds-config";

export type { ExternalRef, FeedPanelSpec };

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

/**
 * One filter control on a feed band (docs/feeds-design.md — "filters, like
 * tella has tag/playlist filters on list_videos, configurable per
 * project/plugin"). `key` is the LIST-TOOL ARGUMENT the selected value is
 * passed as; options are static or resolved from another MCP tool on the
 * viewer's grant (e.g. tella tags via list_tags).
 */
export interface FeedFilterSpec {
  key: string;
  label: string;
  /** "arg" (default): the selected value is passed as this list-tool
   *  argument (tella tagIds/playlistId). "meta": filtered client-side
   *  against item.meta (plain assignee/labels). */
  mode?: "arg" | "meta";
  /** meta mode: dot-path into item.meta. Arrays match when SOME element's
   *  option-value path equals the selection; null/undefined matches the
   *  reserved "__unassigned__" option value. */
  field?: string;
  /** Static options (prepended before derived/fetched ones). */
  options?: { value: string; label: string }[];
  /** arg mode: resolve options from another MCP tool on the viewer's grant. */
  optionsFrom?: {
    server: string;
    tool: string;
    args?: Record<string, unknown>;
    /** Dot-path to the option array in the tool result. */
    path?: string;
    map: { value: string; label: string };
  };
  /** meta mode: derive options from the items' field values — paths applied
   *  to each element (arrays) or the value itself. */
  optionsFromItems?: { value: string; label: string };
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
  /** Web panel the workspace tab renders for this feed's items
   *  (`{id}`-templated iframe URL + header links). */
  panel?: FeedPanelSpec;
  /** Lane whose count shows as the collapsed band's attention badge
   *  (e.g. plain's Urgent lane). */
  attentionLane?: string;
  /** Filter controls the band header offers; values feed the list tool. */
  filters?: FeedFilterSpec[];
  /** Extra meta dot-paths the sidebar's text search matches besides
   *  title/preview (e.g. plain's customer name/email). */
  searchMeta?: string[];
  /** True for config-declared feeds (editable/deletable in the UI). */
  fromConfig?: boolean;
}

export interface FeedProvider {
  descriptor: FeedDescriptor;
  /** `ctx.user`: the requesting viewer — MCP-backed feeds run on THEIR
   *  grant (workspace grant fallback), so the band is per-viewer.
   *  `ctx.args`: selected filter values (descriptor.filters keys only),
   *  merged into the backing list-tool call. */
  listItems(ctx?: {
    user?: string;
    args?: Record<string, string>;
  }): Promise<FeedItem[]>;
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

/** Config feed → provider: items via one MCP tool call on the viewer's
 *  grant, fields picked by dot-path mapping (docs/feeds-design.md W3). */
function configFeedProvider(cf: ConfigFeed): FeedProvider {
  return {
    descriptor: {
      id: cf.id,
      title: cf.title,
      refKind: cf.refKind,
      ...(cf.tileBg ? { tileBg: cf.tileBg } : {}),
      ...(cf.mcpServers?.length ? { mcpServers: cf.mcpServers } : {}),
      ...(cf.panel ? { panel: cf.panel } : {}),
      fromConfig: true,
    },
    async listItems(ctx?: { user?: string }): Promise<FeedItem[]> {
      const { callMcpTool } = await import("./mcp-client");
      const raw = await callMcpTool<unknown>(
        cf.items.server,
        cf.items.tool,
        cf.items.args || {},
        ctx?.user,
      );
      const arr = dotGet(raw, cf.items.path);
      if (!Array.isArray(arr)) return [];
      const m = cf.items.map;
      return arr
        .map((it): FeedItem | null => {
          const id = dotGet(it, m.id);
          const title = dotGet(it, m.title);
          if (typeof id !== "string" || !id || typeof title !== "string")
            return null;
          const tsRaw = m.ts ? dotGet(it, m.ts) : undefined;
          const ts =
            typeof tsRaw === "number"
              ? tsRaw
              : typeof tsRaw === "string"
                ? Date.parse(tsRaw) || undefined
                : undefined;
          return {
            id,
            title,
            ...(m.preview && typeof dotGet(it, m.preview) === "string"
              ? { preview: dotGet(it, m.preview) as string }
              : {}),
            ...(ts ? { ts } : {}),
            ...(m.url && typeof dotGet(it, m.url) === "string"
              ? { url: dotGet(it, m.url) as string }
              : {}),
            ...(m.thumbnail && typeof dotGet(it, m.thumbnail) === "string"
              ? { thumbnail: dotGet(it, m.thumbnail) as string }
              : {}),
          };
        })
        .filter((x): x is FeedItem => !!x)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    },
  };
}

/** Overlay ~/.opensession-feeds.json entries onto the registry: add/update
 *  config feeds, drop removed ones. Code feeds (registered directly) win on
 *  id collision. Called by every read path so edits apply without restart. */
function syncConfigFeeds(): void {
  const config = readConfigFeeds();
  const configIds = new Set(config.map((f) => f.id));
  for (const [id, entry] of registry)
    if ((entry as any).fromConfig && !configIds.has(id)) registry.delete(id);
  for (const cf of config) {
    const existing = registry.get(cf.id);
    if (existing && !(existing as any).fromConfig) continue; // code feed wins
    const entry: FeedEntry = {
      provider: configFeedProvider(cf),
      cache: existing?.cache ?? new Map(),
    };
    (entry as any).fromConfig = true;
    registry.set(cf.id, entry);
  }
}

export function listFeedDescriptors(): FeedDescriptor[] {
  syncConfigFeeds();
  return [...registry.values()].map((e) => e.provider.descriptor);
}

/** Items for one feed, cached ~60s per viewer (every open browser polls). */
export async function getFeedItems(
  feedId: string,
  user?: string,
  args?: Record<string, string>,
): Promise<FeedItem[] | null> {
  syncConfigFeeds();
  const entry = registry.get(feedId);
  if (!entry) return null;
  const key = `${user || ""}\u0000${JSON.stringify(args || {})}`;
  const cached = entry.cache.get(key);
  if (cached && Date.now() - cached.ts < ITEMS_TTL) return cached.items;
  const items = await entry.provider.listItems({ user, args });
  entry.cache.set(key, { items, ts: Date.now() });
  return items;
}

// Filter-option lists resolved via MCP (e.g. tella tags), cached briefly.
const filterOptionsCache = new Map<
  string,
  { options: { value: string; label: string }[]; ts: number }
>();
const FILTER_OPTIONS_TTL = 5 * 60_000;

/** Options for one of a feed's filter controls, on the viewer's grant. */
export async function getFeedFilterOptions(
  feedId: string,
  filterKey: string,
  user?: string,
): Promise<{ value: string; label: string }[] | null> {
  syncConfigFeeds();
  const spec = registry
    .get(feedId)
    ?.provider.descriptor.filters?.find((f) => f.key === filterKey);
  if (!spec) return null;
  if (spec.options) return spec.options;
  if (!spec.optionsFrom) return [];
  const cacheKey = `${feedId}\u0000${filterKey}\u0000${user || ""}`;
  const cached = filterOptionsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FILTER_OPTIONS_TTL)
    return cached.options;
  const { callMcpTool } = await import("./mcp-client");
  const { dotGet } = await import("./feeds-config");
  const raw = await callMcpTool<unknown>(
    spec.optionsFrom.server,
    spec.optionsFrom.tool,
    spec.optionsFrom.args || {},
    user,
  );
  const arr = dotGet(raw, spec.optionsFrom.path);
  const options = Array.isArray(arr)
    ? arr
        .map((o) => ({
          value: String(dotGet(o, spec.optionsFrom!.map.value) ?? ""),
          label: String(dotGet(o, spec.optionsFrom!.map.label) ?? ""),
        }))
        .filter((o) => o.value && o.label)
    : [];
  filterOptionsCache.set(cacheKey, { options, ts: Date.now() });
  return options;
}

/** Drop a feed's cached items (all viewers) — mutations that change the
 *  list (e.g. Plain mark-done) call this so the next poll refetches. */
export function invalidateFeedCache(feedId: string): void {
  registry.get(feedId)?.cache.clear();
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
  syncConfigFeeds();
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
      "\n\nYour working directory is a scratch space (not a git repo) — download media, run ffmpeg, write files there freely. Use the available MCP tools for the linked service when the task concerns the object itself. IMPORTANT — showing media: the user CANNOT see files you merely save or mention by path. Whenever your work produces a video (a clip you cut, a downloaded rendition), print `BACKSTAGE_VIDEO: /absolute/path/to/file.mp4` on its own line; for an image (thumbnail, extracted frame, screenshot), print `BACKSTAGE_IMAGE: /absolute/path/to/file.png`. Each marker renders inline in the chat as a playable video / visible image — without it, the media is invisible to the user.";
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
/** Idempotently register the code-feed providers (called from the routes):
 *  every loaded AgentModule with a getFeed() contribution (the W4 plugin
 *  seam), plus the direct tella fallback for boot orderings where the module
 *  didn't load. Config feeds overlay separately (syncConfigFeeds). */
export async function ensureFeedsRegistered(): Promise<void> {
  if (registered) return;
  registered = true;
  try {
    const { getAgents } = await import("./agents-registry");
    for (const a of getAgents()) {
      if (!a.getFeed) continue;
      try {
        const provider = a.getFeed();
        if (provider) registerFeed(provider);
      } catch (e) {
        console.error(`[feeds] ${a.name}.getFeed() failed:`, e);
      }
    }
  } catch {}
  if (!registry.has("tella")) {
    const { registerTellaFeed } = await import("../agents/tella/feed");
    registerTellaFeed();
  }
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
