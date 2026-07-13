/**
 * Per-user sidebar folders. Each user (the self-selected `backstage-user` name
 * from the frontend UserPicker — team-internal, not an auth identity) gets one
 * JSON file `~/.opensession-folders/<user>.json` of shape
 * `{ folders: [{ id, name, keys }] }`. Mirrors the flat-file pattern in pins.ts:
 * the array order is the sidebar's section order, each folder's `keys` order is
 * its rows' order, and keys use the same vocabulary as pins (`workspace:<id>`
 * for real workspaces, the chat id for solo rows).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./rename-compat";

export type SidebarFolder = { id: string; name: string; keys: string[] };

const FOLDERS_DIR = stateDir("folders");

/** Map a free-form user name to a safe filename; empty/odd input → Anonymous. */
function sanitizeUser(user: string): string {
  const cleaned = (user || "").trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "Anonymous";
}

function fileFor(user: string): string {
  return `${FOLDERS_DIR}/${sanitizeUser(user)}.json`;
}

/** Parse + normalize a raw folders payload: drop malformed folders, de-dupe
    folder ids, clamp names, and keep each key in at most one folder (first
    occurrence wins — a row lives in exactly one section). */
function sanitizeFolders(raw: unknown): SidebarFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: SidebarFolder[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const id = typeof (f as any).id === "string" ? (f as any).id.slice(0, 64) : "";
    const name =
      typeof (f as any).name === "string" ? (f as any).name.trim().slice(0, 80) : "";
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const keys: string[] = [];
    for (const k of Array.isArray((f as any).keys) ? (f as any).keys : []) {
      if (typeof k !== "string" || !k || seenKeys.has(k)) continue;
      seenKeys.add(k);
      keys.push(k);
    }
    out.push({ id, name: name || "New folder", keys });
  }
  return out;
}

export function getFolders(user: string): SidebarFolder[] {
  try {
    const f = fileFor(user);
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, "utf8"));
    return sanitizeFolders(raw?.folders);
  } catch {
    return [];
  }
}

/** Replace a user's folders wholesale (the frontend sends the full list on
    every change, order included — same contract as pins). */
export function setFolders(user: string, folders: unknown): SidebarFolder[] {
  const clean = sanitizeFolders(folders);
  try {
    if (!existsSync(FOLDERS_DIR)) mkdirSync(FOLDERS_DIR, { recursive: true });
    writeJsonAtomic(fileFor(user), { folders: clean });
  } catch {}
  return clean;
}

/**
 * Drop the given keys from EVERY user's folders. Called when a session (or a
 * workspace's last live chat) is archived — same staleness rule as
 * unpinEverywhere: a folder entry pointing at archived work would silently
 * resurface the row on unarchive. Empty folders are kept (they're structure,
 * not content).
 */
export function removeFromFoldersEverywhere(keys: string[]): void {
  const drop = new Set(keys.filter(Boolean));
  if (!drop.size || !existsSync(FOLDERS_DIR)) return;
  for (const file of readdirSync(FOLDERS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const path = `${FOLDERS_DIR}/${file}`;
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const folders = sanitizeFolders(raw?.folders);
      let changed = false;
      for (const f of folders) {
        const next = f.keys.filter((k) => !drop.has(k));
        if (next.length !== f.keys.length) {
          f.keys = next;
          changed = true;
        }
      }
      if (changed) writeJsonAtomic(path, { folders });
    } catch {}
  }
}
