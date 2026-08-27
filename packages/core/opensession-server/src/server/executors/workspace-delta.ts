import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_DELTA_VERSION = 1 as const;
export type ContentDigest = `sha256:${string}`;

export interface WorkspaceDeltaFileEntry {
  kind: "file";
  path: string;
  mode: number;
  digest: ContentDigest;
  size: number;
}

export interface WorkspaceDeltaSymlinkEntry {
  kind: "symlink";
  path: string;
  mode: number;
  digest: ContentDigest;
  size: number;
}

export interface WorkspaceDeltaDeleteEntry {
  kind: "delete";
  path: string;
}

export type WorkspaceDeltaEntry =
  | WorkspaceDeltaFileEntry
  | WorkspaceDeltaSymlinkEntry
  | WorkspaceDeltaDeleteEntry;

export interface WorkspaceDeltaManifest {
  version: typeof WORKSPACE_DELTA_VERSION;
  sessionId: string;
  workspaceId: string;
  baseCommit: string;
  generation: number;
  parentCheckpoint: ContentDigest | null;
  entries: WorkspaceDeltaEntry[];
  manifestDigest: ContentDigest;
  createdAt: string;
}

export type UnsignedWorkspaceDeltaManifest = Omit<
  WorkspaceDeltaManifest,
  "manifestDigest"
>;

