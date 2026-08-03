/**
 * One-time data migration: Projects → Workspaces, Sessions → Chats.
 *
 * What it does (idempotent, reversible):
 *   1. Renames the on-disk dirs:
 *        ~/.backstage-projects  → ~/.backstage-workspaces
 *        ~/.backstage-sessions  → ~/.backstage-chats
 *      Moving the whole dir carries all aux files (archive-registry.json,
 *      title-overrides.json, generated-titles.json, human-asks.json,
 *      prompt-queues.json, active-runs.json, active-at-shutdown.json, uploads/…)
 *      along automatically. Skipped if the target already exists.
 *   2. In each chat file, mirrors `projectId` → `workspaceId` (keeps `projectId`
 *      too so a one-release dual-read `workspaceId ?? projectId` is safe).
 *   3. Wraps every folderless chat in its own 1:1 workspace (so every chat
 *      belongs to exactly one workspace), the workspace owning the worktree the
 *      chat already used.
 *   4. Writes a rollback map (migration-rollback.json) into the workspaces dir.
 *
 * The `prj-`/`bks-` id prefixes are intentionally left opaque (they're embedded
 * in deep links, localStorage, pins, tab-colors) — only dirs/keys change.
 *
 * Usage:
 *   bun scripts/migrate-workspaces.ts --dry-run     # preview, no writes
 *   bun scripts/migrate-workspaces.ts               # apply
 *   bun scripts/migrate-workspaces.ts --home /tmp/copy   # test against a copy
 */

import { homedir } from "os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const homeIdx = args.indexOf("--home");
const HOME =
  homeIdx >= 0 ? args[homeIdx + 1] : process.env.HOME || homedir();

const PROJECTS_OLD = `${HOME}/.backstage-projects`;
const WORKSPACES_NEW = `${HOME}/.backstage-workspaces`;
const SESSIONS_OLD = `${HOME}/.backstage-sessions`;
const CHATS_NEW = `${HOME}/.backstage-chats`;
const MARKER = "migration-v1-workspaces.json";

function log(...a: unknown[]) {
  console.log(DRY ? "[dry-run]" : "[migrate]", ...a);
}

/** Rename a dir to its new name, idempotently. Returns the dir now in effect. */
function renameDir(oldDir: string, newDir: string): string {
  if (existsSync(newDir)) {
    if (existsSync(oldDir))
      log(`WARN both ${oldDir} and ${newDir} exist — using ${newDir}, leaving old in place`);
    return newDir;
  }
  if (!existsSync(oldDir)) {
    log(`neither ${oldDir} nor ${newDir} exists — creating ${newDir}`);
    if (!DRY) mkdirSync(newDir, { recursive: true });
    return newDir;
  }
  log(`rename dir ${oldDir} → ${newDir}`);
  if (!DRY) renameSync(oldDir, newDir);
  return DRY ? oldDir : newDir; // in dry-run the data is still at the old path
}

type Chat = {
  id?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  title?: string;
  branch?: string;
  worktreeDir?: string;
  repo?: string;
  attachedRepos?: unknown[];
  createdBy?: string;
  createdAt?: string;
};

function isChatFile(name: string): boolean {
  return name.startsWith("bks-") && name.endsWith(".json");
}

function main() {
  const rollback: {
    renamedDirs: Array<{ from: string; to: string }>;
    createdWorkspaces: string[];
    mirroredKey: string[];
  } = { renamedDirs: [], createdWorkspaces: [], mirroredKey: [] };

  // 1. Dir renames.
  if (!existsSync(WORKSPACES_NEW) && existsSync(PROJECTS_OLD))
    rollback.renamedDirs.push({ from: PROJECTS_OLD, to: WORKSPACES_NEW });
  if (!existsSync(CHATS_NEW) && existsSync(SESSIONS_OLD))
    rollback.renamedDirs.push({ from: SESSIONS_OLD, to: CHATS_NEW });
  const workspacesDir = renameDir(PROJECTS_OLD, WORKSPACES_NEW);
  const chatsDir = renameDir(SESSIONS_OLD, CHATS_NEW);

  // Idempotency marker.
  const markerPath = `${workspacesDir}/${MARKER}`;
  const alreadyRan = existsSync(markerPath);
  if (alreadyRan) log(`marker ${markerPath} present — key/wrap steps are idempotent, continuing`);

  // 2 + 3. Per-chat: mirror key, wrap orphans.
  let mirrored = 0;
  let wrapped = 0;
  let scanned = 0;
  const chatFiles = existsSync(chatsDir)
    ? readdirSync(chatsDir).filter(isChatFile)
    : [];
  for (const file of chatFiles) {
    const p = `${chatsDir}/${file}`;
    let chat: Chat;
    try {
      chat = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (!chat || !chat.id) continue; // aux/bookkeeping files never have an id
    scanned++;
    let dirty = false;

    // Mirror projectId → workspaceId (keep projectId for dual-read).
    if (chat.projectId && !chat.workspaceId) {
      chat.workspaceId = chat.projectId;
      dirty = true;
      mirrored++;
      rollback.mirroredKey.push(chat.id);
    }

    // Wrap a folderless chat in its own 1:1 workspace.
    if (!chat.workspaceId) {
      const wsId = `prj-${randomUUID()}`;
      const ws = {
        id: wsId,
        name: (chat.title || chat.branch || "Chat").slice(0, 120),
        ...(chat.repo ? { repo: chat.repo } : {}),
        createdBy: chat.createdBy || "Anonymous",
        createdAt: chat.createdAt || new Date().toISOString(),
        ...(chat.branch ? { branch: chat.branch } : {}),
        ...(chat.worktreeDir ? { worktreeDir: chat.worktreeDir } : {}),
        ...(chat.attachedRepos && chat.attachedRepos.length
          ? { attachedRepos: chat.attachedRepos }
          : {}),
      };
      log(`wrap orphan ${chat.id} → workspace ${wsId} ("${ws.name}")`);
      if (!DRY)
        writeFileSync(`${workspacesDir}/${wsId}.json`, JSON.stringify(ws, null, 2));
      chat.workspaceId = wsId;
      chat.projectId = wsId;
      dirty = true;
      wrapped++;
      rollback.createdWorkspaces.push(wsId);
    }

    if (dirty && !DRY) writeFileSync(p, JSON.stringify(chat, null, 2));
  }

  // 4. Rollback map + marker.
  if (!DRY) {
    if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(
      `${workspacesDir}/migration-rollback.json`,
      JSON.stringify({ ...rollback, at: new Date().toISOString() }, null, 2),
    );
    writeFileSync(
      markerPath,
      JSON.stringify({ ranAt: new Date().toISOString(), scanned, mirrored, wrapped }, null, 2),
    );
  }

  log(
    `done — scanned ${scanned} chats, mirrored ${mirrored} projectId→workspaceId, wrapped ${wrapped} orphans; workspaces dir ${workspacesDir}`,
  );
}

main();
