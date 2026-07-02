/**
 * Auto-archive sessions once they look "done" — no manual archive click
 * needed. Per user, opt-in by repo (default OFF everywhere except
 * `backstage`, so fast self-hosting iteration doesn't pile up in "My
 * sessions" — see Settings → Auto-archive). "Done" means: not running, not
 * waiting on you, no unresolved run error, and either the PR merged or
 * (opt-in, on by default) its checks are all green.
 *
 * Sibling of plain-archive.ts (external-signal-driven) and archive.ts's
 * archiveOlderThan (idle-driven) — this is the "work-finished" signal. All
 * three write through archive.ts's registry so "Archived" can tell them apart
 * by reason.
 */
import { readFileSync, existsSync, mkdirSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { setArchived } from "./archive";
import type { UnifiedSession } from "./types";

// `waitingForInput` is a live, in-process signal (pendingAsks) layered onto
// UnifiedSession only at the API-response boundary (backstage.ts), never
// stored on the cached session object — callers of the sweep must enrich
// with it the same way before passing sessions in.
type SweepSession = UnifiedSession & { waitingForInput?: boolean };

const HOME = process.env.HOME || "/home/ubuntu";
const CONFIG_DIR = `${HOME}/.backstage-auto-archive`;
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const DEFAULT_PROJECT = "tella-fusion";

mkdirSync(CONFIG_DIR, { recursive: true });

export interface AutoArchiveUserConfig {
  /** Repo ids this applies to. Empty = off everywhere. */
  repos: string[];
  /** Also archive once an open PR's checks are all green, before merge. */
  onChecksGreen: boolean;
}

export const AUTO_ARCHIVE_DEFAULTS: AutoArchiveUserConfig = {
  repos: ["backstage"],
  onChecksGreen: true,
};

interface ConfigFile {
  users: Record<string, Partial<AutoArchiveUserConfig>>;
}

function readConfig(): ConfigFile {
  try {
    if (existsSync(CONFIG_PATH))
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {}
  return { users: {} };
}

export function getAutoArchiveConfig(user: string): AutoArchiveUserConfig {
  const raw = readConfig().users[user.trim()] || {};
  return { ...AUTO_ARCHIVE_DEFAULTS, ...raw };
}

export function setAutoArchiveConfig(
  user: string,
  patch: Partial<AutoArchiveUserConfig>,
): AutoArchiveUserConfig {
  const cfg = readConfig();
  const key = user.trim();
  const next: AutoArchiveUserConfig = {
    ...AUTO_ARCHIVE_DEFAULTS,
    ...cfg.users[key],
    ...(Array.isArray(patch.repos)
      ? { repos: patch.repos.filter((r) => typeof r === "string") }
      : {}),
    ...(typeof patch.onChecksGreen === "boolean"
      ? { onChecksGreen: patch.onChecksGreen }
      : {}),
  };
  cfg.users[key] = next;
  writeJsonAtomic(CONFIG_PATH, cfg);
  return next;
}

function sessionRepo(s: UnifiedSession): string {
  return s.repo || DEFAULT_PROJECT;
}

function isDone(s: SweepSession, cfg: AutoArchiveUserConfig): boolean {
  if (s.isRunning || s.waitingForInput || s.lastRunError) return false;
  if (s.prState === "MERGED") return true;
  if (
    cfg.onChecksGreen &&
    s.prState === "OPEN" &&
    !s.prIsDraft &&
    s.prChecks &&
    s.prChecks.total > 0 &&
    s.prChecks.failed === 0 &&
    s.prChecks.pending === 0
  )
    return true;
  return false;
}

/**
 * Sweep every session, archiving each user's done sessions in the repos
 * they've opted in. Only touches non-automation sessions with a known owner.
 * Returns the number archived.
 */
export function autoArchiveDoneSessions(sessions: SweepSession[]): number {
  const cfg = readConfig();
  let archived = 0;

  for (const s of sessions) {
    if (s.archived || s.automation || !s.startedBy) continue;
    const userCfg: AutoArchiveUserConfig = {
      ...AUTO_ARCHIVE_DEFAULTS,
      ...cfg.users[s.startedBy.trim()],
    };
    if (!userCfg.repos.includes(sessionRepo(s))) continue;
    if (!isDone(s, userCfg)) continue;
    setArchived(s.id, true, "auto");
    archived++;
  }

  return archived;
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

/** Start the periodic sweep (10-min tick). Called once from backstage.ts boot. */
export function startAutoArchiveSweep(
  getSessions: () => SweepSession[],
  onChange?: () => void,
): void {
  if (sweepInterval) return;

  const sweep = () => {
    const count = autoArchiveDoneSessions(getSessions());
    if (count > 0) {
      console.log(`[auto-archive] Archived ${count} done session(s)`);
      onChange?.();
    }
  };

  sweepInterval = setInterval(sweep, 10 * 60 * 1000);
  setTimeout(sweep, 60 * 1000); // first pass shortly after boot
  console.log("[auto-archive] Sweep started (10m interval, opt-in per user/repo)");
}