export interface BlobStore {
  put(digest: ContentDigest, content: Uint8Array): Promise<void>;
  get(digest: ContentDigest): Promise<Uint8Array | null>;
  has(digest: ContentDigest): Promise<boolean>;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function digestBytes(content: Uint8Array): ContentDigest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function assertContentDigest(
  digest: string,
): asserts digest is ContentDigest {
  if (!DIGEST_PATTERN.test(digest)) throw new Error("Invalid SHA-256 digest");
}

export function assertPortableWorkspacePath(relativePath: string): void {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new Error(`Unsafe workspace path: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment === ".git",
    )
  ) {
    throw new Error(`Unsafe workspace path: ${relativePath}`);
  }
  if (path.posix.normalize(relativePath) !== relativePath) {
    throw new Error(`Non-canonical workspace path: ${relativePath}`);
  }
}

function validateEntry(entry: WorkspaceDeltaEntry): void {
  assertPortableWorkspacePath(entry.path);
  if (entry.kind === "delete") return;
  if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
    throw new Error(`Invalid mode for ${entry.path}`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`Invalid size for ${entry.path}`);
  }
  assertContentDigest(entry.digest);
}

function entrySortKey(entry: WorkspaceDeltaEntry): string {
  return `${entry.path}\0${entry.kind}`;
}

export function canonicalManifestBytes(
  manifest: UnsignedWorkspaceDeltaManifest,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

export function createWorkspaceDeltaManifest(
  input: Omit<UnsignedWorkspaceDeltaManifest, "version" | "entries"> & {
    entries: WorkspaceDeltaEntry[];
  },
): WorkspaceDeltaManifest {
  if (!input.sessionId || !input.workspaceId || !input.baseCommit) {
    throw new Error("Manifest identity and base commit are required");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("Manifest generation must be a positive integer");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Manifest creation time must be an ISO timestamp");
  }
  if (input.parentCheckpoint !== null) {
    assertContentDigest(input.parentCheckpoint);
  }
  const entries = input.entries.map((entry) => ({ ...entry }));
  for (const entry of entries) validateEntry(entry);
  entries.sort((left, right) =>
    entrySortKey(left).localeCompare(entrySortKey(right), "en"),
  );
  const entryPaths = new Set(entries.map((entry) => entry.path));
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entries[index - 1]?.path === entry.path) {
      throw new Error(`Duplicate workspace path: ${entry.path}`);
    }
    const segments = entry.path.split("/");
    for (let end = 1; end < segments.length; end++) {
      if (entryPaths.has(segments.slice(0, end).join("/"))) {
        throw new Error(`Conflicting workspace paths: ${entry.path}`);
      }
    }
  }
  const unsigned: UnsignedWorkspaceDeltaManifest = {
    version: WORKSPACE_DELTA_VERSION,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    baseCommit: input.baseCommit,
    generation: input.generation,
    parentCheckpoint: input.parentCheckpoint,
    entries,
    createdAt: new Date(input.createdAt).toISOString(),
  };
  return {
    ...unsigned,
    manifestDigest: digestBytes(canonicalManifestBytes(unsigned)),
  };
}

export function validateWorkspaceDeltaManifest(
  manifest: WorkspaceDeltaManifest,
): void {
  if (manifest.version !== WORKSPACE_DELTA_VERSION) {
    throw new Error(`Unsupported workspace delta version: ${manifest.version}`);
  }
  const rebuilt = createWorkspaceDeltaManifest({
    sessionId: manifest.sessionId,
    workspaceId: manifest.workspaceId,
    baseCommit: manifest.baseCommit,
    generation: manifest.generation,
    parentCheckpoint: manifest.parentCheckpoint,
    entries: manifest.entries,
    createdAt: manifest.createdAt,
  });
  if (rebuilt.manifestDigest !== manifest.manifestDigest) {
    throw new Error("Workspace delta manifest digest mismatch");
  }
  if (JSON.stringify(rebuilt.entries) !== JSON.stringify(manifest.entries)) {
    throw new Error("Workspace delta entries are not canonically ordered");
  }
}

/** A local content-addressed store with no default or process-global location. */
export class LocalFilesystemBlobStore implements BlobStore {
  readonly root: string;

  constructor(privateOrganizationRoot: string) {
    if (!path.isAbsolute(privateOrganizationRoot)) {
      throw new Error("Blob store root must be an explicit absolute path");
    }
    this.root = path.resolve(privateOrganizationRoot);
  }

  async put(digest: ContentDigest, content: Uint8Array): Promise<void> {
    assertContentDigest(digest);
    if (digestBytes(content) !== digest)
      throw new Error("Blob digest mismatch");
    const destination = this.pathFor(digest);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(destination);
      if (digestBytes(existing) !== digest)
        throw new Error("Corrupt stored blob");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stored = await readFile(destination);
    if (digestBytes(stored) !== digest) throw new Error("Corrupt stored blob");
  }

  async get(digest: ContentDigest): Promise<Uint8Array | null> {
    assertContentDigest(digest);
    try {
      return new Uint8Array(await readFile(this.pathFor(digest)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async has(digest: ContentDigest): Promise<boolean> {
    assertContentDigest(digest);
    try {
      return (await stat(this.pathFor(digest))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private pathFor(digest: ContentDigest): string {
    const hexadecimal = digest.slice("sha256:".length);
    return path.join(this.root, hexadecimal.slice(0, 2), hexadecimal.slice(2));
  }
}

export interface WorkspaceCheckpointMetadataStore {
  get(
    sessionId: string,
    workspaceId: string,
  ): Promise<WorkspaceDeltaManifest | null>;
  compareAndSwap(input: {
    manifest: WorkspaceDeltaManifest;
    expectedGeneration: number;
    expectedParent: ContentDigest | null;
  }): Promise<boolean>;
}

export class InMemoryWorkspaceCheckpointMetadataStore implements WorkspaceCheckpointMetadataStore {
  readonly #manifests = new Map<string, WorkspaceDeltaManifest>();

  async get(
    sessionId: string,
    workspaceId: string,
  ): Promise<WorkspaceDeltaManifest | null> {
    const manifest = this.#manifests.get(`${sessionId}\0${workspaceId}`);
    return manifest ? structuredClone(manifest) : null;
  }

  async compareAndSwap(input: {
    manifest: WorkspaceDeltaManifest;
    expectedGeneration: number;
    expectedParent: ContentDigest | null;
  }): Promise<boolean> {
    const key = `${input.manifest.sessionId}\0${input.manifest.workspaceId}`;
    const current = this.#manifests.get(key);
    const currentGeneration = current?.generation ?? 0;
    const currentParent = current?.manifestDigest ?? null;
    if (
      currentGeneration !== input.expectedGeneration ||
      currentParent !== input.expectedParent
    ) {
      return false;
    }
    this.#manifests.set(key, structuredClone(input.manifest));
    return true;
  }
}

export interface WorkspaceCheckpointPublication {
  manifest: WorkspaceDeltaManifest;
  blobs: ReadonlyMap<ContentDigest, Uint8Array>;
}

export class WorkspaceCheckpointStore {
  constructor(
    private readonly blobs: BlobStore,
    private readonly metadata: WorkspaceCheckpointMetadataStore,
  ) {}

  get(
    sessionId: string,
    workspaceId: string,
  ): Promise<WorkspaceDeltaManifest | null> {
    return this.metadata.get(sessionId, workspaceId);
  }

  async publish(publication: WorkspaceCheckpointPublication): Promise<void> {
    const { manifest, blobs } = publication;
    validateWorkspaceDeltaManifest(manifest);
    const required = new Map<ContentDigest, number>();
    for (const entry of manifest.entries) {
      if (entry.kind !== "delete") required.set(entry.digest, entry.size);
    }
    for (const [digest, size] of required) {
      const content = blobs.get(digest) ?? (await this.blobs.get(digest));
      if (!content) throw new Error(`Missing checkpoint blob: ${digest}`);
      if (content.byteLength !== size || digestBytes(content) !== digest) {
        throw new Error(`Invalid checkpoint blob: ${digest}`);
      }
      await this.blobs.put(digest, content);
    }
    for (const digest of required.keys()) {
      if (!(await this.blobs.has(digest))) {
        throw new Error(`Checkpoint blob is not durable: ${digest}`);
      }
    }
    const published = await this.metadata.compareAndSwap({
      manifest,
      expectedGeneration: manifest.generation - 1,
      expectedParent: manifest.parentCheckpoint,
    });
    if (!published)
      throw new Error("Workspace checkpoint generation or parent race");
  }

  /**
   * Replacement barrier: a successful mutation is committed only after its
   * checkpoint is durable and visible. Unsuccessful results need no checkpoint.
   */
  async commitMutatingResult<T>(input: {
    successful: boolean;
    result: T;
    checkpoint?: WorkspaceCheckpointPublication;
    commit: (result: T) => Promise<void>;
  }): Promise<void> {
    if (input.successful) {
      if (!input.checkpoint) {
        throw new Error("Successful mutation requires a workspace checkpoint");
      }
      await this.publish(input.checkpoint);
    }
    await input.commit(input.result);
  }
}
