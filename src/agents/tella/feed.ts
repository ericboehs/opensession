/**
 * Tella feed provider: the VIEWER's recent videos as a sidebar band
 * (docs/feeds-design.md). Backed by the Tella MCP server's list_videos tool
 * on the viewer's own OAuth grant (workspace grant fallback) — no REST
 * client, no API key. Items carry the embed + editor URLs in meta so the
 * workspace's Video tab can render in-place (the edit/view pages send
 * `frame-ancestors 'none'` until tella-fusion PR #5332; the embed page is
 * embeddable today).
 */
import { registerFeed, type FeedItem, type FeedProvider } from "../../server/feeds";
import { listRecentVideos, tellaConfigured, tellaEditUrl } from "./api";

/** The provider, or null while unconfigured (module contract — index.ts). */
export function tellaFeedProvider(): FeedProvider | null {
  if (!tellaConfigured()) return null;
  return {
    descriptor: {
      id: "tella",
      title: "Tella",
      refKind: "tella",
      tileBg: "#7048e8",
      // Sessions in tella-video workspaces see ONLY this server (least
      // privilege — no Plain/Stripe/WorkOS in a video chat).
      mcpServers: ["tella"],
      // Band filters: the list tool's own filter args, options resolved
      // from sibling MCP tools on the viewer's grant.
      filters: [
        {
          key: "tagIds",
          label: "Tag",
          optionsFrom: {
            server: "tella",
            tool: "list_tags",
            path: "tags",
            map: { value: "id", label: "name" },
          },
        },
        {
          key: "playlistId",
          label: "Playlist",
          optionsFrom: {
            server: "tella",
            tool: "list_playlists",
            args: { limit: 50 },
            path: "channels",
            map: { value: "id", label: "name" },
          },
        },
      ],
      // Workspace tab: embed player + editor/view links (the frontend's
      // generic feed-panel renderer consumes this — no tella hardcode).
      panel: {
        label: "Video",
        embedUrlTemplate: "https://www.tella.tv/video/{id}/embed",
        links: [
          { label: "Open editor", hrefTemplate: "https://www.tella.tv/video/{id}/edit" },
          { label: "View page", hrefTemplate: "https://www.tella.tv/video/{id}/view" },
        ],
      },
    },
    async listItems(ctx?: {
      user?: string;
      args?: Record<string, string>;
    }): Promise<FeedItem[]> {
      const videos = await listRecentVideos(30, ctx?.user, ctx?.args);
      return videos
        .map((v) => ({
          id: v.id,
          title: v.name || "Untitled video",
          preview: v.description || undefined,
          ts: Date.parse(v.updatedAt || v.createdAt) || undefined,
          url: v.links?.viewPage,
          meta: {
            embedUrl: v.links?.embedPage,
            editUrl: tellaEditUrl(v.id),
            views: v.views,
            createdAt: v.createdAt,
          },
        }))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    },
  };
}

/** Legacy direct registration (pre-W4 boot orderings). */
export function registerTellaFeed(): void {
  const provider = tellaFeedProvider();
  if (provider) registerFeed(provider);
}
