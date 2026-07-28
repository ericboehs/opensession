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
 * has no import-time side effects; providers whose backing credential is
 * absent (e.g. no TELLA_API_KEY) simply don't register, which hides the band.
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
}

export interface FeedProvider {
  descriptor: FeedDescriptor;
  listItems(): Promise<FeedItem[]>;
}

interface FeedEntry {
  provider: FeedProvider;
  cache: { items: FeedItem[]; ts: number } | null;
}

// Parked on globalThis like the other state modules so a hot reload (dev)
// keeps the registry; the systemd flow restarts the whole process anyway.
const registry: Map<string, FeedEntry> = ((globalThis as any).__osFeeds ??=
  new Map<string, FeedEntry>());

const ITEMS_TTL = 60_000;

export function registerFeed(provider: FeedProvider): void {
  registry.set(provider.descriptor.id, { provider, cache: null });
}

export function listFeedDescriptors(): FeedDescriptor[] {
  return [...registry.values()].map((e) => e.provider.descriptor);
}

/** Items for one feed, cached ~60s (every open browser polls this). */
export async function getFeedItems(feedId: string): Promise<FeedItem[] | null> {
  const entry = registry.get(feedId);
  if (!entry) return null;
  if (entry.cache && Date.now() - entry.cache.ts < ITEMS_TTL)
    return entry.cache.items;
  const items = await entry.provider.listItems();
  entry.cache = { items, ts: Date.now() };
  return items;
}

let registered = false;
/** Idempotently register the built-in providers (called from the routes). */
export async function ensureFeedsRegistered(): Promise<void> {
  if (registered) return;
  registered = true;
  const { registerTellaFeed } = await import("../agents/tella/feed");
  registerTellaFeed();
}
