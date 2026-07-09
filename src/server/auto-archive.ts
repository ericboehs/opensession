/**
 * Auto-archive sessions once they look "done" — no manual archive click
 * needed. Two triggers with different scope (see Settings → Auto-archive):
 *   - PR merged: a merged PR is unambiguously finished, so this archives its
 *     session in EVERY repo, on by default (top-level `onMerge` toggle to opt
 *     out entirely).
 *   - Checks green (pre-merge): more aggressive, so it stays per-repo opt-in
 *     (default only `backstage`, whose fast self-hosting iteration would
 *     otherwise pile up in "My sessions").
 * "Done" also always requires: not running, not waiting on you, no unresolved
 * run error.
 *
 * Sibling of plain-archive.ts (external-signal-driven) and archive.ts's
 * archiveOlderThan (idle-driven) — this is the "work-finished" signal. All
 * three write through archive.ts's registry so "Archived" can tell them apart
 * by reason.
 */
import { readFileSync, existsSync, mkdirSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { setArchived, unpinArchivedSessions } from "./archive";
import type { UnifiedSession } from "./types";
import { stateDir } from "./rename-compat";

// `waitingForInput` is a live, in-process signal (pendingAsks) layered onto
// UnifiedSession only at the API-response boundary (backstage.ts), never
// stored on the cached session object — callers of the sweep must enrich
// with it the same way before passing sessions in.
type SweepSession = UnifiedSession & { waitingForInput?: boolean };

const CONFIG_DIR = stateDir("auto-archive");
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const DEFAULT_PROJECT = "tella-fusion";

mkdirSync(CONFIG_DIR, { recursive: true });

export interface AutoArchiveUserConfig {
  /** Archive a session once its PR merges, in any repo. On by default. */
  onMerge: boolean;
  /**
   * Repo ids the pre-merge "checks green" trigger applies to. Empty = only
   * merge-archiving (if `onMerge`) is active. Does not gate merge-archiving.
   */
  repos: string[];
  /** Also archive once an open PR's checks are all green, before merge. */
  onChecksGreen: boolean;
}

export const AUTO_ARCHIVE_DEFAULTS: AutoArchiveUserConfig = {
  onMerge: true,
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
    ...(typeof patch.onMerge === "boolean" ? { onMerge: patch.onMerge } : {}),
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

/**
 * Why a session counts as done, or null if it doesn't. "merged" applies in
 * every repo; "checks" is gated to opted-in repos by the caller.
 */
function doneReason(
  s: SweepSession,
  cfg: AutoArchiveUserConfig,
): "merged" | "checks" | null {
  if (s.isRunning || s.waitingForInput || s.lastRunError) return null;
  if (cfg.onMerge && s.prState === "MERGED") return "merged";
  if (
    cfg.onChecksGreen &&
    s.prState === "OPEN" &&
    !s.prIsDraft &&
    s.prChecks &&
    s.prChecks.total > 0 &&
    s.prChecks.failed === 0 &&
    s.prChecks.pending === 0
  )
    return "checks";
  return null;
}

/**
 * Sweep every session, archiving each user's done sessions in the repos
 * they've opted in. Only touches non-automation sessions with a known owner.
 * Returns the number archived.
 */
export function autoArchiveDoneSessions(sessions: SweepSession[]): number {
  const cfg = readConfig();
  const justArchived: SweepSession[] = [];

  for (const s of sessions) {
    if (s.archived || s.automation || !s.startedBy) continue;
    const userCfg: AutoArchiveUserConfig = {
      ...AUTO_ARCHIVE_DEFAULTS,
      ...cfg.users[s.startedBy.trim()],
    };
    const reason = doneReason(s, userCfg);
    if (!reason) continue;
    // Merge-archiving applies everywhere; the pre-merge checks-green trigger
    // only fires in the repos the user opted in.
    if (reason === "checks" && !userCfg.repos.includes(sessionRepo(s)))
      continue;
    setArchived(s.id, true, "auto");
    justArchived.push(s);
  }

  // setArchived drops each plain-id pin; now that the registry is written, also
  // drop alias-id pins and any workspace pin whose last live chat just archived.
  unpinArchivedSessions(justArchived, sessions);

  return justArchived.length;
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
