/**
 * Tella feed provider: the VIEWER's recent videos as a sidebar band
 * (docs/feeds-design.md). Backed by the Tella MCP server's list_videos tool
 * on the viewer's own OAuth grant (workspace grant fallback) — no REST
 * client, no API key. Items carry the embed + editor URLs in meta so the
 * workspace's Video tab can render in-place (the edit/view pages send
 * `frame-ancestors 'none'` until tella-fusion PR #5332; the embed page is
 * embeddable today).
 */
import { registerFeed, type FeedItem } from "../../server/feeds";
import { listRecentVideos, tellaConfigured, tellaEditUrl } from "./api";

export function registerTellaFeed(): void {
  if (!tellaConfigured()) return;
  registerFeed({
    descriptor: {
      id: "tella",
      title: "Tella",
      refKind: "tella",
      tileBg: "#7048e8",
      // Sessions in tella-video workspaces see ONLY this server (least
      // privilege — no Plain/Stripe/WorkOS in a video chat). Not in
      // mcp-config yet (the Tella MCP is OAuth 2.1); it lights up when added.
      mcpServers: ["tella"],
    },
    async listItems(ctx?: { user?: string }): Promise<FeedItem[]> {
      const videos = await listRecentVideos(30, ctx?.user);
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
  });
}
