/**
 * OS¹ for Mac auto-update feed + release artifact proxy.
 *
 * The Electron shell (os1-mac/) auto-updates via Electron's built-in
 * Squirrel.Mac updater pointed at `GET /api/os1-mac/update?version=<installed>`
 * using its static JSON feed mode. Releases are the signed + notarized arm64
 * zips that .github/workflows/os1-mac-release.yml publishes to the private
 * GitHub repo — which Squirrel's plain NSURLSession can't reach — so `GET
 * /api/os1-mac/download/<tag>.zip` proxies the asset through the gh CLI,
 * disk-cached under ~/.opensession-os1-mac-updates/<tag>/.
 *
 * Both endpoints are exempt from the web-auth gate (opensession.ts fetch
 * preamble): Squirrel carries no cookies, and the origin is tailnet-only, so
 * like /api/health they're open by nature.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { $ } from "bun";
import type { RouteContext } from "./context";
import { configuredServer } from "../config";

const RELEASE_REPO = "tellahq/backstage";
const HOME = process.env.HOME || "/home/ubuntu";
const CACHE_DIR = `${HOME}/.opensession-os1-mac-updates`;
const LATEST_TTL_MS = 5 * 60 * 1000;

interface LatestRelease {
	tag: string; // e.g. "v0.2.0"
	version: [number, number, number];
	notes: string;
	publishedAt: string;
	/** Release asset name, e.g. "OS1-0.2.0-arm64.zip". */
	asset: string;
	/** REST asset URL (api.github.com/…/releases/assets/<id>). */
	assetApiUrl: string;
}

const g = globalThis as {
	__os1UpdateLatest?: { at: number; value: LatestRelease | null };
	__os1UpdateDownloads?: Map<string, Promise<string | null>>;
};

function parseVersion(v: string): [number, number, number] | null {
	const m = String(v)
		.trim()
		.replace(/^v/, "")
		.match(/^(\d+)\.(\d+)\.(\d+)/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Latest published release (memory-cached) — null when none or gh failed. */
async function latestRelease(): Promise<LatestRelease | null> {
	const cached = g.__os1UpdateLatest;
	if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.value;
	let value: LatestRelease | null = null;
	try {
		// REST on purpose (not `gh release view`/`download`, which go through
		// GraphQL): the two API pools are metered separately, and pr-info's gh
		// traffic periodically exhausts GraphQL while core stays healthy.
		const raw = await $`gh api repos/${RELEASE_REPO}/releases/latest`
			.quiet()
			.text();
		const rel = JSON.parse(raw) as {
			tag_name?: string;
			body?: string;
			published_at?: string;
			assets?: { name?: string; url?: string }[];
		};
		const version = parseVersion(rel.tag_name || "");
		const asset = (rel.assets || []).find((a) =>
			/^OS1-.*-arm64\.zip$/.test(a?.name || ""),
		);
		if (version && rel.tag_name && asset?.name && asset?.url) {
			value = {
				tag: rel.tag_name,
				version,
				notes: (rel.body || "").slice(0, 4000),
				publishedAt: rel.published_at || new Date().toISOString(),
				asset: asset.name,
				assetApiUrl: asset.url,
			};
		}
	} catch (err) {
		const stderr = (err as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
		console.warn(`[os1-update] gh release view failed: ${err} ${stderr}`.trim());
		// Keep serving the stale value (if any) rather than flapping to 204.
		value = cached?.value ?? null;
	}
	g.__os1UpdateLatest = { at: Date.now(), value };
	return value;
}

/**
 * Fetch the release zip into the disk cache (once — concurrent requests share
 * one download) and return its path, or null on failure.
 */
async function cachedAssetPath(rel: LatestRelease): Promise<string | null> {
	const dir = `${CACHE_DIR}/${rel.tag}`;
	const file = `${dir}/${rel.asset}`;
	if (existsSync(file)) return file;
	const downloads = (g.__os1UpdateDownloads ??= new Map());
	let inflight = downloads.get(rel.tag);
	if (!inflight) {
		inflight = (async () => {
			// Download to a temp dir then move into place so a crashed/partial
			// download never gets served.
			const tmp = `${CACHE_DIR}/.tmp-${rel.tag}-${Date.now()}`;
			try {
				mkdirSync(tmp, { recursive: true });
				await $`gh api ${rel.assetApiUrl} -H "Accept: application/octet-stream" > ${tmp}/${rel.asset}`.quiet();
				mkdirSync(CACHE_DIR, { recursive: true });
				rmSync(dir, { recursive: true, force: true });
				await $`mv ${tmp} ${dir}`.quiet();
				// Drop caches of older tags — only the latest is ever served.
				for (const entry of readdirSync(CACHE_DIR)) {
					if (entry !== rel.tag)
						rmSync(`${CACHE_DIR}/${entry}`, { recursive: true, force: true });
				}
				return existsSync(file) ? file : null;
			} catch (err) {
				// Transient failures (e.g. GitHub rate-limit exhaustion) are fine:
				// Squirrel retries on its next check. Just don't leave debris.
				const stderr = (err as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
				console.warn(`[os1-update] release download failed: ${err} ${stderr}`.trim());
				rmSync(tmp, { recursive: true, force: true });
				return null;
			} finally {
				downloads.delete(rel.tag);
			}
		})();
		downloads.set(rel.tag, inflight);
	}
	return inflight;
}

export async function handleOs1UpdateRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path } = ctx;
	if (!path.startsWith("/backstage/api/os1-mac/")) return undefined;
	if (req.method !== "GET") return undefined;

	// Squirrel.Mac static JSON feed. Squirrel compares currentRelease with the
	// app version itself; unlike the dynamic server mode, this mode cannot use a
	// 204 response to signal that the app is current.
	if (path === "/backstage/api/os1-mac/update") {
		const current = parseVersion(url.searchParams.get("version") || "");
		const rel = await latestRelease();
		if (!rel) {
			const currentRelease = current?.join(".") || "0.0.0";
			return Response.json({ currentRelease, releases: [] });
		}
		// Canonical public form is prefix-less (os.tella.dev root); it
		// normalizes back onto /backstage/api/* in the fetch preamble.
		const base = configuredServer().publicBaseUrl.replace(/\/$/, "");
		return Response.json({
			currentRelease: rel.version.join("."),
			releases: [
				{
					version: rel.version.join("."),
					updateTo: {
						version: rel.version.join("."),
						url: `${base}/api/os1-mac/download/${rel.tag}.zip`,
						name: rel.tag,
						notes: rel.notes,
						pub_date: rel.publishedAt,
					},
				},
			],
		});
	}

	// The signed app zip Squirrel installs from.
	const dl = path.match(/^\/backstage\/api\/os1-mac\/download\/(v\d+\.\d+\.\d+[\w.-]*)\.zip$/);
	if (dl) {
		const rel = await latestRelease();
		if (!rel || rel.tag !== dl[1]) {
			return Response.json({ error: "Unknown release" }, { status: 404 });
		}
		const file = await cachedAssetPath(rel);
		if (!file) {
			return Response.json({ error: "Release asset unavailable" }, { status: 502 });
		}
		return new Response(Bun.file(file), {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${rel.asset}"`,
				"Cache-Control": "no-cache",
			},
		});
	}

	return undefined;
}
