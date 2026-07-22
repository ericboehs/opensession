/** Fixed macOS execution node over SSH.
 *
 * The node is provisioned ahead of time and stays logged into an Aqua session.
 * Backstage uses SSH only as a control transport: each agent run itself is a
 * per-run LaunchAgent in gui/$UID, so it survives the SSH connection and can
 * later use Xcode and TCC-approved GUI automation from the console session.
 */

import { dirname } from "path";
import { REPO_ROOT } from "../../../runner-host/protocol";
import { getRepo } from "../../worktree";
import {
  sandboxCallbackBaseUrl,
  sandboxConfig,
  type SandboxMacosConfig,
} from "../config";
import type {
  ExecResult,
  PortMap,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import {
  REMOTE_OPENCODE_VERSION,
  assertDialbackReachable,
  findRemoteStateBySession,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  remoteRuntimePaths,
  removeRemoteState,
  sanitizeName,
  setupRemoteWorkspace,
  shellQuoteWord,
  touchRemoteState,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
  type RemoteRuntimePaths,
} from "./bootstrap";

export interface MacosSshConfig {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  remoteHome: string;
}

interface SshRunOptions {
  input?: string;
  timeoutMs?: number;
}

export type SshRunner = (argv: string[], options?: SshRunOptions) => Promise<ExecResult>;

function validateSshConfig(raw: SandboxMacosConfig | undefined): MacosSshConfig {
  const host = raw?.host?.trim();
  const remoteHome = raw?.remoteHome?.trim();
  if (!host || host.startsWith("-") || /\s/.test(host)) {
    throw new Error(
      'macos sandbox provider is not configured — set {"macos":{"host":"mac.example.ts.net","remoteHome":"/Users/opensession"}} in ~/.opensession-sandbox.json',
    );
  }
  if (!remoteHome?.startsWith("/") || remoteHome.includes("\0")) {
    throw new Error("macos.remoteHome must be an absolute path on the Mac");
  }
  if (raw?.user && !/^[A-Za-z0-9._-]+$/.test(raw.user)) {
    throw new Error("macos.user contains unsupported SSH username characters");
  }
  return {
    host,
    remoteHome,
    user: raw?.user,
    port: raw?.port,
    identityFile: raw?.identityFile,
  };
}

export function buildSshArgs(config: MacosSshConfig, remoteCommand: string): string[] {
  const target = config.user ? `${config.user}@${config.host}` : config.host;
  return [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=10",
    ...(config.port ? ["-p", String(config.port)] : []),
    ...(config.identityFile
      ? ["-o", "IdentitiesOnly=yes", "-i", config.identityFile]
      : []),
    "--",
    target,
    `/bin/sh -lc ${shellQuoteWord(remoteCommand)}`,
  ];
}

async function defaultSshRunner(
  argv: string[],
  options: SshRunOptions = {},
): Promise<ExecResult> {
  const proc = Bun.spawn(argv, {
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = readCappedStreamText(proc.stdout, 4 * 1024 * 1024, true);
  const stderr = readCappedStreamText(proc.stderr, 64 * 1024);
  void stdout.catch(() => {});
  void stderr.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {}
      resolve();
    }, options.timeoutMs ?? 120_000);
  });
  (timer as { unref?: () => void }).unref?.();
  try {
    if (options.input !== undefined) {
      proc.stdin!.write(options.input);
      proc.stdin!.end();
    }
    await Promise.race([proc.exited.then(() => undefined), timeout]);
    const exitCode = await proc.exited;
    return {
      exitCode: timedOut ? 124 : exitCode,
      stdout: await stdout,
      stderr: await stderr,
    };
  } catch (error) {
    try {
      proc.kill();
    } catch {}
    await proc.exited.catch(() => 1);
    await Promise.allSettled([stdout, stderr]);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function commandWithOptions(cmd: string, opts?: RemoteExecOpts): string {
  const cd = opts?.cwd ? `cd -- ${shellQuoteWord(opts.cwd)} && ` : "";
  const env = Object.entries(opts?.env || {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid remote environment key ${JSON.stringify(key)}`);
    }
    return `${key}=${shellQuoteWord(value)}`;
  });
  return `${cd}${env.length ? `env ${env.join(" ")} ` : ""}${cmd}`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface LaunchAgentPlistSpec {
  label: string;
  command: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string>;
}

export function buildLaunchAgentPlist(spec: LaunchAgentPlistSpec): string {
  const environment = Object.entries(spec.environment || {})
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>-lc</string>
      <string>${xml(spec.command)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${xml(spec.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(spec.stderrPath)}</string>
  </dict>
</plist>
`;
}

export function launchAgentCleanupCommand(sessionId: string, force: boolean): string {
  const prefix = `com.tella.opensession.${sanitizeName(sessionId)}`;
  const action = force
    ? 'launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true; rm -f "$plist"'
    : 'launchctl print "gui/$uid/$label" 2>/dev/null | grep -q "state = running" || { launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true; rm -f "$plist"; }';
  return (
    `uid=$(id -u); for plist in "$HOME/Library/LaunchAgents"/${prefix}.*.plist; do ` +
    `[ -e "$plist" ] || continue; ` +
    `label=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist" 2>/dev/null || true); ` +
    `[ -n "$label" ] || { rm -f "$plist"; continue; }; ${action}; done`
  );
}

const LEASE_STALE_AFTER_MS = 5 * 60_000;
const LEASE_INITIALIZING_GRACE_SECONDS = 30;
const MUTATION_LOCK_TTL_SECONDS = 300;
const MUTATION_LOCK_HEARTBEAT_MS = 30_000;

interface MacosLeaseOwner {
  sessionId: string;
  runId: string;
  acquiredAt: string;
}

function leaseDir(runtime: RemoteRuntimePaths): string {
  return `${runtime.home}/.opensession-node/foreground-lease`;
}

function mutationLockPath(runtime: RemoteRuntimePaths): string {
  return `${runtime.home}/.opensession-node/foreground-mutation.lock`;
}

function mutationOwnerPath(runtime: RemoteRuntimePaths): string {
  return `${runtime.home}/.opensession-node/foreground-mutation-owner.json`;
}

const MUTATION_LOCK_ACQUIRE_SCRIPT = `
import fcntl, json, os, signal, sys, time
lock_path, owner_path, token, ttl_raw = sys.argv[1:5]
ttl = int(ttl_raw)
expiry_grace = min(1.0, max(0.25, ttl * 0.1))
os.makedirs(os.path.dirname(lock_path), mode=0o700, exist_ok=True)
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    os.close(fd)
    sys.exit(75)
pid = os.fork()
if pid:
    os.close(fd)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            with open(owner_path, "r", encoding="utf-8") as handle:
                owner = json.load(handle)
            if owner.get("token") == token and owner.get("pid") == pid:
                sys.exit(0)
        except (OSError, ValueError):
            pass
        time.sleep(0.02)
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    sys.exit(76)
os.setsid()
devnull = os.open(os.devnull, os.O_RDWR)
for stream_fd in (0, 1, 2):
    os.dup2(devnull, stream_fd)
os.close(devnull)
stopping = [False]
def stop(_signum, _frame):
    stopping[0] = True
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
temporary = owner_path + "." + token + ".tmp"
payload = {"token": token, "pid": os.getpid(), "expiresAt": time.time() + ttl}
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, separators=(",", ":"))
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, owner_path)
while not stopping[0]:
    try:
        with open(owner_path, "r", encoding="utf-8") as handle:
            owner = json.load(handle)
            if owner.get("token") != token or time.time() >= owner.get("expiresAt", 0) + expiry_grace:
                break
    except (OSError, TypeError, ValueError):
        break
    time.sleep(0.1)
try:
    with open(owner_path, "r", encoding="utf-8") as handle:
        owns_file = json.load(handle).get("token") == token
    if owns_file:
        os.unlink(owner_path)
except (OSError, ValueError):
    pass
os.close(fd)
os._exit(0)
`;

const MUTATION_LOCK_REFRESH_SCRIPT = `
import json, os, sys, time
owner_path, token, ttl_raw = sys.argv[1:4]
ttl = int(ttl_raw)
try:
    with open(owner_path, "r", encoding="utf-8") as handle:
        owner = json.load(handle)
except (OSError, ValueError):
    sys.exit(76)
if owner.get("token") != token:
    sys.exit(77)
owner["expiresAt"] = time.time() + ttl
temporary = owner_path + "." + token + ".refresh.tmp"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(owner, handle, separators=(",", ":"))
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, owner_path)
`;

const MUTATION_LOCK_RELEASE_SCRIPT = `
import fcntl, json, os, sys
lock_path, owner_path, token = sys.argv[1:4]
try:
    with open(owner_path, "r", encoding="utf-8") as handle:
        owner = json.load(handle)
except (OSError, ValueError):
    sys.exit(0)
if owner.get("token") != token:
    sys.exit(77)
try:
    os.unlink(owner_path)
except FileNotFoundError:
    pass
fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;

function sessionRunDir(runtime: RemoteRuntimePaths, sessionId: string): string {
  return `${runtime.runsBase}/${sanitizeName(sessionId)}`;
}

function launchAgentPrefix(sessionId: string, runId?: string): string {
  return ["com.tella.opensession", sanitizeName(sessionId), runId && sanitizeName(runId)]
    .filter(Boolean)
    .join(".");
}

export function macosCleanupCommand(
  runtime: RemoteRuntimePaths,
  sessionId: string,
  runId?: string,
  workspace?: string,
): string {
  const lease = leaseDir(runtime);
  const owner = `${lease}/owner.json`;
  // A session can respawn its run-host under a new host id while retaining the
  // same foreground lease, so cleanup is session-wide for transient agents and
  // logs. The lease itself still uses runId to avoid releasing a newer owner.
  const prefix = launchAgentPrefix(sessionId);
  const logs = `${runtime.home}/Library/Logs/OpenSession`;
  const runRoot = sessionRunDir(runtime, sessionId);
  const runMatch = runId
    ? `[ "$owner_run" = ${shellQuoteWord(runId)} ] && [ "$owner_session" = ${shellQuoteWord(sessionId)} ]`
    : `[ -z "$owner_session" ] || [ "$owner_session" = ${shellQuoteWord(sessionId)} ]`;
  const sessionCleanup =
    `uid=$(id -u); cleanup_failed=0; ` +
    `for plist in "$HOME/Library/LaunchAgents"/${prefix}.*.plist; do ` +
    `[ -e "$plist" ] || continue; ` +
    `label=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist" 2>/dev/null || true); ` +
    `if [ -n "$label" ]; then launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true; ` +
    `if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then cleanup_failed=1; continue; fi; fi; ` +
    `rm -f "$plist"; done; ` +
    `for meta in ${shellQuoteWord(`${runRoot}/`)}*/meta.json; do [ -e "$meta" ] || continue; ` +
    `pid=$(/usr/bin/plutil -extract pid raw -o - "$meta" 2>/dev/null || true); ` +
    `[ -n "$pid" ] || continue; run_dir="\${meta%/meta.json}"; host_active=0; attempt=0; ` +
    `while [ "$attempt" -lt 50 ]; do attempt=$((attempt + 1)); ` +
    `command=$(ps -p "$pid" -o command= 2>/dev/null || true); ` +
    `if kill -0 "$pid" 2>/dev/null; then case "$command" in *"$run_dir/spec.json"*) host_active=1; sleep 0.1; continue;; esac; fi; ` +
    `host_active=0; break; done; [ "$host_active" -eq 0 ] || cleanup_failed=1; done; ` +
    `if [ "$cleanup_failed" -ne 0 ]; then echo 'macos run host survived launchctl bootout' >&2; exit 76; fi; ` +
    `${workspace ? `rm -rf ${shellQuoteWord(workspace)}; ` : ""}` +
    `rm -rf ${shellQuoteWord(runRoot)}; ` +
    `rm -f ${shellQuoteWord(`${logs}/${prefix}.`)}*.stdout.log ${shellQuoteWord(`${logs}/${prefix}.`)}*.stderr.log; `;
  const ownerRead =
    `owner_session=$(/usr/bin/plutil -extract sessionId raw -o - ${shellQuoteWord(owner)} 2>/dev/null || true); ` +
    `owner_run=$(/usr/bin/plutil -extract runId raw -o - ${shellQuoteWord(owner)} 2>/dev/null || true); `;
  return (
    (runId
      ? `${ownerRead}if ! { ${runMatch}; }; then exit 0; fi; ${sessionCleanup}`
      : `${sessionCleanup}${ownerRead}`) +
    `if ${runMatch}; then ` +
    `rm -f ${shellQuoteWord(`${runtime.home}/.backstage-claude-accounts.json`)} ` +
    `${shellQuoteWord(`${runtime.home}/.backstage-codex-accounts.json`)}; ` +
    `rm -rf ${shellQuoteWord(runtime.openaiSeedDir)} ${shellQuoteWord(lease)}; ` +
    `fi`
  );
}

const macosNodeMutationChains: Map<string, Promise<unknown>> =
  ((globalThis as any).__macosNodeMutationChains ??= new Map());

function withMacosNodeMutation<T>(runtime: RemoteRuntimePaths, fn: () => Promise<T>): Promise<T> {
  const key = runtime.home;
  const previous = macosNodeMutationChains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  macosNodeMutationChains.set(key, tail);
  void tail.finally(() => {
    if (macosNodeMutationChains.get(key) === tail) macosNodeMutationChains.delete(key);
  });
  return run;
}

export interface MacosMutationLock {
  token: string;
  heartbeat: ReturnType<typeof setInterval>;
  refreshInFlight: Promise<void> | null;
}

async function refreshMacosMutationLock(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  token: string,
  ttlSeconds: number,
): Promise<void> {
  const result = await driver.exec(
    `/usr/bin/python3 -c ${shellQuoteWord(MUTATION_LOCK_REFRESH_SCRIPT)} ` +
      `${shellQuoteWord(mutationOwnerPath(runtime))} ${shellQuoteWord(token)} ${ttlSeconds}`,
    { timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error("macos execution node mutation lock heartbeat was rejected");
  }
}

export async function acquireMacosMutationLock(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  options: { ttlSeconds?: number; heartbeatMs?: number } = {},
): Promise<MacosMutationLock> {
  const ttlSeconds = options.ttlSeconds ?? MUTATION_LOCK_TTL_SECONDS;
  const heartbeatMs = options.heartbeatMs ?? MUTATION_LOCK_HEARTBEAT_MS;
  const token = crypto.randomUUID();
  const result = await driver.exec(
    `/usr/bin/python3 -c ${shellQuoteWord(MUTATION_LOCK_ACQUIRE_SCRIPT)} ` +
      `${shellQuoteWord(mutationLockPath(runtime))} ` +
      `${shellQuoteWord(mutationOwnerPath(runtime))} ` +
      `${shellQuoteWord(token)} ${ttlSeconds}`,
    { timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error("macos execution node is being mutated by another process; retry the run");
  }
  const lock: MacosMutationLock = {
    token,
    heartbeat: undefined as unknown as ReturnType<typeof setInterval>,
    refreshInFlight: null,
  };
  lock.heartbeat = setInterval(() => {
    if (lock.refreshInFlight) return;
    lock.refreshInFlight = refreshMacosMutationLock(driver, runtime, token, ttlSeconds)
      .catch((error) => {
        console.warn("[sandbox:macos] mutation lock heartbeat failed:", error);
      })
      .finally(() => {
        lock.refreshInFlight = null;
      });
  }, heartbeatMs);
  lock.heartbeat.unref?.();
  return lock;
}

export async function releaseMacosMutationLock(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  lock: MacosMutationLock,
): Promise<void> {
  clearInterval(lock.heartbeat);
  await lock.refreshInFlight;
  const result = await driver.exec(
    `/usr/bin/python3 -c ${shellQuoteWord(MUTATION_LOCK_RELEASE_SCRIPT)} ` +
      `${shellQuoteWord(mutationLockPath(runtime))} ` +
      `${shellQuoteWord(mutationOwnerPath(runtime))} ${shellQuoteWord(lock.token)}`,
    { timeoutMs: 20_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error("macos execution node mutation lock could not be released");
  }
}

async function withMacosRemoteMutation<T>(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireMacosMutationLock(driver, runtime);
  try {
    return await fn();
  } finally {
    await releaseMacosMutationLock(driver, runtime, lock);
  }
}

async function cleanupMacosRunInner(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  sessionId: string,
  runId?: string,
  workspace?: string,
  mutationHeld = false,
): Promise<void> {
  const cleanup = async () => {
    const result = await driver.exec(
      macosCleanupCommand(runtime, sessionId, runId, workspace),
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `macos cleanup failed for ${sessionId}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
      );
    }
  };
  if (mutationHeld) return cleanup();
  return withMacosRemoteMutation(driver, runtime, cleanup);
}

async function cleanupMacosRun(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  sessionId: string,
  runId?: string,
  workspace?: string,
): Promise<void> {
  return withMacosNodeMutation(runtime, () =>
    cleanupMacosRunInner(driver, runtime, sessionId, runId, workspace),
  );
}

async function macosLeaseActive(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  owner: MacosLeaseOwner,
): Promise<boolean> {
  const meta = `${sessionRunDir(runtime, owner.sessionId)}/${sanitizeName(owner.runId)}/meta.json`;
  const spec = `${sessionRunDir(runtime, owner.sessionId)}/${sanitizeName(owner.runId)}/spec.json`;
  const prefix = launchAgentPrefix(owner.sessionId, owner.runId);
  const result = await driver.exec(
    `pid=$(/usr/bin/plutil -extract pid raw -o - ${shellQuoteWord(meta)} 2>/dev/null || true); ` +
      `command=$([ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null || true); ` +
      `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then ` +
      `case "$command" in *${shellQuoteWord(runtime.hostEntry)}*${shellQuoteWord(spec)}*) exit 0;; esac; fi; ` +
      `uid=$(id -u); for plist in "$HOME/Library/LaunchAgents"/${prefix}.*.plist; do ` +
      `[ -e "$plist" ] || continue; ` +
      `label=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist" 2>/dev/null || true); ` +
      `[ -n "$label" ] && launchctl print "gui/$uid/$label" 2>/dev/null | grep -q "state = running" && exit 0; ` +
      `done; exit 1`,
    { timeoutMs: 20_000 },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `macos liveness probe failed (${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
  );
}

async function acquireMacosLeaseInner(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  sessionId: string,
  runId: string,
  now = new Date(),
  mutationHeld = false,
): Promise<void> {
  const lease = leaseDir(runtime);
  const owner: MacosLeaseOwner = { sessionId, runId, acquiredAt: now.toISOString() };
  const tryAcquire = () =>
    driver.exec(
      `mkdir -p ${shellQuoteWord(dirname(lease))}; ` +
        `if mkdir ${shellQuoteWord(lease)} 2>/dev/null; then ` +
        `owner_tmp=${shellQuoteWord(`${lease}/owner.json.tmp`)}.$$; ` +
        `if printf '%s' ${shellQuoteWord(JSON.stringify(owner))} > "$owner_tmp" && ` +
        `mv "$owner_tmp" ${shellQuoteWord(`${lease}/owner.json`)} && ` +
        `[ "$(cat ${shellQuoteWord(`${lease}/owner.json`)} 2>/dev/null)" = ${shellQuoteWord(JSON.stringify(owner))} ]; then exit 0; fi; ` +
        `rm -f "$owner_tmp"; exit 72; ` +
        `fi; ` +
        `if [ ! -f ${shellQuoteWord(`${lease}/owner.json`)} ]; then ` +
        `lease_mtime=$(stat -f%m -- ${shellQuoteWord(lease)} 2>/dev/null || echo 0); now_s=$(date +%s); ` +
        `if [ "$lease_mtime" -gt 0 ] && [ $((now_s-lease_mtime)) -lt ${LEASE_INITIALIZING_GRACE_SECONDS} ]; then ` +
        `echo __INITIALIZING__; exit 74; fi; echo __STALE_MISSING__; exit 73; fi; ` +
        `cat ${shellQuoteWord(`${lease}/owner.json`)}; exit 73`,
      { timeoutMs: 20_000 },
    );

  const acquire = async () => {
    let acquired = await tryAcquire();
    if (acquired.exitCode === 0) return;
    if (acquired.exitCode === 74) {
      throw new Error("macos execution node foreground lease is still initializing; retry the run");
    }
    if (acquired.exitCode !== 73) {
      throw new Error(
        `macos foreground lease failed: ${(acquired.stderr || acquired.stdout).trim().slice(0, 500)}`,
      );
    }

    let current: MacosLeaseOwner | null = null;
    try {
      current = JSON.parse(acquired.stdout) as MacosLeaseOwner;
    } catch {}
    const age = current ? now.getTime() - Date.parse(current.acquiredAt) : Infinity;
    if (
      current &&
      (age < LEASE_STALE_AFTER_MS || (await macosLeaseActive(driver, runtime, current)))
    ) {
      throw new Error(
        `macos execution node is busy with ${current.sessionId} (${current.runId}); ` +
          "the MVP serializes all runs on this fixed Aqua desktop",
      );
    }

    // Re-read while holding the distributed mutation lock. This also defends
    // against an older Backstage process that does not lock its fast path.
    const rechecked = await tryAcquire();
    if (rechecked.exitCode === 0) return;
    if (rechecked.exitCode === 74) {
      throw new Error("macos execution node foreground lease is still initializing; retry the run");
    }
    if (rechecked.exitCode !== 73 || rechecked.stdout.trim() !== acquired.stdout.trim()) {
      throw new Error("macos execution node foreground lease changed while reclaiming; retry the run");
    }

    if (current?.sessionId) {
      if (await macosLeaseActive(driver, runtime, current)) {
        throw new Error(
          `macos execution node is busy with ${current.sessionId} (${current.runId}); ` +
            "the MVP serializes all runs on this fixed Aqua desktop",
        );
      }
      await cleanupMacosRunInner(driver, runtime, current.sessionId, current.runId, undefined, true);
    } else {
      await driver.exec(`rm -rf ${shellQuoteWord(lease)}`);
    }
    acquired = await tryAcquire();
    if (acquired.exitCode !== 0) {
      throw new Error("macos execution node foreground lease was claimed concurrently; retry the run");
    }
  };
  if (mutationHeld) return acquire();
  return withMacosRemoteMutation(driver, runtime, acquire);
}

export function acquireMacosLease(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  sessionId: string,
  runId: string,
  now = new Date(),
): Promise<void> {
  return withMacosNodeMutation(runtime, () =>
    acquireMacosLeaseInner(driver, runtime, sessionId, runId, now),
  );
}

export function createMacosSshDriver(
  config: MacosSshConfig,
  sessionId: string,
  runner: SshRunner = defaultSshRunner,
): RemoteDriver {
  const run = (command: string, options?: SshRunOptions) =>
    runner(buildSshArgs(config, command), options);
  const exec = (cmd: string, opts?: RemoteExecOpts) =>
    run(commandWithOptions(cmd, opts), { timeoutMs: opts?.timeoutMs });

  return {
    exec,

    async writeFile(path, content) {
      const result = await run(
        `umask 077; mkdir -p ${shellQuoteWord(dirname(path))} && cat > ${shellQuoteWord(path)}`,
        { input: content },
      );
      if (result.exitCode !== 0) {
        throw new Error(`macos SSH file write failed for ${path}: ${(result.stderr || result.stdout).trim()}`);
      }
    },

    async ensureStarted() {
      const result = await run(
        'uid=$(id -u); launchctl print "gui/$uid" >/dev/null 2>&1',
        { timeoutMs: 20_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          "macos execution node has no active gui/$UID launchd domain; log the dedicated user into an unlocked Aqua desktop before starting a run",
        );
      }
    },

    async execBackground(cmd, opts) {
      await this.ensureStarted();
      const uidResult = await exec("id -u", { timeoutMs: 20_000 });
      if (uidResult.exitCode !== 0 || !/^\d+$/.test(uidResult.stdout.trim())) {
        throw new Error(`macos execution node could not resolve its Aqua uid: ${uidResult.stderr.trim()}`);
      }
      const uid = uidResult.stdout.trim();
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const launchId = sanitizeName(opts?.launchId || "run");
      const label = `${launchAgentPrefix(sessionId, launchId)}.${suffix}`;
      const launchAgents = `${config.remoteHome}/Library/LaunchAgents`;
      const logs = `${config.remoteHome}/Library/Logs/OpenSession`;
      const plistPath = `${launchAgents}/${label}.plist`;
      const stdoutPath = `${logs}/${label}.stdout.log`;
      const stderrPath = `${logs}/${label}.stderr.log`;
      const cleanup =
        `__bks_status=$?; rm -f ${shellQuoteWord(plistPath)}; ` +
        `launchctl bootout gui/${uid}/${shellQuoteWord(label)} >/dev/null 2>&1 || true; ` +
        `exit $__bks_status`;
      const plist = buildLaunchAgentPlist({
        label,
        command: `${commandWithOptions(cmd, opts)}; ${cleanup}`,
        stdoutPath,
        stderrPath,
        environment: opts?.env,
      });
      await this.writeFile(plistPath, plist);
      const started = await exec(
        `mkdir -p ${shellQuoteWord(logs)} && chmod 600 ${shellQuoteWord(plistPath)} && ` +
          `launchctl print gui/${uid} >/dev/null 2>&1 && ` +
          `launchctl bootstrap gui/${uid} ${shellQuoteWord(plistPath)}`,
        { timeoutMs: 30_000 },
      );
      if (started.exitCode !== 0) {
        await exec(`rm -f ${shellQuoteWord(plistPath)}`);
        throw new Error(
          `macos LaunchAgent ${label} failed to bootstrap in gui/${uid}: ` +
            `${(started.stderr || started.stdout).trim().slice(0, 500)}`,
        );
      }
    },
  };
}

function need(result: ExecResult, message: string): void {
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 400);
    throw new Error(`macos execution node is not ready: ${message}${detail ? ` (${detail})` : ""}`);
  }
}

export async function verifyMacosReadiness(
  driver: RemoteDriver,
  runtime: RemoteRuntimePaths,
  expectedRunnerSha: string,
): Promise<void> {
  const platform = await driver.exec("uname -s && uname -m");
  need(platform, "could not inspect platform");
  const [os, arch] = platform.stdout.trim().split(/\s+/);
  if (os !== "Darwin" || arch !== "arm64") {
    throw new Error(`macos execution node requires Darwin arm64; found ${os || "unknown"} ${arch || "unknown"}`);
  }
  need(
    await driver.exec(
      'uid=$(id -u); [ "$(stat -f %Su /dev/console)" = "$(id -un)" ] && launchctl print "gui/$uid" >/dev/null 2>&1',
    ),
    "the SSH user must be the logged-in Aqua console user",
  );
  need(await driver.exec("xcode-select -p >/dev/null && xcodebuild -version"), "full Xcode is unavailable");
  need(await driver.exec("test -x /usr/bin/python3 && /usr/bin/python3 --version"), "Python 3 is unavailable");
  need(await driver.exec(`test -x ${shellQuoteWord(runtime.bun)} && ${shellQuoteWord(runtime.bun)} --version`), "Bun is unavailable at the configured remote home");
  need(await driver.exec(`test -x ${shellQuoteWord(runtime.claude)} && ${shellQuoteWord(runtime.claude)} --version`), "Claude CLI is unavailable at the configured remote home");
  const opencode = await driver.exec(
    `test -x ${shellQuoteWord(runtime.opencode)} && ${shellQuoteWord(runtime.opencode)} --version`,
  );
  need(opencode, "OpenCode is unavailable at the configured remote home");
  if (opencode.stdout.trim() !== REMOTE_OPENCODE_VERSION) {
    throw new Error(
      `macos execution node OpenCode version mismatch: got ${opencode.stdout.trim() || "unknown"}, want ${REMOTE_OPENCODE_VERSION}`,
    );
  }
  need(
    await driver.exec(`test -f ${shellQuoteWord(runtime.hostEntry)}`),
    `runner host is missing at ${runtime.hostEntry}`,
  );
  need(
    await driver.exec(
      `test -d ${shellQuoteWord(`${runtime.runnerRepo}/node_modules`)} && test -s ${shellQuoteWord(`${runtime.home}/.claude/settings.json`)}`,
    ),
    "runner dependencies or ~/.claude/settings.json are missing; finish Mac provisioning",
  );
  const head = await driver.exec(`git -C ${shellQuoteWord(runtime.runnerRepo)} rev-parse HEAD`);
  need(head, `runner checkout is not a git repository at ${runtime.runnerRepo}`);
  if (head.stdout.trim() !== expectedRunnerSha) {
    throw new Error(
      `macos execution node runner SHA mismatch: got ${head.stdout.trim() || "unknown"}, want ${expectedRunnerSha}; update the provisioned runner checkout before selecting macos`,
    );
  }
}

async function localRunnerSha(): Promise<string> {
  const ref = sandboxConfig().runnerSha || "HEAD";
  const proc = Bun.spawn(["git", "-C", REPO_ROOT, "rev-parse", `${ref}^{commit}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0 || !stdout.trim()) {
    throw new Error(
      `could not resolve Backstage runner ref ${ref}; set runnerSha to a commit available in ${REPO_ROOT}`,
    );
  }
  return stdout.trim();
}

function macosRuntime(config: MacosSshConfig): RemoteRuntimePaths {
  return remoteRuntimePaths(
    config.remoteHome,
    `${config.remoteHome}/projects/tella-backstage`,
    `${config.remoteHome}/.bun/bin:${config.remoteHome}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  );
}

export class MacosProvider implements SandboxProvider {
  readonly id = "macos" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () => this.ensureInner(spec));
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    if (spec.attachedDirs?.length) {
      throw new Error("attached repos are not supported on the macos execution node — detach them or use docker/local");
    }
    const config = validateSshConfig(sandboxConfig().macos);
    const runtime = macosRuntime(config);
    const previous = findRemoteStateBySession(this.id, spec.sessionId);
    const repo = getRepo(spec.repo || previous?.repoId);
    const branch = spec.branch || previous?.branch || repo.defaultBranch;
    // Never reuse spec.cwd: that is the Linux parent's path. Every child gets
    // a clone rooted under the Mac user's home, isolated by session id.
    const cwd =
      previous?.cwd ||
      `${config.remoteHome}/.opensession-workspaces/${sanitizeName(spec.sessionId)}/${sanitizeName(repo.id)}`;
    const sandboxId = previous?.sandboxId || `macos-${sanitizeName(spec.sessionId)}`;
    const driver = createMacosSshDriver(config, spec.sessionId);

    await driver.ensureStarted();
    await verifyMacosReadiness(driver, runtime, await localRunnerSha());
    await assertDialbackReachable(driver, "macos", sandboxCallbackBaseUrl());
    await setupRemoteWorkspace(
      driver,
      cwd,
      await remoteCloneUrl(repo),
      branch,
      repo.defaultBranch,
      undefined,
      runtime,
    );
    writeRemoteState({
      sandboxId,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: previous?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    return this.makeHandle(sandboxId, spec.sessionId, cwd, driver, runtime);
  }

  private makeHandle(
    sandboxId: string,
    sessionId: string,
    cwd: string,
    driver: RemoteDriver,
    runtime: RemoteRuntimePaths,
  ): Sandbox {
    const providerId = this.id;
    const launchLocks = new Map<string, MacosMutationLock>();
    return makeRemoteSandbox({
      providerId,
      sandboxId,
      sessionId,
      cwd,
      driver,
      runtime,
      callbackBaseUrl: sandboxCallbackBaseUrl,
      beforeRun: async (spec) => {
        const lock = await acquireMacosMutationLock(driver, runtime);
        try {
          await acquireMacosLeaseInner(
            driver,
            runtime,
            sessionId,
            spec.hostId,
            new Date(),
            true,
          );
          launchLocks.set(spec.hostId, lock);
        } catch (error) {
          await releaseMacosMutationLock(driver, runtime, lock);
          throw error;
        }
      },
      afterLaunch: async (spec) => {
        const lock = launchLocks.get(spec.hostId);
        if (!lock) return;
        launchLocks.delete(spec.hostId);
        await releaseMacosMutationLock(driver, runtime, lock);
      },
      afterRun: (spec) =>
        cleanupMacosRun(driver, runtime, sessionId, spec.hostId),
      recoverStaleRun: (_sessionId, runId) =>
        cleanupMacosRun(driver, runtime, sessionId, runId),
      async ports(): Promise<PortMap> {
        return {};
      },
      async status(): Promise<SandboxStatus> {
        const status = await driver.exec("true", { timeoutMs: 15_000 });
        return status.exitCode === 0 ? "running" : "gone";
      },
      touchActivity: () => touchRemoteState(providerId, sandboxId),
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    const config = validateSshConfig(sandboxConfig().macos);
    const runtime = macosRuntime(config);
    const driver = createMacosSshDriver(config, state.sessionId);
    await driver.ensureStarted();
    await verifyMacosReadiness(driver, runtime, await localRunnerSha());
    return this.makeHandle(sandboxId, state.sessionId, state.cwd, driver, runtime);
  }

  async destroy(sandboxId: string): Promise<void> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) {
      removeRemoteState(this.id, sandboxId);
      return;
    }
    try {
      const config = validateSshConfig(sandboxConfig().macos);
      const runtime = macosRuntime(config);
      const driver = createMacosSshDriver(config, state.sessionId);
      await cleanupMacosRun(
        driver,
        runtime,
        state.sessionId,
        undefined,
        state.cwd,
      );
    } catch (error) {
      console.warn(
        `[sandbox:macos] destroy(${sandboxId}) remote cleanup failed; retaining state for retry:`,
        error,
      );
      throw error;
    }
    removeRemoteState(this.id, sandboxId);
  }
}

// ── Remote asset import (opensession-assets' import_remote_asset tool) ───────
//
// A remote child session can only hand us a path relative to ITS workspace —
// no Linux SSH credential or reverse connection reaches it. Backstage
// resolves the session's sandbox state server-side, confines the path to the
// remote workspace root, stats + checksums before transfer, and reads the
// bytes over the same noninteractive SSH transport every other macos
// operation uses. The MVP buffers the whole file in the Backstage process
// (capped by the caller's maxBytes, session-assets.ts's MAX_IMPORT_BYTES) —
// writing to disk is session-assets.ts's job (importAsset), not this
// adapter's, so macos.ts stays free of "assets" concept knowledge.

export interface MacosRemoteStat {
  kind: "file" | "dir" | "missing";
  size: number;
  sha256?: string;
}

const REMOTE_ASSET_OPEN_SCRIPT = `
import hashlib
import os
import stat
import sys

root, relative, mode = sys.argv[1:4]
parts = relative.split("/")
if not relative or any(part in ("", ".", "..") for part in parts):
    print("invalid workspace-relative asset path", file=sys.stderr)
    sys.exit(80)

flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
dir_flags = flags | os.O_DIRECTORY
fds = []
try:
    current = os.open(root, dir_flags)
    fds.append(current)
    for part in parts[:-1]:
        current = os.open(part, dir_flags, dir_fd=current)
        fds.append(current)
    try:
        target = os.open(parts[-1], flags, dir_fd=current)
    except FileNotFoundError:
        if mode == "stat":
            print("MISSING")
            sys.exit(0)
        raise
    fds.append(target)
    info = os.fstat(target)
    if stat.S_ISDIR(info.st_mode):
        if mode == "stat":
            print("DIR")
            sys.exit(0)
        print("remote asset is a directory", file=sys.stderr)
        sys.exit(82)
    if not stat.S_ISREG(info.st_mode):
        print("remote asset is not a regular file", file=sys.stderr)
        sys.exit(82)
    if mode == "stat":
        digest = hashlib.sha256()
        while True:
            chunk = os.read(target, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        print(info.st_size)
        print(digest.hexdigest())
    elif mode == "read":
        while True:
            chunk = os.read(target, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(1, view)
                view = view[written:]
    else:
        print("invalid asset operation", file=sys.stderr)
        sys.exit(80)
except OSError as error:
    print("cannot open confined remote asset: %s" % error, file=sys.stderr)
    sys.exit(82)
finally:
    for fd in reversed(fds):
        try:
            os.close(fd)
        except OSError:
            pass
`;

function remoteAssetCommand(
  remoteWorkspace: string,
  absPath: string,
  mode: "stat" | "read",
): string {
  const prefix = `${remoteWorkspace}/`;
  if (!absPath.startsWith(prefix)) {
    throw new Error("macos asset path escapes the workspace");
  }
  const relative = absPath.slice(prefix.length);
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("macos asset path must name a file inside the workspace");
  }
  return `/usr/bin/python3 -c ${shellQuoteWord(REMOTE_ASSET_OPEN_SCRIPT)} ${shellQuoteWord(remoteWorkspace)} ${shellQuoteWord(relative)} ${mode}`;
}

/** Stat + checksum a remote path through one descriptor-rooted open. */
export async function statMacosRemotePath(
  driver: RemoteDriver,
  remoteWorkspace: string,
  absPath: string,
): Promise<MacosRemoteStat> {
  const result = await driver.exec(
    remoteAssetCommand(remoteWorkspace, absPath, "stat"),
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `macos asset stat failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    );
  }
  const out = result.stdout.trim();
  if (out === "DIR") return { kind: "dir", size: 0 };
  if (out === "MISSING" || !out) return { kind: "missing", size: 0 };
  const [sizeLine, shaLine] = out.split("\n");
  const size = Number((sizeLine || "").trim());
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`macos asset stat returned an unexpected size: ${JSON.stringify(sizeLine)}`);
  }
  const sha256 = shaLine?.trim() || "";
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
    throw new Error(`macos asset stat returned an invalid sha256: ${JSON.stringify(shaLine)}`);
  }
  return { kind: "file", size, sha256: sha256.toLowerCase() };
}

/** Confine a remote-child-supplied path to the session's remote workspace —
 *  the only path input import_remote_asset accepts from the model. */
export function resolveMacosWorkspacePath(remoteWorkspace: string, relPath: string): string {
  const raw = (relPath || "").trim().replace(/^\.\//, "");
  if (!raw) throw new Error("remotePath is required");
  if (raw.startsWith("/") || raw.includes("\0") || raw.split("/").includes("..")) {
    throw new Error(
      `remotePath must be relative inside the session's remote workspace (no leading /, no ..): ${relPath}`,
    );
  }
  return `${remoteWorkspace}/${raw}`;
}

/** A minimal duck-typed process handle so pipeMacosRemoteFile can be unit
 *  tested against a fake byte stream instead of a real SSH connection. */
export interface MacosRemoteProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export type MacosRemoteSpawner = (argv: string[]) => MacosRemoteProcess;

export async function readCappedStreamText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  failOnOverflow = false,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let overflowed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - retained;
      if (remaining <= 0) {
        overflowed = true;
        continue;
      }
      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(chunk);
      retained += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) overflowed = true;
    }
  } finally {
    reader.releaseLock();
  }
  if (overflowed && failOnOverflow) {
    throw new Error(`remote command stdout exceeds the ${maxBytes}-byte capture cap`);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function defaultMacosRemoteSpawn(argv: string[]): MacosRemoteProcess {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill();
      } catch {}
    },
  };
}

