import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: {
    // The preview imports the production web client from this monorepo.
    root: path.resolve(__dirname, "../../.."),
  },
  async rewrites() {
    return [
      { source: "/product-demo.html", destination: "/product-demo" },
      { source: "/setup.html", destination: "/setup" },
    ];
  },
};

export default config;
