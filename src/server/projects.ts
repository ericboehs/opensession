/**
 * Projects — optional folders that group chats (sessions). A chat carries a
 * `projectId` pointing here; a chat with no `projectId` is standalone. The
 * worktree lives on the *chat*, not the project: a project is purely an
 * organizational container (like a ChatGPT/Codex Project), so its store holds
 * only folder metadata. Membership is derived from `session.projectId` — that
 * is the single source of truth, so deleting a project never orphans a chat
 * (the chat just becomes standalone again).
 *
 * One JSON file per project at `~/.backstage-projects/<id>.json`. Mirrors the
 * flat-file pattern in pins.ts / models.ts. Team-internal, no auth.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";

const HOME = process.env.HOME || "/home/ubuntu";
const PROJECTS_DIR = `${HOME}/.backstage-projects`;

export interface Project {
  id: string;
  name: string;
  /** Default repo for new chats created in this project (repo id). */
  repo?: string;
  /** Optional swatch key for the sidebar dot (see tab-colors). */
  color?: string;
  createdBy: string;
  createdAt: string;
  /** Manual sort order in the sidebar; lower = higher. Defaults to createdAt. */
  order?: number;
  /**
   * Stable dedupe key for auto-created projects (e.g. `ghpr-1234` for a PR).
   * Lets a caller find-or-create idempotently. Absent for user-made projects.
   */
  key?: string;
  /** For PR-backed projects: the PR number this folder groups. */
  prNumber?: number;
  /** For PR-backed projects: the head branch the member chats share. */
  branch?: string;
}

function ensureDir(): void {
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
}

function fileFor(id: string): string {
  return `${PROJECTS_DIR}/${id}.json`;
}

/** Reject ids that could escape the directory; project ids are server-minted. */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export function listProjects(): Project[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out: Project[] = [];
  for (const file of readdirSync(PROJECTS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const p = JSON.parse(readFileSync(`${PROJECTS_DIR}/${file}`, "utf8"));
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

export function getProject(id: string): Project | null {
  if (!safeId(id)) return null;
  const f = fileFor(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Project;
  } catch {
    return null;
  }
}

export function createProject(input: {
  name: string;
  repo?: string;
  color?: string;
  createdBy: string;
  key?: string;
  prNumber?: number;
  branch?: string;
}): Project {
  ensureDir();
  const project: Project = {
    id: `prj-${randomUUID()}`,
    name: (input.name || "Untitled project").trim().slice(0, 120) || "Untitled project",
    repo: input.repo,
    color: input.color,
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
    ...(input.key ? { key: input.key } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
  writeFileSync(fileFor(project.id), JSON.stringify(project, null, 2));
  return project;
}

/** Find a project by its stable dedupe key, or null. */
export function findProjectByKey(key: string): Project | null {
  if (!key) return null;
  return listProjects().find((p) => p.key === key) || null;
}

/**
 * Idempotently resolve the project for a stable key, creating it on first use.
 * Used to auto-group related chats (e.g. every autofix/review/simplify chat for
 * one PR) under a single folder.
 */
export function findOrCreateProjectByKey(
  key: string,
  input: { name: string; repo?: string; color?: string; createdBy: string; prNumber?: number; branch?: string },
): Project {
  return findProjectByKey(key) || createProject({ ...input, key });
}

/** Merge a partial patch into a project. Returns the updated record, or null. */
export function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "repo" | "color" | "order">>,
): Project | null {
  const cur = getProject(id);
  if (!cur) return null;
  const next: Project = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) || cur.name } : {}),
    ...(patch.repo !== undefined ? { repo: patch.repo } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.order !== undefined ? { order: patch.order } : {}),
  };
  writeFileSync(fileFor(id), JSON.stringify(next, null, 2));
  return next;
}

/**
 * Delete a project folder. Chats keep living — the caller is responsible for
 * clearing `projectId` on member chats (they become standalone). This only
 * removes the folder metadata.
 */
export function deleteProject(id: string): boolean {
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
