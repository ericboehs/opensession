/**
 * In-process prod SPA bundle: build (or rebuild) the frontend without a
 * process restart, so a CSS/frontend change never interrupts a live run.
 * Serving stays in the HTTP layer; this module owns the bundle state
 * (globalThis-parked, mutated in place) and the debounced rebuild.
 */

import { join } from "path";
import { envAlias } from "./rename-compat";
import { writeFileAtomic } from "./shared/atomic-write";
import { broadcastToAll } from "./ws-hub";
// The dev-mode SPA entry: Bun's HTML import (HMR bundle). Prod serves the
// prebuilt index.html instead.
import homepage from "../frontend/index.html";

const g = globalThis as any;

export const IS_DEV = envAlias("OPENSESSION_DEV", "BACKSTAGE_DEV") === "1";
const REPO_ROOT = join(import.meta.dir, "..", "..");
export const FRONTEND_DIST = join(REPO_ROOT, ".frontend-dist");
export const FRONTEND_SRC = join(REPO_ROOT, "src", "frontend");

export type FrontendBundle = {
	indexHtml: string;
	gzip: Map<string, Blob>;
	version: string;
};

// Build (or rebuild) the prod SPA bundle in-process. The result object on
// globalThis is MUTATED in place (never reassigned) so the long-lived `frontend`
// reference + route closures pick up a rebuild without a process restart —
// which is the whole point: a CSS/frontend change no longer needs a `systemctl
// restart` that would interrupt every in-flight Claude run. `version` changes
// whenever the entry or CSS hash changes, so clients know to refresh.
export async function buildFrontend(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [`${FRONTEND_SRC}/App.tsx`],
		outdir: FRONTEND_DIST,
		minify: true,
		splitting: true,
		sourcemap: "none",
		// Root-relative assets: the app is served at the bare domain root
		// (os.tella.dev); old /opensession + /backstage page URLs 301 there, and
		// prefixed asset requests still normalize in the fetch preamble.
		publicPath: "/",
		naming: {
			entry: "[name]-[hash].[ext]",
			chunk: "[name]-[hash].[ext]",
			asset: "[name]-[hash].[ext]",
		},
	});
	if (!result.success) {
		throw new AggregateError(result.logs, "frontend build failed");
	}
	// Bun's HTML-entry splitting mis-points the bootstrap <script> at a leaf
	// chunk, so we build the JS entry and stitch index.html ourselves: keep the
	// source shell (icons, splash, manifest links) and point it at the hashed
	// entry + the extracted CSS.
	const entry = result.outputs.find((o) => o.kind === "entry-point");
	if (!entry) throw new Error("frontend build produced no entry point");
	const entryName = entry.path.split("/").pop()!;

	// Bun 1.3.14's CSS minifier strips the space after var(...) and breaks the
	// .panel-overlay / .sidebar-overlay inset (and a few color-mix percentages),
	// which knocks out the mobile overlay layer. Bypass it: write the source CSS
	// unmodified with a content-hashed name and serve it ourselves.
	let cssSrc = await Bun.file(`${FRONTEND_SRC}/styles/global.css`).text();
	// xterm stylesheet (the Shell tab) rides along in the same file, vendored
	// straight from the installed package so it can't drift from the JS.
	try {
		const xtermCss = await Bun.file(
			`${REPO_ROOT}/node_modules/@xterm/xterm/css/xterm.css`,
		).text();
		cssSrc += `\n\n/* ── vendored @xterm/xterm/css/xterm.css (Shell tab) ── */\n${xtermCss}`;
	} catch {}
	const cssHash = Bun.hash(cssSrc).toString(36);
	const cssName = `global-${cssHash}.css`;
	// Atomic: a mid-write bundle file has shipped corrupt before ("useState is
	// not defined") — never serve a torn asset.
	writeFileAtomic(`${FRONTEND_DIST}/${cssName}`, cssSrc);

	// Tailwind pass (see styles/tailwind.css). Bun can't compile Tailwind, so
	// the real compiler runs as a subprocess (~50ms); its lightningcss minifier
	// doesn't have the var() bug above. Linked after global.css so utilities win
	// source-order ties against legacy rules. Fail-soft: a broken Tailwind
	// compile ships the bundle without utilities rather than taking down the
	// whole server (this build also runs at boot, before Bun.serve).
	let twName: string | null = null;
	try {
		const twTmp = `${FRONTEND_DIST}/.tailwind-build.css`;
		const twProc = Bun.spawn(
			[
				`${REPO_ROOT}/node_modules/.bin/tailwindcss`,
				"-i",
				`${FRONTEND_SRC}/styles/tailwind.css`,
				"-o",
				twTmp,
				"--minify",
			],
			{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
		);
		if ((await twProc.exited) !== 0) {
			throw new Error(await new Response(twProc.stderr).text());
		}
		const twCss = await Bun.file(twTmp).text();
		twName = `tailwind-${Bun.hash(twCss).toString(36)}.css`;
		writeFileAtomic(`${FRONTEND_DIST}/${twName}`, twCss);
	} catch (e) {
		console.error(
			"[frontend] Tailwind build FAILED — serving without utilities:",
			e,
		);
	}

	let indexHtml = await Bun.file(`${FRONTEND_SRC}/index.html`).text();
	indexHtml = indexHtml.replace(
		'<script type="module" src="./App.tsx"></script>',
		`<script type="module" crossorigin src="/${entryName}"></script>`,
	);
	const twLink = twName
		? `\n  <link rel="stylesheet" href="/${twName}">`
		: "";
	indexHtml = indexHtml.replace(
		"</head>",
		`  <link rel="stylesheet" href="/${cssName}">${twLink}\n</head>`,
	);
	const version = `${entryName}|${cssName}|${twName ?? "no-tw"}`;

	const store: FrontendBundle = (g.__backstageFrontend ??= {
		indexHtml: "",
		gzip: new Map<string, Blob>(),
		version: "",
	});
	store.indexHtml = indexHtml;
	store.gzip.clear(); // stale gzipped blobs were keyed by the old hashed names
	store.version = version;
	console.log(
		`Frontend built: ${result.outputs.length} files → ${FRONTEND_DIST} (v=${version})`,
	);
	return version;
}

