/**
 * Static app shell assets: icons, service worker, splash images, hashed SPA assets, PWA manifest.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { existsSync } from "fs";
import type { RouteContext } from "./context";
import { configuredIntegration, configuredRepos, productName } from "../config";
import { FRONTEND_DIST, FRONTEND_SRC, frontend } from "../frontend-build";
import { isLocalProfile } from "../profile";

// GitHub owner avatars for the repo-icon route, fetched once and kept warm for
// a day. Avatar PNGs are public and served off GitHub's CDN (not the API
// quota); on a fetch failure we serve the stale copy so tiles don't flicker
// back to letter swatches when github.com hiccups.
const avatarCache = new Map<
	string,
	{ at: number; bytes: ArrayBuffer; type: string }
>();
const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;

async function ownerAvatar(
	owner: string,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
	const cached = avatarCache.get(owner);
	if (cached && Date.now() - cached.at < AVATAR_TTL_MS) return cached;
	try {
		const res = await fetch(
			`https://github.com/${encodeURIComponent(owner)}.png?size=128`,
			{ redirect: "follow", signal: AbortSignal.timeout(5000) },
		);
		if (!res.ok) return cached ?? null;
		const entry = {
			at: Date.now(),
			bytes: await res.arrayBuffer(),
			type: res.headers.get("content-type") || "image/png",
		};
		avatarCache.set(owner, entry);
		return entry;
	} catch {
		return cached ?? null;
	}
}

export async function handleStaticAssetsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	// Local servers proxy the hosted shell and every matching asset so the Mac
	// app never runs frontend code from a stale checkout.
	if (isLocalProfile()) return undefined;

	const { req, url, path, publicPrefix } = ctx;

	// App icons (red yin-yang, gen by scripts/gen-icons.py) — real PNGs so iOS home-screen and PWA installs
	// pick them up; data-URI apple-touch-icons don't work on iOS. Short cache
	// + must-revalidate so a refreshed design isn't pinned by a stale copy.
	const iconFiles: Record<string, string> = {
		"/backstage/apple-touch-icon.png": `${FRONTEND_SRC}/apple-touch-icon.png`, // 180×180
		"/backstage/icon-192.png": `${FRONTEND_SRC}/icon-192.png`,
		"/backstage/icon.png": `${FRONTEND_SRC}/icon.png`, // 512×512
		"/backstage/mac-app-icon.png": `${FRONTEND_SRC}/../../os1-mac/build/icon-512.png`,
	};
	if (iconFiles[path]) {
		return new Response(
			Bun.file(iconFiles[path]),
			{
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=3600, must-revalidate",
				},
			},
		);
	}

	// Per-repo icons for the RepoTile UI: a repo's configured `icon` PNG when
	// set, else the repo's GitHub org avatar, fetched server-side and cached.
	// Unregistered ids 404 — the client falls back to its colored letter tile.
	const repoIcon = path.match(/^\/backstage\/repo-icon\/([\w.-]+)\.png$/);
	if (repoIcon && req.method === "GET") {
		const id = repoIcon[1];
		// The sidebar's Plain project band (support tickets) wears the Plain
		// logo — not a repo, but it rides the same RepoTile pipeline.
		if (id === "plain") {
			return new Response(Bun.file(`${FRONTEND_SRC}/plain-icon.png`), {
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=86400",
				},
			});
		}
		// Feed bands (docs/feeds-design.md) ride the same tile pipeline:
		// any `<id>-icon.png` dropped in src/frontend serves generically.
		if (/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(id)) {
			const generic = `${FRONTEND_SRC}/${id}-icon.png`;
			if (existsSync(generic)) {
				return new Response(Bun.file(generic), {
					headers: {
						"Content-Type": "image/png",
						"Cache-Control": "public, max-age=86400",
					},
				});
			}
		}
		// A repo's optional `icon` (absolute path, or relative to its checkout)
		// overrides the org-avatar default below.
		const repo = configuredRepos()[id];
		if (repo?.icon) {
			const iconPath = repo.icon.startsWith("/")
				? repo.icon
				: `${repo.repo}/${repo.icon}`;
			if (existsSync(iconPath)) {
				return new Response(Bun.file(iconPath), {
					headers: {
						"Content-Type": "image/png",
						"Cache-Control": "public, max-age=3600, must-revalidate",
					},
				});
			}
		}
		const owner = repo?.ghRepo?.split("/")[0];
		if (!owner) return new Response("Not found", { status: 404 });
		const icon = await ownerAvatar(owner);
		if (!icon) return new Response("Not found", { status: 404 });
		return new Response(icon.bytes, {
			headers: {
				"Content-Type": icon.type,
				"Cache-Control": "public, max-age=86400",
			},
		});
	}

	// Service worker (Web Push + app-shell cache). Must precede the hashed-asset
	// matcher — sw.js is served from source, never cached hard (the browser
	// refetches it on its own schedule and applies updates).
	if (path === "/backstage/sw.js") {
		return new Response(Bun.file(`${FRONTEND_SRC}/sw.js`), {
			headers: {
				"Content-Type": "text/javascript; charset=utf-8",
				"Cache-Control": "no-cache",
				// Scope follows the prefix this registration lives under.
				"Service-Worker-Allowed": `${publicPrefix}/`,
			},
		});
	}

	// iOS PWA launch images (apple-touch-startup-image). One PNG per device
	// resolution, generated by scripts/gen-splash.py. Filename is locked to the
	// apple-splash-<w>-<h>.png pattern so the path can't escape the folder.
	const splashMatch = path.match(
		/^\/backstage\/splash\/(apple-splash-\d+-\d+\.png)$/,
	);
	if (splashMatch) {
		return new Response(
			Bun.file(`${FRONTEND_SRC}/splash/${splashMatch[1]}`),
			{
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=86400",
				},
			},
		);
	}

	// ghostty-web's WASM VT engine (the Shell tab's terminal). buildFrontend
	// copies it into FRONTEND_DIST; application/wasm keeps
	// WebAssembly.instantiateStreaming happy. Stable (unhashed) name — the
	// shell requests a fixed path — so revalidate instead of immutable.
	if (path === "/backstage/ghostty-vt.wasm") {
		const wasm = Bun.file(`${FRONTEND_DIST}/ghostty-vt.wasm`);
		if (await wasm.exists()) {
			return new Response(wasm, {
				headers: {
					"Content-Type": "application/wasm",
					"Cache-Control": "public, max-age=3600, must-revalidate",
				},
			});
		}
	}

	// Built SPA assets (prod only). Content-hashed filenames → cache forever.
	// Served gzipped (computed once, then memoised) since the JS is large.
	const assetMatch =
		frontend && path.match(/^\/backstage\/([\w.-]+\.(?:js|css|map))$/);
	if (assetMatch && frontend) {
		const name = assetMatch[1];
		const file = Bun.file(`${FRONTEND_DIST}/${name}`);
		if (await file.exists()) {
			const type = name.endsWith(".css")
				? "text/css"
				: name.endsWith(".map")
					? "application/json"
					: "text/javascript";
			const headers: Record<string, string> = {
				"Content-Type": `${type}; charset=utf-8`,
				"Cache-Control": "public, max-age=31536000, immutable",
			};
			if ((req.headers.get("accept-encoding") || "").includes("gzip")) {
				let gz = frontend.gzip.get(name);
				if (!gz) {
					gz = new Blob([
						Bun.gzipSync(new Uint8Array(await file.arrayBuffer())),
					]);
					frontend.gzip.set(name, gz);
				}
				headers["Content-Encoding"] = "gzip";
				headers["Vary"] = "Accept-Encoding";
				return new Response(gz, { headers });
			}
			return new Response(file, { headers });
		}
	}
	if (path === "/backstage/manifest.webmanifest") {
		return Response.json(
			{
				name: productName(),
				short_name: productName(),
				// Per-prefix PWA identity: installs from the legacy /backstage
				// pages keep their identity; /opensession installs get the new
				// start_url. One re-install event max, never a broken one.
				start_url: `${publicPrefix}/`,
				display: "standalone",
				// On desktop, take over the OS titlebar: the window controls
				// overlay our own chrome instead of a separate OS bar with a
				// centered title. Falls back to plain standalone where WCO
				// isn't supported (iOS, older browsers). CSS handles the
				// controls inset + drag region under (display-mode:
				// window-controls-overlay).
				display_override: ["window-controls-overlay"],
				background_color: "#0b0809",
				theme_color: "#0b0809",
				icons: [
					{
						src: `${publicPrefix}/icon-192.png?v=4`,
						sizes: "192x192",
						type: "image/png",
						purpose: "any",
					},
					{
						src: `${publicPrefix}/icon.png?v=4`,
						sizes: "512x512",
						type: "image/png",
						purpose: "any",
					},
				],
			},
			{ headers: { "Content-Type": "application/manifest+json" } },
		);
	}

	// Universal links for the OS¹ desktop app (tellahq/os1-mac): lets plain
	// https://os.tella.dev/… links open the app once it's signed with the
	// associated-domains entitlement. Both spec locations, since Apple has
	// probed the bare path historically. Caveat: os.tella.dev resolves to a
	// tailnet IP, so Apple's AASA CDN can't fetch this — team devices need the
	// entitlement's `?mode=developer` alternate (direct fetch) for links to
	// activate; harmless for everyone else.
	if (
		path === "/backstage/.well-known/apple-app-site-association" ||
		path === "/backstage/apple-app-site-association"
	) {
		const configuredIds = configuredIntegration("clients").appleAppIds;
		const appIDs = Array.isArray(configuredIds)
			? configuredIds.filter((id): id is string => typeof id === "string")
			: [];
		return Response.json(
			{
				applinks: {
					apps: [],
					details: [
						{
							appIDs,
							components: [{ "/": "/*" }],
						},
					],
				},
			},
			{ headers: { "Cache-Control": "public, max-age=3600" } },
		);
	}

	return undefined;
}
