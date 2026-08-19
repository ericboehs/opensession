/**
 * Session assets — a per-session scratch folder for agent-produced artifacts
 * (interactive HTML/JS visualizations, generated reports, diagrams, sample
 * data) that are worth previewing but do NOT belong in any repo. This is the
 * Codex/Claude-style "session tmp folder": files live outside every worktree
 * under ~/.opensession-assets/<sessionId>/, the opensession-assets MCP tools
 * write them (so even read-only Ask sessions can produce artifacts — the
 * checkout stays untouched), and the session viewer's Assets tab renders them
 * (file tree + live preview, served by routes/session-assets.ts).
 *
 * Nothing here touches the session file: the directory on disk IS the state.
 * Writes/deletes broadcast `assets_changed` so open viewers refetch the tree.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { homedir } from "os";
import { join, normalize, resolve } from "path";
import { broadcastToSession } from "./ws-hub";

export const ASSETS_ROOT = join(homedir(), ".opensession-assets");

const ASSET_METADATA_FILE = ".opensession-assets.json";
const ASSET_METADATA_TEMP = `${ASSET_METADATA_FILE}.tmp`;

/** Keep listings and recursion bounded — this is a scratch space, not storage. */
const MAX_FILES = 2000;
const MAX_DEPTH = 12;
/** write_asset payload ceiling (decoded bytes). Bigger artifacts can be
 *  written straight into the dir with shell tools in code mode. */
export const MAX_WRITE_BYTES = 4 * 1024 * 1024;

export interface SessionAssetFile {
	/** Relative path inside the session's assets dir, "/"-separated. */
	path: string;
	size: number;
	mtime: string;
	/** Human-facing context supplied when the asset was written. */
	description?: string;
}

type AssetMetadata = Record<string, { description?: string }>;

function emptyAssetMetadata(): AssetMetadata {
	return Object.create(null) as AssetMetadata;
}

function readAssetMetadata(sessionId: string): AssetMetadata {
	try {
		const metadata = JSON.parse(
			readFileSync(join(assetsDirFor(sessionId), ASSET_METADATA_FILE), "utf8"),
		) as unknown;
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
			throw new Error("metadata is not an object");
		return Object.assign(emptyAssetMetadata(), metadata) as AssetMetadata;
	} catch (error: any) {
		if (error?.code === "ENOENT") return emptyAssetMetadata();
		throw new Error(`Could not read asset descriptions: ${error?.message || error}`);
	}
}

function writeAssetMetadata(sessionId: string, metadata: AssetMetadata): void {
	const path = join(assetsDirFor(sessionId), ASSET_METADATA_FILE);
	if (!Object.keys(metadata).length) {
		rmSync(path, { force: true });
		return;
	}
	const tempPath = join(assetsDirFor(sessionId), ASSET_METADATA_TEMP);
	writeFileSync(tempPath, JSON.stringify(metadata, null, 2));
	renameSync(tempPath, path);
}

function safeSessionId(sessionId: string): string {
	const id = (sessionId || "").trim();
	if (!/^[\w.-]+$/.test(id) || id.includes(".."))
		throw new Error(`invalid session id: ${sessionId}`);
	return id;
}

/** The session's assets dir (not created until the first write). */
export function assetsDirFor(sessionId: string): string {
	return join(ASSETS_ROOT, safeSessionId(sessionId));
}

/**
 * Resolve a user/agent-supplied relative path to an absolute path inside the
 * session's assets dir. Rejects absolute paths, traversal, and empty input.
 */
export function resolveAssetPath(
	sessionId: string,
	relPath: string,
): { abs: string; rel: string } {
	const dir = assetsDirFor(sessionId);
	const raw = (relPath || "").trim().replace(/^\.\//, "");
	if (!raw) throw new Error("path is required");
	if (raw.startsWith("/") || raw.includes("\\") || raw.split("/").includes(".."))
		throw new Error(
			`path must be relative inside the assets folder (no leading /, no ..): ${relPath}`,
		);
	const rel = normalize(raw).replace(/\\/g, "/");
	if (rel === "." || rel.startsWith("../"))
		throw new Error(`path escapes the assets folder: ${relPath}`);
	if (rel === ASSET_METADATA_FILE || rel === ASSET_METADATA_TEMP)
		throw new Error(`path is reserved for asset metadata: ${relPath}`);
	const abs = resolve(dir, rel);
	if (abs !== dir && !abs.startsWith(dir + "/"))
		throw new Error(`path escapes the assets folder: ${relPath}`);
	return { abs, rel };
}

/** Write one asset file (parent dirs created), broadcast, return its listing row. */
export function writeAsset(
	sessionId: string,
	relPath: string,
	data: Buffer,
	description?: string,
): SessionAssetFile {
	if (data.byteLength > MAX_WRITE_BYTES)
		throw new Error(
			`asset too large (${data.byteLength} bytes > ${MAX_WRITE_BYTES}); write big files directly into the assets dir instead`,
		);
	const { abs, rel } = resolveAssetPath(sessionId, relPath);
	const metadata = readAssetMetadata(sessionId);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, data);
	if (description !== undefined) {
		const clean = description.trim().slice(0, 500);
		if (clean) metadata[rel] = { description: clean };
		else delete metadata[rel];
		writeAssetMetadata(sessionId, metadata);
	}
	broadcastToSession(sessionId, { type: "assets_changed", sessionId });
	const st = statSync(abs);
	return {
		path: rel,
		size: st.size,
		mtime: st.mtime.toISOString(),
		description: metadata[rel]?.description,
	};
}

