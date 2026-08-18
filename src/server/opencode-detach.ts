/**
 * Detached `opencode serve` processes — the piece that makes a opensession
 * restart non-destructive for in-flight runs.
 *
 * Why: engine turns execute server-side inside `opencode serve`; the opensession
 * process is just an SSE client. Servers spawned as direct Bun children die
 * with the unit on `systemctl restart` (KillMode=mixed SIGTERMs only the bun
 * parent, but systemd SIGKILLs the remaining cgroup members once it exits),
 * killing every in-flight turn. Spawning them via `systemd-run --user --scope`
 * moves each server into its own transient user scope OUTSIDE
 * opensession.service's cgroup, so a service restart leaves them running; the
 * next boot re-adopts them from the registry file and reattaches journaled
 * runs (see adoptDetachedOpencodeServers / tryReattachOpencodeRun in
 * opencode-runner.ts).
 *
 * Registry: ~/.opensession-opencode-servers.json records {unit, pid, url,
 * password, key, configHash, rpcToken, …} per detached server. It is the ONLY
 * bridge across a restart (ports are ephemeral, passwords random per spawn),
 * so spawn/kill paths must keep it in sync: upsert on successful spawn,
 * remove on kill. Contains the Basic-auth passwords for loopback-bound
 * servers — same trust domain as opencode's own auth store under $HOME.
 *
 * Detached stdio goes to a log file, never a pipe: a pipe's read end dies
 * with the opensession process and the next engine write would SIGPIPE-kill the
 * surviving server. That also means the port can't be parsed from stdout —
 * we pick a free port ourselves and health-poll the URL instead.
 *
 * Gating: detach only activates when the owning process opted in
 * (enableOpencodeServerDetach — opensession.ts's boot block; the runner-host
 * and sandbox contexts never do), the systemd user manager is reachable, and
 * the OPENSESSION_OC_DETACH=0 kill switch is off. Every failure inside the
 * detached spawn path falls back to a plain direct-child spawn.
 */
import { homeDir } from "./paths";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "fs";
import type { Subprocess } from "bun";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  engineScopeSystemdArgs,
  stopUserScope,
  systemdUserEnv,
  systemdUserScopesAvailable,
} from "./systemd-scopes";
import { secureAgentCommand } from "./agent-runtime-security";

const HOME = homeDir();

/** One process handle shape for both pools: a live Bun child (direct spawn,
 *  or the systemd-run waiter of a just-detached spawn) and an ADOPTED scope
 *  from a previous process (no child handle exists — liveness is a pid poll). */
export interface ServerProcHandle {
  /** systemd user scope unit name — detached servers only. */
  unit?: string;
  pid?: number;
  detached: boolean;
  readonly exitCode: number | null;
  readonly killed: boolean;
  exited: Promise<number>;
  /** SIGTERM the server (detached: `systemctl --user stop`, whose scope-level
   *  TimeoutStopSec=5 escalates to SIGKILL — covers the SIGTERM-swallowing
   *  meridian plugin). `force` maps to the direct child's SIGKILL escalation;
   *  detached scopes already escalate via the stop job. */
  kill(force?: boolean): void;
}

/** Wrap a directly-spawned Bun child (the classic pool path). */
export function bunProcHandle(proc: Subprocess<"ignore", "pipe" | number, "pipe" | number>): ServerProcHandle {
  return {
    detached: false,
    get pid() {
      return proc.pid;
    },
    get exitCode() {
      return proc.exitCode;
    },
    get killed() {
      return proc.killed;
    },
    exited: proc.exited,
    kill(force?: boolean) {
      try {
        proc.kill(force ? 9 : undefined);
      } catch {}
    },
  };
}

// ── Gating ───────────────────────────────────────────────────────────────────

const g = globalThis as any;

/** Opt this process into detached engine spawns. Called ONLY from
 *  opensession.ts's boot block — the runner-host and in-sandbox contexts keep
 *  direct children (no user manager there, and their lifecycle is their own). */
export function enableOpencodeServerDetach(): void {
  g.__opencodeDetachEnabled = true;
}

export function opencodeDetachActive(): boolean {
  if (process.env.OPENSESSION_OC_DETACH === "0") return false;
  if (g.__opencodeDetachEnabled !== true) return false;
  return systemdUserScopesAvailable();
}

/** Ask the user manager to stop a scope. --no-block: never wedge a kill path
 *  on the manager; the scope's own TimeoutStopSec (set at spawn) handles the
 *  SIGTERM→SIGKILL escalation. Safe on already-gone units. */
