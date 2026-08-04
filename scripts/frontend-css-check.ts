import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileTailwindCss } from "../src/server/frontend-css";
import { assembleFrontendShell } from "../src/server/frontend-shell";

const root = join(import.meta.dir, "..");
const globalCss = join(root, "src", "frontend", "styles", "global.css");
const migrationCheck = process.argv.includes("--migration-complete");

if (migrationCheck && existsSync(globalCss)) {
	throw new Error("global.css still exists; the migration completion gate must run after it is removed");
}

await compileTailwindCss();

const source = readFileSync(join(root, "src", "frontend", "index.html"), "utf8");
const html = assembleFrontendShell(source, {
	instance: "{}",
	productName: "OpenSession",
	entryName: "App-test.js",
	baseCssName: "app-test.css",
	tailwindCssName: "tailwind-test.css",
});
for (const expected of ["/App-test.js", "/app-test.css", "/tailwind-test.css"]) {
	if (!html.includes(expected)) throw new Error(`assembled production shell is missing ${expected}`);
}

console.log(`frontend CSS checks passed${migrationCheck ? " (migration complete)" : ""}`);
