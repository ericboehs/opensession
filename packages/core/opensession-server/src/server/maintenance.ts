/**
 * Simple-mode maintenance: keep a long-running single-user install from
 * silently filling its disk.
 *
 * The service logs are the one piece of state that grows with no bound of its
 * own. launchd and the systemd unit redirect the server's stdout/stderr into
 * `server.log` / `server.err.log` and rotate nothing, so a laptop or small VPS
 * left running for weeks grows those files until the disk is full, and the
 * failures that follow (writes erroring, sessions wedging) read as a baffling
 * outage rather than "your log ate the disk". Everything else that grows is
 * already bounded: the worktree reaper and disk-gc reclaim worktrees and their
 * caches, and audit files prune past a retention window. This fills the log
 * gap and warns before free space runs out.
 *
 * Conservative by construction: it only truncates its own service logs, never
 * user data, and keeps one rotation for a post-mortem. Nothing runs at module
 * scope; the sweep is armed from the boot block via startMaintenance().
 */

import { copyFileSync, existsSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit";
import { diskUsagePct } from "./disk-gc";
import { homeDir } from "./paths";

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Cap each service log here; above it, rotate to `.1` and truncate in place. */
const LOG_CAP_BYTES = num(process.env.OPENSESSION_LOG_CAP_MB, 25) * MB;
const SWEEP_INTERVAL_MS = num(process.env.OPENSESSION_MAINTENANCE_INTERVAL_MS, 6 * HOUR);
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;
/** Warn the operator once free space is this tight — before writes start failing. */
const DISK_WARN_PCT = num(process.env.OPENSESSION_DISK_WARN_PCT, 90);

/** The install's home, honoring the OPENSESSION_HOME override the installer
 *  uses (scripts/lib/paths.ts), so maintenance inspects the same tree launchd
 *  and systemd actually write to rather than a stale `~/.opensession`. */
function opensessionHome(): string {
  return process.env.OPENSESSION_HOME || join(homeDir(), ".opensession");
}

/** The install's log directory (service.ts points the unit's log output here). */
export function serviceLogDir(): string {
  return join(opensessionHome(), "logs");
}

/** An existing path ON the log filesystem, for the free-space check. The log
 *  dir may not be created yet, so fall back to the install home, then $HOME.
 *  Probing `/` would miss a nearly full `/home` on a split-filesystem box. */
export function diskProbePath(): string {
  const dir = serviceLogDir();
  if (existsSync(dir)) return dir;
  const home = opensessionHome();
  if (existsSync(home)) return home;
  return homeDir();
}

const SERVICE_LOGS = ["server.log", "server.err.log"];

/**
 * Rotate an oversized service log in place. launchd and systemd open the log
 * for append, so the running server's next write lands at the new end of file
 * rather than at a stale offset: copy-then-truncate is safe and leaves no
 * sparse hole. One generation is kept as `<name>.1` for a post-mortem; the
 * previous `.1` is overwritten. Returns the freed size, or 0 if nothing to do.
 */
export function rotateLog(path: string, capBytes = LOG_CAP_BYTES): number {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return 0; // no such log yet
  }
  if (size <= capBytes) return 0;
  try {
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return size;
  } catch (e) {
    console.error(`[maintenance] could not rotate ${path}:`, e);
    return 0;
  }
}

export interface MaintenanceResult {
  rotated: { path: string; wasBytes: number }[];
  diskPct: number;
}

/** One maintenance pass. Safe to call repeatedly; never touches user data. */
export function runMaintenance(): MaintenanceResult {
  const dir = serviceLogDir();
  const rotated: { path: string; wasBytes: number }[] = [];
  if (existsSync(dir)) {
    for (const name of SERVICE_LOGS) {
      const wasBytes = rotateLog(join(dir, name));
      if (wasBytes) rotated.push({ path: join(dir, name), wasBytes });
    }
  }
  for (const r of rotated) {
    console.log(
      `[maintenance] rotated ${r.path} (${(r.wasBytes / MB).toFixed(0)}MB -> 0, kept .1)`,
    );
  }
  if (rotated.length) audit({ event: "maintenance_log_rotate", rotated: rotated.length });

  const diskPct = diskUsagePct(diskProbePath());
  if (diskPct >= DISK_WARN_PCT) {
    console.warn(
      `[maintenance] free disk is low — filesystem at ${diskPct.toFixed(0)}%. ` +
        `Old sessions/worktrees are the usual culprit; \`opensession doctor\` reports state size.`,
    );
  }
  return { rotated, diskPct };
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Arm the periodic maintenance sweep. Idempotent, so a `bun --hot` reload never
 * stacks a second one. Call once from the __opensessionBooted block.
 */
export function startMaintenance(): void {
  if (timer) return;
  if (process.env.OPENSESSION_MAINTENANCE === "0") {
    console.log("[maintenance] disabled (OPENSESSION_MAINTENANCE=0)");
    return;
  }
  const run = () => {
    try {
      runMaintenance();
    } catch (e) {
      console.error("[maintenance] sweep failed:", e);
    }
  };
  setTimeout(run, FIRST_SWEEP_DELAY_MS);
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  console.log(
    `[maintenance] started (every ${Math.round(SWEEP_INTERVAL_MS / HOUR)}h; ` +
      `service-log cap ${(LOG_CAP_BYTES / MB).toFixed(0)}MB, disk warn at ${DISK_WARN_PCT}%)`,
  );
}
