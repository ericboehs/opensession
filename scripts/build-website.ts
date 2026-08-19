import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildWebsiteTailwind } from "./website-tailwind";

const root = join(import.meta.dir, "..");
const outdir = join(root, ".website-dist");

rmSync(outdir, { recursive: true, force: true });
await buildWebsiteTailwind(root);

const result = await Bun.build({
	entrypoints: [
		join(root, "packages", "clients", "website", "index.html"),
		join(root, "packages", "clients", "website", "product-demo.html"),
		join(root, "packages", "clients", "website", "setup.html"),
	],
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

const outputs = result.outputs;
const named = (page: string, suffix: string, kind?: string) =>
	outputs.find((output) => {
		const name = output.path.split("/").pop() || "";
		return (
			name.startsWith(`${page}-`) &&
			name.endsWith(suffix) &&
			(!kind || output.kind === kind)
		);
	});

// Bun points a page's <script> at a shared chunk rather than at the page's own
// entry, so the served product preview loaded a module that only re-exports and
// the demo app never booted (the landing page sat on its loading state). Wire
// each page to its real entry-point output, and prove it carries that page's
// code before writing the stable filename.
for (const page of ["index", "product-demo", "setup"]) {
	const html = named(page, ".html");
	const entry = named(page, ".js", "entry-point");
	if (!html) throw new Error(`${page}.html build produced no HTML entry`);
	if (!entry) throw new Error(`${page}.html build produced no script entry`);
	const script = `/${entry.path.split("/").pop()}`;
	// Structural, not copy: a headline edit must not fail the build (it did).
	const proof =
		page === "index"
			? "waitlist-dialog"
			: page === "setup"
				? "setup-wizard"
				: "bks-demo-presence";
	if (!(await Bun.file(entry.path).text()).includes(proof))
		throw new Error(`${script} is not the entry for ${page}.html`);
	const markup = (await Bun.file(html.path).text()).replace(
		/(<script[^>]*\ssrc=")[^"]+(")/,
		`$1${script}$2`,
	);
	await Bun.write(join(outdir, `${page}.html`), markup);
	rmSync(html.path, { force: true });
}

// Static hosts resolve `/setup` through a directory index. Keep setup.html as
// the explicit fallback while making the clean canonical URL deployable with
// no host-specific rewrite.
mkdirSync(join(outdir, "setup"), { recursive: true });
copyFileSync(join(outdir, "setup.html"), join(outdir, "setup", "index.html"));

// Keep one stable, crawler-friendly image path in addition to the hashed icon
// Bun emits for the page itself. A dedicated landscape social card can replace
// this without changing any metadata URLs.
copyFileSync(
	join(root, "packages", "clients", "mac", "build", "icon-512.png"),
	join(outdir, "opensession-social.png"),
);

const bytes = outputs.reduce((total, output) => total + output.size, 0);
console.log(
	`Website built: ${outputs.length + 2} files -> .website-dist (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
);
