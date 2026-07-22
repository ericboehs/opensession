import { describe, test, expect, afterEach } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	assetsDirFor,
	importAsset,
	importAssetStream,
	MAX_IMPORT_BYTES,
	resolveAssetPath,
	writeAsset,
} from "./session-assets";

let uniq = 0;
const sessionIds: string[] = [];
const tempDirs: string[] = [];

function testSessionId(): string {
	const id = `test-session-assets-${Date.now()}-${++uniq}`;
	sessionIds.push(id);
	return id;
}

afterEach(() => {
	for (const id of sessionIds.splice(0)) {
		try {
			rmSync(assetsDirFor(id), { recursive: true, force: true });
		} catch {}
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveAssetPath (destination confinement)", () => {
	test("resolves a relative path inside the session's assets dir", () => {
		const id = testSessionId();
		const { abs, rel } = resolveAssetPath(id, "reports/demo.mp4");
		expect(rel).toBe("reports/demo.mp4");
		expect(abs).toBe(`${assetsDirFor(id)}/reports/demo.mp4`);
	});

	test("rejects absolute paths and traversal out of the assets dir", () => {
		const id = testSessionId();
		expect(() => resolveAssetPath(id, "/etc/passwd")).toThrow();
		expect(() => resolveAssetPath(id, "../secrets")).toThrow();
		expect(() => resolveAssetPath(id, "reports/../../secrets")).toThrow();
		expect(() => resolveAssetPath(id, "")).toThrow();
	});
});

describe("importAsset (import_remote_asset's local write helper)", () => {
	test("writes an already-fetched buffer and returns its listing row", async () => {
		const id = testSessionId();
		const payload = Buffer.from([0, 1, 2, 255, 254, 253, 128, 10, 13, 0]);
		const row = await importAsset(id, "artifacts/demo.bin", payload);
		expect(row.path).toBe("artifacts/demo.bin");
		expect(row.size).toBe(payload.byteLength);
		const onDisk = readFileSync(`${assetsDirFor(id)}/artifacts/demo.bin`);
		expect(new Uint8Array(onDisk)).toEqual(new Uint8Array(payload));
	});

	test("enforces MAX_IMPORT_BYTES even though callers are expected to cap upstream", async () => {
		const id = testSessionId();
		const oversized = Buffer.allocUnsafe(MAX_IMPORT_BYTES + 1);
		await expect(importAsset(id, "too-big.bin", oversized)).rejects.toThrow(/too large/);
	});

	test("still enforces destination confinement (no traversal via destPath)", async () => {
		const id = testSessionId();
		await expect(importAsset(id, "../escape.bin", Buffer.from("x"))).rejects.toThrow();
	});

	test("does not publish a streamed asset whose integrity check fails", async () => {
		const id = testSessionId();
		await expect(
			importAssetStream(
				id,
				"artifacts/bad.bin",
				(async function* () {
					yield Buffer.from("first ");
					yield Buffer.from("second");
				})(),
				{ size: 12, sha256: "0".repeat(64) },
			),
		).rejects.toThrow(/integrity check failed/);
		expect(existsSync(join(assetsDirFor(id), "artifacts", "bad.bin"))).toBe(false);
	});

	test("removes the temporary file when the source stream is interrupted", async () => {
		const id = testSessionId();
		const artifacts = join(assetsDirFor(id), "artifacts");
		await expect(
			importAssetStream(
				id,
				"artifacts/interrupted.bin",
				(async function* () {
					yield Buffer.alloc(1024 * 1024, 1);
					await Bun.sleep(50);
					throw new Error("source interrupted");
				})(),
				{ size: 2 * 1024 * 1024, sha256: "0".repeat(64) },
			),
		).rejects.toThrow("source interrupted");
		expect(existsSync(join(artifacts, "interrupted.bin"))).toBe(false);
		expect(readdirSync(artifacts).filter((name) => name.startsWith(".opensession-import-"))).toEqual(
			[],
		);
	});

	test("rejects a symlinked destination directory", async () => {
		const id = testSessionId();
		const outside = mkdtempSync(join(tmpdir(), "opensession-asset-escape-"));
		tempDirs.push(outside);
		mkdirSync(assetsDirFor(id), { recursive: true });
		symlinkSync(outside, join(assetsDirFor(id), "linked"), "dir");
		await expect(importAsset(id, "linked/escape.bin", Buffer.from("secret"))).rejects.toThrow(
			/symbolic link/,
		);
		expect(existsSync(join(outside, "escape.bin"))).toBe(false);
	});

	test("rejects a symlink used as the session assets directory", async () => {
		const id = testSessionId();
		const outside = mkdtempSync(join(tmpdir(), "opensession-asset-escape-"));
		tempDirs.push(outside);
		mkdirSync(join(assetsDirFor(id), ".."), { recursive: true });
		symlinkSync(outside, assetsDirFor(id), "dir");
		await expect(importAsset(id, "escape.bin", Buffer.from("secret"))).rejects.toThrow(
			/symbolic link/,
		);
		expect(existsSync(join(outside, "escape.bin"))).toBe(false);
	});

	test("rejects a symlink at the final destination", async () => {
		const id = testSessionId();
		const outside = mkdtempSync(join(tmpdir(), "opensession-asset-escape-"));
		tempDirs.push(outside);
		const outsideFile = join(outside, "target.bin");
		writeFileSync(outsideFile, "original");
		mkdirSync(assetsDirFor(id), { recursive: true });
		symlinkSync(outsideFile, join(assetsDirFor(id), "linked.bin"), "file");
		await expect(importAsset(id, "linked.bin", Buffer.from("replacement"))).rejects.toThrow(
			/symbolic link/,
		);
		expect(readFileSync(outsideFile, "utf8")).toBe("original");
	});

	test("importAsset's bigger cap is independent of write_asset's smaller one", async () => {
		const id = testSessionId();
		// A payload over write_asset's 4MB cap but comfortably under
		// importAsset's 500MB cap must succeed via importAsset.
		const size = 5 * 1024 * 1024;
		const payload = Buffer.allocUnsafe(size).fill(1);
		await expect(importAsset(id, "big-video.mp4", payload)).resolves.toBeDefined();
		expect(() => writeAsset(id, "too-big-for-write-asset.bin", payload)).toThrow(/too large/);
	});
});