export function stopDetachedUnit(unit: string): void {
  stopUserScope(unit);
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface DetachedServerRecord {
  key: string;
  unit: string;
  pid: number;
  url: string;
  password: string;
  cwd: string;
  configHash: string;
  shared?: boolean;
  rpcToken: string;
  meridianKey?: string;
  /** Loopback port the server's in-process Meridian proxy bound (we allocate
   *  it via CLAUDE_PROXY_PORT so the usage/telemetry endpoints are reachable). */
  meridianPort?: number;
  /** Claude account the server's Meridian proxy authenticates as. */
  accountId?: string;
  /** Per-server SQLite shard (OPENCODE_DB at spawn) — absent on legacy servers. */
  dbPath?: string;
  spawnedAt: string;
}

const REGISTRY_PATH =
  process.env.OPENSESSION_OC_SERVER_REGISTRY ||
  `${HOME}/.opensession-opencode-servers.json`;

export function readDetachedRegistry(): DetachedServerRecord[] {
  try {
    if (!existsSync(REGISTRY_PATH)) return [];
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeDetachedRegistry(records: DetachedServerRecord[]): void {
  try {
    writeJsonAtomic(REGISTRY_PATH, records);
    chmodSync(REGISTRY_PATH, 0o600); // holds the servers' Basic-auth passwords
  } catch (e) {
    console.warn("[opencode-detach] registry write failed:", e);
  }
}

/** Record a live detached server. Keyed by unit (unique per spawn) — a pool
 *  key may briefly have two records while a config-change drain overlaps a
 *  respawn; adoption keeps the newest per key and stops the rest. */
export function upsertDetachedRecord(record: DetachedServerRecord): void {
  const rest = readDetachedRegistry().filter((r) => r.unit !== record.unit);
  writeDetachedRegistry([...rest, record]);
}

export function removeDetachedRecord(unit: string): void {
  const all = readDetachedRegistry();
  const rest = all.filter((r) => r.unit !== unit);
  if (rest.length !== all.length) writeDetachedRegistry(rest);
}

// ── Detached spawn ───────────────────────────────────────────────────────────

/** Poll cadence for adopted servers' liveness (no child handle to wait on). */
const ADOPTED_EXIT_POLL_MS = 3_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Handle for a scope adopted from a previous process: liveness is a pid
 *  poll (exit codes are unobservable across the reparent — dead is dead). */
export function adoptedProcHandle(unit: string, pid: number): ServerProcHandle {
  let exitCode: number | null = null;
  let killed = false;
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => (resolveExited = r));
  const markDead = () => {
    if (exitCode === null) {
      exitCode = -1;
      clearInterval(timer);
      resolveExited(-1);
    }
  };
  const timer = setInterval(() => {
    if (!processAlive(pid)) markDead();
  }, ADOPTED_EXIT_POLL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    unit,
    pid,
    detached: true,
    get exitCode() {
      return exitCode;
    },
    get killed() {
      return killed;
    },
    exited,
    kill() {
      killed = true;
      stopDetachedUnit(unit);
      // The stop job SIGKILLs within its TimeoutStopSec; reflect it soon after
      // so pool alive-checks converge even if the pid poll lags.
      setTimeout(markDead, 8_000);
    },
  };
}

/** Handle for a detached server this process just spawned: the systemd-run
 *  waiter is our child and exits exactly when the engine does, so exit
 *  observation stays precise; kills still go through the user manager (a
 *  signal to systemd-run wouldn't reach the scope). */
function detachedChildHandle(
  unit: string,
  pid: number,
  waiter: Subprocess<"ignore", number, number>
): ServerProcHandle {
  let killed = false;
  return {
    unit,
    pid,
    detached: true,
    get exitCode() {
      return waiter.exitCode;
    },
    get killed() {
      return killed;
    },
    exited: waiter.exited,
    kill() {
      killed = true;
      stopDetachedUnit(unit);
    },
  };
}

export function pickFreePort(): number {
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("", { status: 404 }),
  });
  const port = srv.port;
  srv.stop(true);
  if (!port) throw new Error("could not allocate a free port");
  return port;
}

/** Any authed HTTP response = the server is up and the password is ours
 *  (401/403 would mean we're talking to a stranger on a recycled port). */
