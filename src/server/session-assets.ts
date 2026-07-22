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
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { once } from "events";
import { homedir } from "os";
import { join, normalize, resolve } from "path";
import { broadcastToSession } from "./ws-hub";

export const ASSETS_ROOT = join(homedir(), ".opensession-assets");

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
): SessionAssetFile {
	if (data.byteLength > MAX_WRITE_BYTES)
		throw new Error(
			`asset too large (${data.byteLength} bytes > ${MAX_WRITE_BYTES}); write big files directly into the assets dir instead`,
		);
	const { abs, rel } = resolveAssetPath(sessionId, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, data);
	broadcastToSession(sessionId, { type: "assets_changed", sessionId });
	const st = statSync(abs);
	return { path: rel, size: st.size, mtime: st.mtime.toISOString() };
}

/** Ceiling for import_remote_asset (opensession-assets' macOS execution-node
 *  artifact transfer) — sized for bulk screenshots/video from a remote child,
 *  not the small-scratch-file write_asset cap above. The macOS adapter's
 *  fetch is capped to the same value by its caller (interactive-mcp.ts). */
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

const IMPORT_ASSET_SCRIPT = `
import os
import signal
import stat
import sys

root, session_id, relative, temporary, expected_size, expected_sha = sys.argv[1:7]
expected_size = int(expected_size)
parts = relative.split("/")
if not relative or any(part in ("", ".", "..") for part in parts):
    print("invalid asset destination", file=sys.stderr)
    sys.exit(80)

flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
dir_flags = flags | os.O_DIRECTORY
fds = []
temporary_created = False
digest = __import__("hashlib").sha256()
received = 0
def terminate(_signum, _frame):
    raise SystemExit(143)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
try:
    current = os.open("/", dir_flags)
    fds.append(current)
    directories = [part for part in root.split("/") if part] + [session_id] + parts[:-1]
    for part in directories:
        try:
            next_fd = os.open(part, dir_flags, dir_fd=current)
        except FileNotFoundError:
            os.mkdir(part, 0o700, dir_fd=current)
            next_fd = os.open(part, dir_flags, dir_fd=current)
        current = next_fd
        fds.append(current)

    try:
        existing = os.stat(parts[-1], dir_fd=current, follow_symlinks=False)
        if stat.S_ISLNK(existing.st_mode):
            print("asset destination contains a symbolic link", file=sys.stderr)
            sys.exit(81)
        if not stat.S_ISREG(existing.st_mode):
            print("asset destination is not a regular file", file=sys.stderr)
            sys.exit(81)
    except FileNotFoundError:
        pass

    target = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
        0o600,
        dir_fd=current,
    )
    fds.append(target)
    temporary_created = True
    while True:
        chunk = os.read(0, 1024 * 1024)
        if not chunk:
            break
        received += len(chunk)
        digest.update(chunk)
        view = memoryview(chunk)
        while view:
            written = os.write(target, view)
            view = view[written:]
    if received != expected_size or digest.hexdigest() != expected_sha:
        print("imported asset integrity check failed", file=sys.stderr)
        sys.exit(82)
    os.fsync(target)
    info = os.fstat(target)
    os.replace(temporary, parts[-1], src_dir_fd=current, dst_dir_fd=current)
    temporary_created = False
    print(info.st_size)
    print(info.st_mtime_ns)
except OSError as error:
    print("asset destination contains a symbolic link or invalid path: %s" % error, file=sys.stderr)
    sys.exit(81)
finally:
    if temporary_created:
        try:
            os.unlink(temporary, dir_fd=current)
        except OSError:
            pass
    for fd in reversed(fds):
        try:
            os.close(fd)
        except OSError:
            pass
`;

