import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/product-demo" },
    sitemap: "https://www.opensession.com/sitemap.xml",
  };
}