export async function opencodeServerHealthy(
  url: string,
  password: string,
  timeoutMs = 3_000
): Promise<boolean> {
  try {
    const res = await fetch(`${url}/permission`, {
      headers: { Authorization: `Basic ${btoa(`opencode:${password}`)}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status !== 401 && res.status !== 403 && res.status < 500;
  } catch {
    return false;
  }
}

/** The engine pid inside the scope, read from the scope's cgroup (systemd-run
 *  itself stays in OUR cgroup — only its exec'd child moves). */
function scopeMainPid(unit: string): number | null {
  try {
    const shown = Bun.spawnSync({
      cmd: ["systemctl", "--user", "show", `${unit}.scope`, "-p", "ControlGroup", "--value"],
      env: systemdUserEnv(),
    });
    const cg = shown.stdout.toString().trim();
    if (!cg.startsWith("/")) return null;
    const procs = readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf-8")
      .split("\n")
      .map((l) => parseInt(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return procs[0] ?? null;
  } catch {
    return null;
  }
}

export interface DetachedSpawn {
  handle: ServerProcHandle;
  url: string;
  unit: string;
  pid: number;
}

/**
 * Stop `opensession-oc-*` scopes that no registry record points at. An alive
 * but unregistered scope can never be adopted or reached again — it leaks
 * (dominant mode: the spawning process died between systemd-run and the
 * registry write; 2026-07-27 the restart storm left 26 of them holding ~6GB
 * RSS + swap and pinning worktrees against cleanup). Scopes younger than
 * `graceMs` are spared — they may belong to an in-flight spawn of this
 * process that hasn't written its record yet.
 */
export function reapUnregisteredScopes(knownUnits: Set<string>, graceMs = 5 * 60_000): number {
  let listed: string;
  try {
    listed = Bun.spawnSync({
      cmd: [
        "systemctl", "--user", "list-units", "--plain", "--no-legend",
        "--type=scope", "opensession-oc-*.scope",
      ],
      env: systemdUserEnv(),
    }).stdout.toString();
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const line of listed.split("\n")) {
    const unit = line.trim().split(/\s+/)[0]?.replace(/\.scope$/, "");
    if (!unit || knownUnits.has(unit)) continue;
    const pid = scopeMainPid(unit);
    if (pid) {
      const etimes = Bun.spawnSync({ cmd: ["ps", "-o", "etimes=", "-p", String(pid)] })
        .stdout.toString().trim();
      if ((parseInt(etimes) || 0) * 1000 < graceMs) continue;
    }
    stopDetachedUnit(unit);
    reaped++;
    console.log(`[opencode-detach] reaped unregistered scope ${unit} (pid ${pid ?? "?"})`);
  }
  return reaped;
}

/**
 * Spawn `opencode serve` in its own transient user scope. Throws on any
 * failure (systemd-run error, startup timeout, unreadable scope pid) — the
 * caller falls back to a direct-child spawn.
 */
export async function spawnDetachedOpencodeServer(opts: {
  bin: string;
  cwd: string;
  /** Full child env (config content + password included). */
  env: Record<string, string>;
  password: string;
  logDir: string;
  startTimeoutMs: number;
}): Promise<DetachedSpawn> {
  const unit = `opensession-oc-${crypto.randomUUID().slice(0, 13)}`;
  const port = pickFreePort();
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(opts.logDir, { recursive: true });
  const logPath = `${opts.logDir}/${unit}.log`;
  const fd = openSync(logPath, "a");
  const engineCommand = secureAgentCommand([
    opts.bin,
    "serve",
    "--hostname=127.0.0.1",
    `--port=${port}`,
  ]);
  let waiter: Subprocess<"ignore", number, number>;
  try {
    waiter = Bun.spawn({
      cmd: [
        "systemd-run",
        "--user",
        "--scope",
        "--collect",
        "--quiet",
        `--unit=${unit}`,
        ...engineScopeSystemdArgs(),
        // SIGTERM→SIGKILL escalation for scope stops (meridian swallows TERM).
        "--property=TimeoutStopSec=5",
        "--",
        ...engineCommand,
      ],
      cwd: opts.cwd,
      env: { ...opts.env, ...systemdUserEnv(opts.env) },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    }) as Subprocess<"ignore", number, number>;
  } finally {
    // The child holds its own dup of the fd.
    try {
      closeSync(fd);
    } catch {}
  }

  const deadline = Date.now() + opts.startTimeoutMs;
  const logTail = () => {
    try {
      return readFileSync(logPath, "utf-8").slice(-500);
    } catch {
      return "";
    }
  };
  for (;;) {
    if (waiter.exitCode !== null) {
      throw new Error(
        `detached opencode serve (${unit}) exited with code ${waiter.exitCode}: ${logTail()}`
      );
    }
    if (await opencodeServerHealthy(url, opts.password, 1_500)) break;
    if (Date.now() > deadline) {
      stopDetachedUnit(unit);
      throw new Error(
        `detached opencode serve (${unit}) didn't answer within ${Math.round(
          opts.startTimeoutMs / 1000
        )}s: ${logTail()}`
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const pid = scopeMainPid(unit);
  if (!pid) {
    // Without the engine pid the registry record can't support adoption —
    // treat as a failed detach and let the caller fall back (the scope is
    // stopped so nothing leaks).
    stopDetachedUnit(unit);
    throw new Error(`detached opencode serve (${unit}): could not resolve scope pid`);
  }
  return { handle: detachedChildHandle(unit, pid, waiter), url, unit, pid };
}
