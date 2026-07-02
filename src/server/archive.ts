/**
 * Archive state for sessions of ALL sources. Slack/Linear session files are
 * owned by their agents (read-only for backstage), so archived-ness lives in
 * a backstage-owned registry keyed by unified session id.
 */
import { readFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import type { UnifiedSession } from "./types";

const REGISTRY_PATH = `${BACKSTAGE_CHATS_DIR}/archive-registry.json`;

/** Why a session ended up archived — drives the "Auto-archived" filter. */
export type ArchiveReason = "manual" | "idle" | "auto";

interface Entry {
  at: string;
  reason: ArchiveReason;
}

// Registry entries were originally a bare ISO timestamp (implicitly manual).
// Old entries are upgraded to the object shape lazily on next write; reads
// treat a bare string as `{ reason: "manual" }` so existing data keeps working.
type RawEntry = string | Entry;

let cache: Record<string, RawEntry> | null = null;

function load(): Record<string, RawEntry> {
  if (cache) return cache;
  try {
    cache = existsSync(REGISTRY_PATH)
      ? JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"))
      : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function save(registry: Record<string, RawEntry>): void {
  cache = registry;
  writeJsonAtomic(REGISTRY_PATH, registry);
}

function toEntry(raw: RawEntry): Entry {
  return typeof raw === "string" ? { at: raw, reason: "manual" } : raw;
}

export function isArchivedId(id: string): boolean {
  return id in load();
}

export function getArchiveReason(id: string): ArchiveReason | null {
  const raw = load()[id];
  return raw ? toEntry(raw).reason : null;
}

export function setArchived(
  id: string,
  archived: boolean,
  reason: ArchiveReason = "manual",
): void {
  const registry = { ...load() };
  if (archived) registry[id] = { at: new Date().toISOString(), reason };
  else delete registry[id];
  save(registry);
}

/** Archive everything idle for more than `days` days. Returns count. */
export function archiveOlderThan(sessions: UnifiedSession[], days: number): number {
  const cutoff = Date.now() - days * 86_400_000;
  const registry = { ...load() };
  let archived = 0;
  const now = new Date().toISOString();

  for (const s of sessions) {
    if (s.archived || s.isRunning) continue;
    if (registry[s.id]) continue;
    if (new Date(s.lastActivity).getTime() >= cutoff) continue;
    registry[s.id] = { at: now, reason: "idle" };
    archived++;
  }

  if (archived > 0) save(registry);
  return archived;
}