export async function importAssetStream(
	sessionId: string,
	relative: string,
	source: AsyncIterable<Uint8Array>,
	expected: { size: number; sha256: string },
): Promise<SessionAssetFile> {
	if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > MAX_IMPORT_BYTES)
		throw new Error(`imported asset too large (${expected.size} bytes > ${MAX_IMPORT_BYTES})`);
	if (!/^[0-9a-f]{64}$/i.test(expected.sha256))
		throw new Error("imported asset has an invalid expected sha256");
	const { rel } = resolveAssetPath(sessionId, relative);
	const temporary = `.opensession-import-${process.pid}-${randomUUID()}`;
	const child = spawn(
		"/usr/bin/python3",
		[
			"-c",
			IMPORT_ASSET_SCRIPT,
			ASSETS_ROOT,
			safeSessionId(sessionId),
			rel,
			temporary,
			String(expected.size),
			expected.sha256.toLowerCase(),
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		if (stdout.length < 64 * 1024) stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		if (stderr.length < 64 * 1024) stderr += chunk;
	});
	const exited = new Promise<number>((resolve) => {
		child.once("error", () => resolve(1));
		child.once("close", (code) => resolve(code ?? 1));
	});
	const stdinFailed = new Promise<Error>((resolve) => {
		child.stdin.once("error", resolve);
	});
	const waitForWriter = () =>
		Promise.race([
			exited,
			stdinFailed.then((error) => Promise.reject(error)),
		]);
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, 120_000);
	(timeout as { unref?: () => void }).unref?.();
	try {
		let received = 0;
		for await (const chunk of source) {
			received += chunk.byteLength;
			if (received > MAX_IMPORT_BYTES || received > expected.size) {
				throw new Error(`remote asset exceeds its ${expected.size}-byte expected size`);
			}
			if (!child.stdin.write(Buffer.from(chunk))) {
				await Promise.race([
					once(child.stdin, "drain"),
					waitForWriter().then((code) => {
						throw new Error(`asset writer exited early with code ${code}`);
					}),
				]);
			}
		}
		child.stdin.end();
		const code = await waitForWriter();
		if (timedOut) throw new Error("imported asset write timed out");
		if (code !== 0) {
			throw new Error(
				`failed to write imported asset: ${(stderr || stdout || "unknown error").trim()}`,
			);
		}
	} catch (error) {
		child.stdin.destroy();
		child.kill();
		await exited.catch(() => 1);
		if (timedOut) throw new Error("imported asset write timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
	const [sizeLine, mtimeLine] = stdout.trim().split("\n");
	const size = Number(sizeLine);
	const mtimeNs = Number(mtimeLine);
	if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtimeNs) || mtimeNs < 0) {
		throw new Error("failed to write imported asset: invalid helper response");
	}
	const result = { path: rel, size, mtime: new Date(mtimeNs / 1_000_000).toISOString() };
	broadcastToSession(sessionId, { type: "assets_changed", sessionId });
	return result;
}

/**
 * Write an already-fetched remote artifact into the session's assets folder.
 * Same destination confinement as writeAsset (resolveAssetPath), but sized
 * for bulk transfers and re-checked here as defense in depth even though
 * callers are expected to have enforced MAX_IMPORT_BYTES during the fetch.
 */
export async function importAsset(
	sessionId: string,
	relPath: string,
	data: Buffer,
): Promise<SessionAssetFile> {
	if (data.byteLength > MAX_IMPORT_BYTES)
		throw new Error(
			`imported asset too large (${data.byteLength} bytes > ${MAX_IMPORT_BYTES})`,
		);
	const sha256 = createHash("sha256").update(data).digest("hex");
	return importAssetStream(
		sessionId,
		relPath,
		(async function* () {
			yield data;
		})(),
		{ size: data.byteLength, sha256 },
	);
}

/** Flat recursive listing (the UI builds the tree client-side), sorted by path. */
export function listAssets(sessionId: string): SessionAssetFile[] {
	const dir = assetsDirFor(sessionId);
	if (!existsSync(dir)) return [];
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
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.isDirectory()) walk(join(d, e.name), rel, depth + 1);
			else if (e.isFile()) {
				try {
					const st = statSync(join(d, e.name));
					out.push({
						path: rel,
						size: st.size,
						mtime: st.mtime.toISOString(),
					});
				} catch {}
			}
		}
	};
	walk(dir, "", 0);
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Delete one file (or an entire subfolder) inside the assets dir. */
export function deleteAsset(sessionId: string, relPath: string): void {
	const { abs } = resolveAssetPath(sessionId, relPath);
	if (!existsSync(abs)) throw new Error(`no such asset: ${relPath}`);
	rmSync(abs, { recursive: true, force: true });
	broadcastToSession(sessionId, { type: "assets_changed", sessionId });
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
