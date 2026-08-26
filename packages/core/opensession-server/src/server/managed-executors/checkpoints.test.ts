import { describe, expect, test } from "bun:test";
import {
  createWorkspaceDeltaManifest,
  digestBytes,
  type BlobStore,
  type ContentDigest,
} from "../executors/workspace-delta";
import {
  InMemoryWorkspaceCheckpointMetadataStore,
  WorkspaceCheckpointStore,
} from "./checkpoints";

class MemoryBlobStore implements BlobStore {
  readonly values = new Map<ContentDigest, Uint8Array>();

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

describe("Executor workspace checkpoints", () => {
  test("exposes the provider-neutral publication barrier to Executor replacement", async () => {
    const content = new TextEncoder().encode("durable change");
    const digest = digestBytes(content);
    const manifest = createWorkspaceDeltaManifest({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      baseCommit: "abcdef",
      generation: 1,
      parentCheckpoint: null,
      entries: [
        {
          kind: "file",
          path: "change.bin",
          mode: 0o600,
          digest,
          size: content.byteLength,
        },
      ],
      createdAt: "2026-08-22T12:00:00.000Z",
    });
    const metadata = new InMemoryWorkspaceCheckpointMetadataStore();
    const store = new WorkspaceCheckpointStore(new MemoryBlobStore(), metadata);
    let committed = false;
    await store.commitMutatingResult({
      successful: true,
      result: undefined,
      checkpoint: { manifest, blobs: new Map([[digest, content]]) },
      commit: async () => {
        committed = true;
      },
    });
    expect(committed).toBe(true);
    expect((await store.get("session-1", "workspace-1"))?.manifestDigest).toBe(
      manifest.manifestDigest,
    );
  });
});
