import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  assertPortableWorkspacePath,
  createWorkspaceDeltaManifest,
  digestBytes,
  type BlobStore,
  type ContentDigest,
  type WorkspaceDeltaEntry,
  type WorkspaceDeltaManifest,
  validateWorkspaceDeltaManifest,
} from "../server/executors/workspace-delta";

export type WorkspaceChangeKind = "tracked" | "untracked" | "deleted";

export interface WorkspaceChange {
  path: string;
  kind: WorkspaceChangeKind;
}

export interface ScanWorkspaceDeltaOptions {
  root: string;
  changes: Iterable<WorkspaceChange>;
  include: (path: string, kind: WorkspaceChangeKind) => boolean;
  sessionId: string;
  workspaceId: string;
  baseCommit: string;
  generation: number;
  parentCheckpoint: ContentDigest | null;
  createdAt: string;
}

export interface ScannedWorkspaceDelta {
  manifest: WorkspaceDeltaManifest;
  blobs: Map<ContentDigest, Uint8Array>;
}

async function verifyRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Workspace root must be a real directory");
  }
  return absolute;
}

async function assertNoSymlinkAncestors(
  root: string,
  relativePath: string,
  includeLeaf: boolean,
): Promise<void> {
  assertPortableWorkspacePath(relativePath);
  const segments = relativePath.split("/");
  const count = includeLeaf ? segments.length : segments.length - 1;
  let current = root;
  for (let index = 0; index < count; index++) {
    current = path.join(current, segments[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Workspace path crosses symlink: ${relativePath}`);
      }
      if (!info.isDirectory() && index < count - 1) {
        throw new Error(
          `Workspace path crosses non-directory: ${relativePath}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function portableJoin(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export async function scanWorkspaceDelta(
  options: ScanWorkspaceDeltaOptions,
): Promise<ScannedWorkspaceDelta> {
  const root = await verifyRoot(options.root);
  const entries = new Map<string, WorkspaceDeltaEntry>();
  const blobs = new Map<ContentDigest, Uint8Array>();

  const capture = async (
    relativePath: string,
    kind: Exclude<WorkspaceChangeKind, "deleted">,
  ): Promise<void> => {
    assertPortableWorkspacePath(relativePath);
    if (!options.include(relativePath, kind)) return;
    await assertNoSymlinkAncestors(root, relativePath, false);
    const absolute = path.join(root, ...relativePath.split("/"));
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      const children = await readdir(absolute);
      children.sort((left, right) => left.localeCompare(right, "en"));
      for (const child of children) {
        await capture(portableJoin(relativePath, child), kind);
      }
      return;
    }
    if (info.isSymbolicLink()) {
      const content = new TextEncoder().encode(await readlink(absolute));
      const digest = digestBytes(content);
      blobs.set(digest, content);
      entries.set(relativePath, {
        kind: "symlink",
        path: relativePath,
        mode: info.mode & 0o777,
        digest,
        size: content.byteLength,
      });
      return;
    }
    if (!info.isFile()) {
      throw new Error(`Unsupported workspace entry: ${relativePath}`);
    }
    const content = new Uint8Array(await readFile(absolute));
    const digest = digestBytes(content);
    blobs.set(digest, content);
    entries.set(relativePath, {
      kind: "file",
      path: relativePath,
      mode: info.mode & 0o777,
      digest,
      size: content.byteLength,
    });
  };

  for (const change of options.changes) {
    assertPortableWorkspacePath(change.path);
    if (!options.include(change.path, change.kind)) continue;
    if (change.kind === "deleted") {
      entries.set(change.path, { kind: "delete", path: change.path });
    } else {
      await capture(change.path, change.kind);
    }
  }

  return {
    manifest: createWorkspaceDeltaManifest({
      sessionId: options.sessionId,
      workspaceId: options.workspaceId,
      baseCommit: options.baseCommit,
      generation: options.generation,
      parentCheckpoint: options.parentCheckpoint,
      entries: [...entries.values()],
      createdAt: options.createdAt,
    }),
    blobs,
  };
}

async function ensureSafeParent(
  root: string,
  relativePath: string,
): Promise<string> {
  assertPortableWorkspacePath(relativePath);
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe destination parent: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`Unsafe destination parent: ${relativePath}`);
      }
    }
  }
  return path.join(root, ...segments);
}

async function replaceAtomically(
  root: string,
  entry: Exclude<WorkspaceDeltaEntry, { kind: "delete" }>,
  content: Uint8Array,
): Promise<void> {
  const destination = await ensureSafeParent(root, entry.path);
  const temporary = path.join(
    path.dirname(destination),
    `.workspace-delta-${randomUUID()}.tmp`,
  );
  if (entry.kind === "file") {
    await writeFile(temporary, content, { flag: "wx", mode: entry.mode });
    await chmod(temporary, entry.mode);
  } else {
    const target = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (!target || target.includes("\0"))
      throw new Error("Invalid symlink target");
    await symlink(target, temporary);
  }
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (
      !["EISDIR", "ENOTDIR", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      await rm(temporary, { force: true, recursive: true });
      throw error;
    }
    await rm(destination, { recursive: true });
    await rename(temporary, destination);
  }
}

/**
 * Applies a validated delta. Every referenced blob and destination ancestor is
 * checked before mutation. Concurrent filesystem writers can still create a
 * TOCTOU race; later daemon/file-watcher integration must provide quiescence.
 */
export async function applyWorkspaceDelta(options: {
  root: string;
  manifest: WorkspaceDeltaManifest;
  blobs: BlobStore;
}): Promise<void> {
  const root = await verifyRoot(options.root);
  validateWorkspaceDeltaManifest(options.manifest);
  const contentByDigest = new Map<ContentDigest, Uint8Array>();

  for (const entry of options.manifest.entries) {
    await assertNoSymlinkAncestors(root, entry.path, false);
    if (entry.kind === "delete") continue;
    let content = contentByDigest.get(entry.digest);
    if (!content) {
      const loaded = await options.blobs.get(entry.digest);
      if (!loaded) throw new Error(`Missing workspace blob: ${entry.digest}`);
      content = loaded;
      contentByDigest.set(entry.digest, content);
    }
    if (
      content.byteLength !== entry.size ||
      digestBytes(content) !== entry.digest
    ) {
      throw new Error(`Corrupt workspace blob: ${entry.digest}`);
    }
    if (entry.kind === "symlink") {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    }
  }

  for (const entry of options.manifest.entries) {
    if (entry.kind === "delete") continue;
    await replaceAtomically(root, entry, contentByDigest.get(entry.digest)!);
  }
  const deletions = options.manifest.entries
    .filter(
      (entry): entry is Extract<WorkspaceDeltaEntry, { kind: "delete" }> =>
        entry.kind === "delete",
    )
    .sort((left, right) => right.path.length - left.path.length);
  for (const entry of deletions) {
    const destination = await ensureSafeParent(root, entry.path);
    await rm(destination, { recursive: true, force: true });
  }
}
