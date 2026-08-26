import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkspaceDeltaManifest,
  digestBytes,
  type BlobStore,
  type ContentDigest,
} from "../server/executors/workspace-delta";
import { applyWorkspaceDelta, scanWorkspaceDelta } from "./delta";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

class MemoryBlobs implements BlobStore {
  constructor(readonly values = new Map<ContentDigest, Uint8Array>()) {}
  async put(digest: ContentDigest, content: Uint8Array): Promise<void> {
    this.values.set(digest, content.slice());
  }
  async get(digest: ContentDigest): Promise<Uint8Array | null> {
    return this.values.get(digest)?.slice() ?? null;
  }
  async has(digest: ContentDigest): Promise<boolean> {
    return this.values.has(digest);
  }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const scanDefaults = {
  include: () => true,
  sessionId: "session-1",
  workspaceId: "workspace-1",
  baseCommit: "abcdef123456",
  generation: 1,
  parentCheckpoint: null,
  createdAt: "2026-08-22T12:00:00.000Z",
} as const;

describe("scanWorkspaceDelta", () => {
  test("deterministically captures binary files, modes, symlinks, and deletes", async () => {
    const root = await temporaryRoot("delta-scan-");
    const binary = new Uint8Array([0, 255, 128, 1, 2]);
    await writeFile(path.join(root, "binary.dat"), binary);
    await writeFile(path.join(root, "script.sh"), "#!/bin/sh\necho hi\n", {
      mode: 0o755,
    });
    await chmod(path.join(root, "script.sh"), 0o755);
    await symlink("binary.dat", path.join(root, "link"));
    const changes = [
      { path: "script.sh", kind: "tracked" as const },
      { path: "removed.txt", kind: "deleted" as const },
      { path: "link", kind: "untracked" as const },
      { path: "binary.dat", kind: "tracked" as const },
    ];
    const first = await scanWorkspaceDelta({ root, changes, ...scanDefaults });
    const second = await scanWorkspaceDelta({
      root,
      changes: [...changes].reverse(),
      ...scanDefaults,
    });
    expect(first.manifest).toEqual(second.manifest);
    expect(
      first.manifest.entries.map((entry) => [entry.path, entry.kind]),
    ).toEqual([
      ["binary.dat", "file"],
      ["link", "symlink"],
      ["removed.txt", "delete"],
      ["script.sh", "file"],
    ]);
    expect(
      first.manifest.entries.find((entry) => entry.path === "script.sh"),
    ).toMatchObject({ mode: 0o755 });
    const binaryEntry = first.manifest.entries.find(
      (entry) => entry.path === "binary.dat",
    );
    expect(binaryEntry?.kind).toBe("file");
    if (binaryEntry?.kind === "file")
      expect(first.blobs.get(binaryEntry.digest)).toEqual(binary);
    const linkEntry = first.manifest.entries.find(
      (entry) => entry.path === "link",
    );
    if (linkEntry?.kind === "symlink") {
      expect(new TextDecoder().decode(first.blobs.get(linkEntry.digest))).toBe(
        "binary.dat",
      );
    }
  });

  test("uses the injected predicate to exclude ignored and cache content", async () => {
    const root = await temporaryRoot("delta-ignore-");
    await mkdir(path.join(root, "cache"));
    await writeFile(path.join(root, "keep.txt"), "keep");
    await writeFile(path.join(root, "ignored.log"), "ignored");
    await writeFile(path.join(root, "cache", "artifact"), "cache");
    const scanned = await scanWorkspaceDelta({
      root,
      changes: [
        { path: "keep.txt", kind: "tracked" },
        { path: "ignored.log", kind: "untracked" },
        { path: "cache", kind: "untracked" },
      ],
      ...scanDefaults,
      include: (filePath) =>
        filePath !== "ignored.log" && !filePath.startsWith("cache"),
    });
    expect(scanned.manifest.entries.map((entry) => entry.path)).toEqual([
      "keep.txt",
    ]);
  });

  test("rejects traversal and does not follow symlinked directories", async () => {
    const root = await temporaryRoot("delta-safe-scan-");
    const outside = await temporaryRoot("delta-outside-");
    await writeFile(path.join(outside, "secret"), "secret");
    await symlink(outside, path.join(root, "escape"));
    await expect(
      scanWorkspaceDelta({
        root,
        changes: [{ path: "../secret", kind: "tracked" }],
        ...scanDefaults,
      }),
    ).rejects.toThrow("Unsafe workspace path");
    const scanned = await scanWorkspaceDelta({
      root,
      changes: [{ path: "escape", kind: "untracked" }],
      ...scanDefaults,
    });
    expect(scanned.manifest.entries).toHaveLength(1);
    expect(scanned.manifest.entries[0]?.kind).toBe("symlink");
    expect(
      scanned.manifest.entries.some((entry) => entry.path.includes("secret")),
    ).toBe(false);
  });
});

describe("applyWorkspaceDelta", () => {
  test("restores an exact binary, mode, symlink, and delete roundtrip", async () => {
    const source = await temporaryRoot("delta-source-");
    const target = await temporaryRoot("delta-target-");
    const binary = new Uint8Array([0, 10, 255, 0, 128]);
    await writeFile(path.join(source, "binary"), binary, { mode: 0o640 });
    await chmod(path.join(source, "binary"), 0o640);
    await writeFile(path.join(source, "run"), "run", { mode: 0o755 });
    await chmod(path.join(source, "run"), 0o755);
    await symlink("binary", path.join(source, "current"));
    await writeFile(path.join(target, "binary"), "old");
    await writeFile(path.join(target, "obsolete"), "remove me");

    const scanned = await scanWorkspaceDelta({
      root: source,
      changes: [
        { path: "current", kind: "untracked" },
        { path: "run", kind: "tracked" },
        { path: "binary", kind: "tracked" },
        { path: "obsolete", kind: "deleted" },
      ],
      ...scanDefaults,
    });
    await applyWorkspaceDelta({
      root: target,
      manifest: scanned.manifest,
      blobs: new MemoryBlobs(scanned.blobs),
    });
    expect(new Uint8Array(await readFile(path.join(target, "binary")))).toEqual(
      binary,
    );
    expect((await lstat(path.join(target, "binary"))).mode & 0o777).toBe(0o640);
    expect((await lstat(path.join(target, "run"))).mode & 0o777).toBe(0o755);
    expect(await readlink(path.join(target, "current"))).toBe("binary");
    await expect(lstat(path.join(target, "obsolete"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("validates missing and corrupt blobs before changing any file", async () => {
    const root = await temporaryRoot("delta-corrupt-");
    await writeFile(path.join(root, "untouched"), "before");
    const content = new TextEncoder().encode("after");
    const digest = digestBytes(content);
    const manifest = createWorkspaceDeltaManifest({
      ...scanDefaults,
      entries: [
        {
          kind: "file",
          path: "untouched",
          mode: 0o644,
          digest,
          size: content.byteLength,
        },
      ],
    });
    await expect(
      applyWorkspaceDelta({ root, manifest, blobs: new MemoryBlobs() }),
    ).rejects.toThrow("Missing");
    expect(await readFile(path.join(root, "untouched"), "utf8")).toBe("before");
    const corrupt = new MemoryBlobs(
      new Map([[digest, new TextEncoder().encode("wrong")]]),
    );
    await expect(
      applyWorkspaceDelta({ root, manifest, blobs: corrupt }),
    ).rejects.toThrow("Corrupt");
    expect(await readFile(path.join(root, "untouched"), "utf8")).toBe("before");
  });

  test("rejects malicious symlink ancestors without deleting outside root", async () => {
    const root = await temporaryRoot("delta-safe-apply-");
    const outside = await temporaryRoot("delta-safe-outside-");
    await writeFile(path.join(outside, "valuable"), "keep");
    await symlink(outside, path.join(root, "escape"));
    const manifest = createWorkspaceDeltaManifest({
      ...scanDefaults,
      entries: [{ kind: "delete", path: "escape/valuable" }],
    });
    await expect(
      applyWorkspaceDelta({ root, manifest, blobs: new MemoryBlobs() }),
    ).rejects.toThrow("crosses symlink");
    expect(await readFile(path.join(outside, "valuable"), "utf8")).toBe("keep");
  });
});
