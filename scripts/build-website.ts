import { copyFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, ".website-dist");

rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [join(root, "website", "index.html")],
	outdir,
	minify: true,
	splitting: true,
	sourcemap: "none",
	publicPath: "/",
	naming: {
		entry: "[name]-[hash].[ext]",
		chunk: "[name]-[hash].[ext]",
		asset: "[name]-[hash].[ext]",
	},
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

const html = result.outputs.find((output) => output.path.endsWith(".html"));
if (!html) throw new Error("website build produced no HTML entry");
renameSync(html.path, join(outdir, "index.html"));

// Keep one stable, crawler-friendly image path in addition to the hashed icon
// Bun emits for the page itself. A dedicated landscape social card can replace
// this without changing any metadata URLs.
copyFileSync(
	join(root, "os1-mac", "build", "icon-512.png"),
	join(outdir, "opensession-social.png"),
);

const bytes = result.outputs.reduce((total, output) => total + output.size, 0);
console.log(
	`Website built: ${result.outputs.length + 1} files -> .website-dist (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
);