/** Stream one remote file's raw bytes to a caller-provided sink. Stdout is
 * never decoded through text/base64, and the cap is enforced mid-stream. */
export async function pipeMacosRemoteFile<T>(
  config: MacosSshConfig,
  remoteWorkspace: string,
  absPath: string,
  maxBytes: number,
  consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
  spawn: MacosRemoteSpawner = defaultMacosRemoteSpawn,
): Promise<T> {
  const argv = buildSshArgs(
    config,
    remoteAssetCommand(remoteWorkspace, absPath, "read"),
  );
  const proc = spawn(argv);
  const reader = proc.stdout.getReader();
  const stderrPromise = readCappedStreamText(proc.stderr, 64 * 1024);
  void stderrPromise.catch(() => {});
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 120_000);
  (timeout as { unref?: () => void }).unref?.();
  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`remote asset exceeds the ${maxBytes}-byte import cap`);
        }
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const stopStdout = async () => {
    try {
      await reader.cancel();
    } catch {
      try {
        await proc.stdout.cancel();
      } catch {}
    }
    try {
      reader.releaseLock();
    } catch {}
  };
  try {
    const consumed = await consume(chunks);
    await stopStdout();
    const exitCode = await proc.exited;
    const stderr = await stderrPromise;
    if (timedOut) throw new Error("macos asset fetch timed out");
    if (exitCode !== 0) {
      throw new Error(
        `macos asset fetch failed (ssh exit ${exitCode}): ${stderr.trim().slice(0, 300) || "no stderr"}`,
      );
    }
    return consumed;
  } catch (error) {
    await stopStdout();
    try {
      proc.kill();
    } catch {}
    await proc.exited.catch(() => 1);
    await stderrPromise.catch(() => "");
    if (timedOut) throw new Error("macos asset fetch timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export interface MacosAssetFetchInput<T> {
  sandboxId: string;
  sessionId: string;
  remotePath: string;
  maxBytes: number;
  consume: (
    chunks: AsyncIterable<Uint8Array>,
    expected: { size: number; sha256: string },
  ) => Promise<T>;
}

export interface MacosAssetFetchResult<T> {
  value: T;
  remoteAbsPath: string;
}

/**
 * Fetch one file out of a macOS execution-node session's remote workspace,
 * over the same noninteractive SSH transport as every other macos operation.
 * The remote child supplies only remotePath (workspace-relative); Backstage
 * resolves the session's own sandbox state to find the workspace root and
 * SSH config — no Linux credential or reverse connection reaches the child.
 */
export async function fetchMacosAsset<T>(
  input: MacosAssetFetchInput<T>,
): Promise<MacosAssetFetchResult<T>> {
  const state = readRemoteState("macos", input.sandboxId);
  if (!state) {
    throw new Error(
      `macos execution node has no recorded workspace for sandbox ${input.sandboxId} — run something on this session before importing an asset`,
    );
  }
  if (state.sessionId !== input.sessionId) {
    throw new Error("macos sandbox state does not belong to this session");
  }
  const config = validateSshConfig(sandboxConfig().macos);
  const absPath = resolveMacosWorkspacePath(state.cwd, input.remotePath);
  const driver = createMacosSshDriver(config, state.sessionId);
  const info = await statMacosRemotePath(driver, state.cwd, absPath);
  if (info.kind === "missing") {
    throw new Error(`remote asset not found in the session workspace: ${input.remotePath}`);
  }
  if (info.kind === "dir") {
    throw new Error(`remote asset path is a directory, not a file: ${input.remotePath}`);
  }
  if (info.size > input.maxBytes) {
    throw new Error(
      `remote asset is ${info.size} bytes, over the ${input.maxBytes}-byte import cap`,
    );
  }
  const value = await pipeMacosRemoteFile(
    config,
    state.cwd,
    absPath,
    input.maxBytes,
    (chunks) => input.consume(chunks, { size: info.size, sha256: info.sha256! }),
  );
  return { value, remoteAbsPath: absPath };
}
