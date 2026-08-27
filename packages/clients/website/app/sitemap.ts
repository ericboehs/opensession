import type { MetadataRoute } from "next";

const BASE = "https://www.opensession.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE}/`, priority: 1 },
    { url: `${BASE}/announcement`, priority: 0.7 },
  ];
}
