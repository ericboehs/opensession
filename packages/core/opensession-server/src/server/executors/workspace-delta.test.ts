import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkspaceDeltaManifest,
  digestBytes,
  InMemoryWorkspaceCheckpointMetadataStore,
  LocalFilesystemBlobStore,
  type BlobStore,
  type ContentDigest,
  WorkspaceCheckpointStore,
} from "./workspace-delta";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

class MemoryBlobs implements BlobStore {
  values = new Map<ContentDigest, Uint8Array>();
  puts = 0;
  failAt = Number.POSITIVE_INFINITY;

  async put(digest: ContentDigest, content: Uint8Array): Promise<void> {
    this.puts++;
    if (this.puts === this.failAt) throw new Error("injected upload failure");
    if (digestBytes(content) !== digest) throw new Error("digest mismatch");
    this.values.set(digest, content.slice());
  }
  async get(digest: ContentDigest): Promise<Uint8Array | null> {
    return this.values.get(digest)?.slice() ?? null;
  }
  async has(digest: ContentDigest): Promise<boolean> {
    return this.values.has(digest);
  }
}

const bytes = (value: string) => new TextEncoder().encode(value);
const fixedTime = "2026-08-22T12:00:00.000Z";

function manifest(input: {
  generation?: number;
  parent?: ContentDigest | null;
  files?: Array<[string, Uint8Array]>;
}) {
  const files = input.files ?? [["file.txt", bytes("contents")]];
  return createWorkspaceDeltaManifest({
    sessionId: "session-1",
    workspaceId: "workspace-1",
    baseCommit: "0123456789abcdef",
    generation: input.generation ?? 1,
    parentCheckpoint: input.parent ?? null,
    entries: files.map(([filePath, content]) => ({
      kind: "file" as const,
      path: filePath,
      mode: 0o644,
      digest: digestBytes(content),
      size: content.byteLength,
    })),
    createdAt: fixedTime,
  });
}

function publication(value: ReturnType<typeof manifest>, files: Uint8Array[]) {
  return {
    manifest: value,
    blobs: new Map(files.map((content) => [digestBytes(content), content])),
  };
}

describe("workspace delta manifest and blob storage", () => {
  test("produces a deterministic ordered manifest without provider metadata", () => {
    const a = bytes("a");
    const z = bytes("z");
    const first = manifest({
      files: [
        ["z.bin", z],
        ["a.bin", a],
      ],
    });
    const second = manifest({
      files: [
        ["a.bin", a],
        ["z.bin", z],
      ],
    });
    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "a.bin",
      "z.bin",
    ]);
    expect(JSON.stringify(first)).not.toMatch(/provider|credential/i);
  });

  test("rejects absolute, traversal, git, duplicate, and malformed paths", () => {
    for (const unsafe of [
      "/etc/passwd",
      "../secret",
      "a/../../secret",
      ".git/config",
      "a\\b",
    ]) {
      expect(() => manifest({ files: [[unsafe, bytes("x")]] })).toThrow(
        "workspace path",
      );
    }
    expect(() =>
      manifest({
        files: [
          ["same", bytes("a")],
          ["same", bytes("b")],
        ],
      }),
    ).toThrow("Duplicate");
  });

  test("stores binary content under an explicit private local root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-blobs-"));
    roots.push(root);
    const store = new LocalFilesystemBlobStore(path.join(root, "private"));
    const binary = new Uint8Array([0, 255, 1, 128, 42]);
    const digest = digestBytes(binary);
    await store.put(digest, binary);
    expect(await store.get(digest)).toEqual(binary);
    expect(await store.has(digest)).toBe(true);
    expect(() => new LocalFilesystemBlobStore("relative")).toThrow("absolute");
    expect(
      new Uint8Array(
        await readFile(
          path.join(store.root, digest.slice(7, 9), digest.slice(9)),
        ),
      ),
    ).toEqual(binary);
  });
});

describe("WorkspaceCheckpointStore", () => {
  test("publishes only after all blobs are durable", async () => {
    const blobs = new MemoryBlobs();
    blobs.failAt = 2;
    const metadata = new InMemoryWorkspaceCheckpointMetadataStore();
    const store = new WorkspaceCheckpointStore(blobs, metadata);
    const contents = [bytes("one"), bytes("two")];
    const checkpoint = manifest({
      files: [
        ["a", contents[0]!],
        ["b", contents[1]!],
      ],
    });
    await expect(
      store.publish(publication(checkpoint, contents)),
    ).rejects.toThrow("upload failure");
    expect(await store.get("session-1", "workspace-1")).toBeNull();
  });

  test("fails closed on generation races and parent races", async () => {
    const blobs = new MemoryBlobs();
    const metadata = new InMemoryWorkspaceCheckpointMetadataStore();
    const store = new WorkspaceCheckpointStore(blobs, metadata);
    const content = bytes("contents");
    const first = manifest({});
    await store.publish(publication(first, [content]));

    await expect(
      store.publish(publication(manifest({}), [content])),
    ).rejects.toThrow("race");
    const wrongParent = digestBytes(bytes("wrong parent"));
    const second = manifest({ generation: 2, parent: wrongParent });
    await expect(store.publish(publication(second, [content]))).rejects.toThrow(
      "race",
    );
    expect((await store.get("session-1", "workspace-1"))?.manifestDigest).toBe(
      first.manifestDigest,
    );
  });

  test("rejects corrupt or missing blobs before publication", async () => {
    const metadata = new InMemoryWorkspaceCheckpointMetadataStore();
    const store = new WorkspaceCheckpointStore(new MemoryBlobs(), metadata);
    const checkpoint = manifest({});
    await expect(
      store.publish({ manifest: checkpoint, blobs: new Map() }),
    ).rejects.toThrow("Missing");
    await expect(
      store.publish(publication(checkpoint, [bytes("corrupt")])),
    ).rejects.toThrow("Missing");
    expect(await store.get("session-1", "workspace-1")).toBeNull();
  });

  test("barriers successful mutation commits on checkpoint publication", async () => {
    const blobs = new MemoryBlobs();
    const store = new WorkspaceCheckpointStore(
      blobs,
      new InMemoryWorkspaceCheckpointMetadataStore(),
    );
    const events: string[] = [];
    const content = bytes("contents");
    const checkpoint = manifest({});
    await store.commitMutatingResult({
      successful: true,
      result: "ok",
      checkpoint: publication(checkpoint, [content]),
      commit: async (result) => {
        expect(await store.get("session-1", "workspace-1")).not.toBeNull();
        events.push(result);
      },
    });
    expect(events).toEqual(["ok"]);
    await expect(
      store.commitMutatingResult({
        successful: true,
        result: "not committed",
        commit: async (result) => {
          events.push(result);
        },
      }),
    ).rejects.toThrow("requires");
    expect(events).toEqual(["ok"]);
  });
});
