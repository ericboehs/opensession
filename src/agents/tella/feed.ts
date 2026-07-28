/**
 * Tella feed provider: the key owner's recent videos as a sidebar band
 * (docs/feeds-design.md, Phase 0). Items carry the embed + editor URLs in
 * meta so the workspace's Video tab can render in-place (the edit/view pages
 * send `frame-ancestors 'none'`; the embed page is embeddable).
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
    },
    async listItems(): Promise<FeedItem[]> {
      const videos = await listRecentVideos(30);
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