if (!IS_DEV && !g.__backstageFrontend) {
	console.log("Building frontend (split + minified)…");
	await buildFrontend();
}

export const frontend: FrontendBundle | null = IS_DEV
	? null
	: (g.__backstageFrontend as FrontendBundle);

// SPA entry: the HMR bundle in dev, the prebuilt index.html in prod. Reads
// `frontend.indexHtml` fresh on each request so an in-process rebuild is served
// immediately (the object is mutated, not replaced).
export const spaEntry = frontend
	? () =>
			new Response(frontend.indexHtml, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			})
	: homepage;

// Debounced in-process rebuild + client nudge. Triggered by the frontend
// file-watch, a SIGUSR2 signal, or POST /backstage/api/rebuild-frontend — all of
// which replace the "systemctl restart to see my CSS change" habit that was
// interrupting every live Claude run. Clients get a non-intrusive refresh toast;
// the bundle is served from the mutated `frontend` object with no restart.
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildInFlight = false;
export function scheduleFrontendRebuild(reason: string, debounceMs = 300): void {
	if (IS_DEV || !frontend) return;
	if (rebuildTimer) clearTimeout(rebuildTimer);
	rebuildTimer = setTimeout(async () => {
		rebuildTimer = null;
		if (rebuildInFlight) return scheduleFrontendRebuild(reason, 300); // coalesce
		rebuildInFlight = true;
		const before = frontend.version;
		try {
			const version = await buildFrontend();
			if (version !== before) {
				console.log(
					`[frontend] Rebuilt (${reason}); notifying clients (v=${version})`,
				);
				broadcastToAll({ type: "frontend_updated", version });
			}
		} catch (e) {
			console.error(`[frontend] Rebuild failed (${reason}):`, e);
			broadcastToAll({
				type: "notice",
				message: `Frontend rebuild failed — see logs. (${e})`,
			});
		} finally {
			rebuildInFlight = false;
		}
	}, debounceMs);
}
