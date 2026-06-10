/**
 * Archive state for sessions of ALL sources. Slack/Linear session files are
 * owned by their agents (read-only for backstage), so archived-ness lives in
 * a backstage-owned registry keyed by unified session id.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import type { UnifiedSession } from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const REGISTRY_PATH = `${HOME}/.backstage-sessions/archive-registry.json`;

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
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

function save(registry: Record<string, string>): void {
  cache = registry;
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function isArchivedId(id: string): boolean {
  return id in load();
}

export function setArchived(id: string, archived: boolean): void {
  const registry = { ...load() };
  if (archived) registry[id] = new Date().toISOString();
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
    registry[s.id] = now;
    archived++;
  }

  if (archived > 0) save(registry);
  return archived;
}
