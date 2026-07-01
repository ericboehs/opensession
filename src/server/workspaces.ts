/**
 * Workspaces — containers that group chats. A chat carries a `workspaceId`
 * pointing here; every chat belongs to exactly one workspace. Unlike the old
 * "project" folder, a workspace can *optionally own a worktree* (repo + branch +
 * worktreeDir, plus attached repos): new chats created in the workspace inherit
 * that worktree by default (share mode), or branch a new stacked worktree off it.
 * A workspace with no `worktreeDir` is "ask-style" / not yet materialized.
 *
 * The chat still stores its own branch/worktreeDir (the source of truth for the
 * runner cwd); the workspace's worktree fields are the template a new share-mode
 * chat copies, and the flag for "does this workspace own a worktree yet".
 *
 * One JSON file per workspace at `~/.backstage-workspaces/<id>.json` (falling
 * back to the legacy `~/.backstage-projects/` until the data migration runs).
 * Mirrors the flat-file pattern in pins.ts / models.ts. Team-internal, no auth.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { randomUUID } from "crypto";
import type { AttachedRepo } from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const WORKSPACES_DIR_NEW = `${HOME}/.backstage-workspaces`;
const WORKSPACES_DIR_LEGACY = `${HOME}/.backstage-projects`;
/**
 * Dual-read: prefer the new dir, but fall back to the legacy `.backstage-projects`
 * dir until the one-time migration renames it. Resolving once at module load keeps
 * reads and writes on the same dir (no split-brain) whether or not the migration
 * has run. Keeps the `prj-` id prefix opaque — see scripts/migrate-workspaces.ts.
 */
const WORKSPACES_DIR =
  existsSync(WORKSPACES_DIR_NEW) || !existsSync(WORKSPACES_DIR_LEGACY)
    ? WORKSPACES_DIR_NEW
    : WORKSPACES_DIR_LEGACY;

export interface Workspace {
  id: string;
  name: string;
  /** Default repo for new chats created in this workspace (repo id). */
  repo?: string;
  /** Optional swatch key for the sidebar dot (see tab-colors). */
  color?: string;
  createdBy: string;
  createdAt: string;
  /** Manual sort order in the sidebar; lower = higher. Defaults to createdAt. */
  order?: number;
  /**
   * Stable dedupe key for auto-created workspaces (e.g. `ghpr-1234` for a PR).
   * Lets a caller find-or-create idempotently. Absent for user-made workspaces.
   */
  key?: string;
  /** For PR-backed workspaces: the PR number this workspace groups. */
  prNumber?: number;
  /**
   * The workspace's default branch. Present when the workspace owns a worktree
   * (share-mode chats inherit it; stacked chats branch off it) or for PR-backed
   * workspaces (the head branch the member chats share).
   */
  branch?: string;
  /**
   * The shared worktree new share-mode chats inherit. Absent = the workspace does
   * not own a worktree yet (ask-style / unmaterialized).
   */
  worktreeDir?: string;
  /** Secondary repos attached at the workspace level; new chats copy these. */
  attachedRepos?: AttachedRepo[];
}

function ensureDir(): void {
  if (!existsSync(WORKSPACES_DIR)) mkdirSync(WORKSPACES_DIR, { recursive: true });
}

function fileFor(id: string): string {
  return `${WORKSPACES_DIR}/${id}.json`;
}

/** Reject ids that could escape the directory; workspace ids are server-minted. */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export function listWorkspaces(): Workspace[] {
  if (!existsSync(WORKSPACES_DIR)) return [];
  const out: Workspace[] = [];
  for (const file of readdirSync(WORKSPACES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const p = JSON.parse(readFileSync(`${WORKSPACES_DIR}/${file}`, "utf8"));
      if (p && typeof p.id === "string" && typeof p.name === "string") out.push(p);
    } catch {}
  }
  out.sort(
    (a, b) =>
      (a.order ?? (Date.parse(a.createdAt) || 0)) -
        (b.order ?? (Date.parse(b.createdAt) || 0)) || a.name.localeCompare(b.name),
  );
  return out;
}

export function getWorkspace(id: string): Workspace | null {
  if (!safeId(id)) return null;
  const f = fileFor(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Workspace;
  } catch {
    return null;
  }
}

export function createWorkspace(input: {
  name: string;
  repo?: string;
  color?: string;
  createdBy: string;
  key?: string;
  prNumber?: number;
  branch?: string;
  worktreeDir?: string;
  attachedRepos?: AttachedRepo[];
  /** Reuse a caller-supplied id (e.g. migration wrapping an orphan chat). */
  id?: string;
  createdAt?: string;
}): Workspace {
  ensureDir();
  const workspace: Workspace = {
    id: input.id || `prj-${randomUUID()}`,
    name: (input.name || "Untitled workspace").trim().slice(0, 120) || "Untitled workspace",
    repo: input.repo,
    color: input.color,
    createdBy: input.createdBy || "Anonymous",
    createdAt: input.createdAt || new Date().toISOString(),
    ...(input.key ? { key: input.key } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.worktreeDir ? { worktreeDir: input.worktreeDir } : {}),
    ...(input.attachedRepos && input.attachedRepos.length
      ? { attachedRepos: input.attachedRepos }
      : {}),
  };
  writeJsonAtomic(fileFor(workspace.id), workspace);
  return workspace;
}

/** Find a workspace by its stable dedupe key, or null. */
export function findWorkspaceByKey(key: string): Workspace | null {
  if (!key) return null;
  return listWorkspaces().find((p) => p.key === key) || null;
}

/**
 * Idempotently resolve the workspace for a stable key, creating it on first use.
 * Used to auto-group related chats (e.g. every autofix/review/simplify chat for
 * one PR) under a single workspace.
 */
export function findOrCreateWorkspaceByKey(
  key: string,
  input: { name: string; repo?: string; color?: string; createdBy: string; prNumber?: number; branch?: string },
): Workspace {
  return findWorkspaceByKey(key) || createWorkspace({ ...input, key });
}

/** Merge a partial patch into a workspace. Returns the updated record, or null. */
export function updateWorkspace(
  id: string,
  patch: Partial<
    Pick<Workspace, "name" | "repo" | "color" | "order" | "branch" | "worktreeDir" | "attachedRepos">
  >,
): Workspace | null {
  const cur = getWorkspace(id);
  if (!cur) return null;
  const next: Workspace = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) || cur.name } : {}),
    ...(patch.repo !== undefined ? { repo: patch.repo } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.order !== undefined ? { order: patch.order } : {}),
    ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
    ...(patch.worktreeDir !== undefined ? { worktreeDir: patch.worktreeDir } : {}),
    ...(patch.attachedRepos !== undefined ? { attachedRepos: patch.attachedRepos } : {}),
  };
  writeJsonAtomic(fileFor(id), next);
  return next;
}

/**
 * Delete a workspace. Every chat belongs to exactly one workspace, so the caller
 * is responsible for re-homing member chats first (never orphan them). This only
 * removes the workspace metadata file.
 */
export function deleteWorkspace(id: string): boolean {
  if (!safeId(id)) return false;
  const f = fileFor(id);
  if (!existsSync(f)) return false;
  try {
    rmSync(f);
    return true;
  } catch {
    return false;
  }
}