/** Flat recursive listing (the UI builds the tree client-side), sorted by path. */
export function listAssets(sessionId: string): SessionAssetFile[] {
	const dir = assetsDirFor(sessionId);
	if (!existsSync(dir)) return [];
	const metadata = readAssetMetadata(sessionId);
	const out: SessionAssetFile[] = [];
	const walk = (d: string, prefix: string, depth: number) => {
		if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= MAX_FILES) return;
			if (
				!prefix &&
				(e.name === ASSET_METADATA_FILE || e.name === ASSET_METADATA_TEMP)
			)
				continue;
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.isDirectory()) walk(join(d, e.name), rel, depth + 1);
			else if (e.isFile()) {
				try {
					const st = statSync(join(d, e.name));
					out.push({
						path: rel,
						size: st.size,
						mtime: st.mtime.toISOString(),
						description: metadata[rel]?.description,
					});
				} catch {}
			}
		}
	};
	walk(dir, "", 0);
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Merge asset folders for one canonical session and its historical aliases.
 * Canonical files win when the same relative path exists in more than one. */
export function listAssetsAcross(sessionIds: string[]): SessionAssetFile[] {
	const files = new Map<string, SessionAssetFile>();
	for (const sessionId of new Set(sessionIds)) {
		for (const file of listAssets(sessionId)) {
			if (!files.has(file.path)) files.set(file.path, file);
		}
	}
	return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Find an existing file across a canonical session and its aliases. */
export function findAssetPath(
	sessionIds: string[],
	relPath: string,
): { abs: string; rel: string; sessionId: string } | null {
	for (const sessionId of new Set(sessionIds)) {
		const candidate = resolveAssetPath(sessionId, relPath);
		if (existsSync(candidate.abs) && statSync(candidate.abs).isFile()) {
			return { ...candidate, sessionId };
		}
	}
	return null;
}

/** Delete one file (or an entire subfolder) inside the assets dir. */
export function deleteAsset(sessionId: string, relPath: string): void {
	deleteAssetAcross([sessionId], relPath);
}

/** Delete from whichever alias folder owns the file and refresh every open
 * representation of the deduped session. */
export function deleteAssetAcross(sessionIds: string[], relPath: string): void {
	const ids = [...new Set(sessionIds)];
	let deleted = false;
	for (const sessionId of ids) {
		const { abs, rel } = resolveAssetPath(sessionId, relPath);
		if (!existsSync(abs)) continue;
		rmSync(abs, { recursive: true, force: true });
		const metadata = readAssetMetadata(sessionId);
		for (const path of Object.keys(metadata)) {
			if (path === rel || path.startsWith(`${rel}/`)) delete metadata[path];
		}
		writeAssetMetadata(sessionId, metadata);
		deleted = true;
	}
	if (!deleted) throw new Error(`no such asset: ${relPath}`);
	for (const sessionId of ids) {
		broadcastToSession(sessionId, { type: "assets_changed", sessionId });
	}
}

// Preview/serving MIME map. Text types get charset so inline previews render
// correctly; anything unknown serves as octet-stream (download).
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".tsv": "text/tab-separated-values; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".yaml": "text/plain; charset=utf-8",
	".yml": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".py": "text/plain; charset=utf-8",
	".ts": "text/plain; charset=utf-8",
	".tsx": "text/plain; charset=utf-8",
	".jsx": "text/plain; charset=utf-8",
	".sh": "text/plain; charset=utf-8",
	".sql": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".woff2": "font/woff2",
};

export function assetMime(path: string): string {
	const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
	return MIME[ext] || "application/octet-stream";
}
