type StaticAsset = string | { src: string };

/** Normalize Bun's URL imports and Next.js static-image modules. */
export function assetUrl(asset: StaticAsset): string {
  return typeof asset === "string" ? asset : asset.src;
}
