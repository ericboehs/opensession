/**
 * host-client — backstage's side of detached run hosts (src/runner-host/host.ts).
 *
 * Why: the SDK run driver used to live inside the backstage process, so ANY
 * real restart (route changes, runner changes, deploys) killed every in-flight
 * run mid-turn. A run host is a separate bun process in its own transient
 * systemd unit — outside the backstage.service cgroup — so backstage can
 * restart freely while runs keep streaming; on boot we reattach to the live
 * hosts' sockets and pick up exactly where we left off.
 *
 * This module:
 *  - spawns hosts (sudo systemd-run, mirroring backstage.service's IMDS deny),
 *  - adapts a host's socket into the same AsyncGenerator<StreamEvent> shape as
 *    runAgent, so call sites don't care where the run lives,
 *  - proxies asks (AskUserQuestion / Stripe confirms) to the caller's handler,
 *  - registers steer/interrupt/cancel controls in host-registry so the normal
 *    steerAgentRun/cancelAgentRun/isAgentSessionBusy paths treat hosted runs
 *    like in-process ones,
 *  - reconnects on socket drops, transparently respawns a crashed host to
 *    resume its engine session, and falls back to an in-process runAgent when
 *    spawning is impossible (or the kill-switch file is present).
 *
 * Kill switch: `touch ~/.backstage-chats/disable-run-hosts` — checked per run,
 * no restart needed; new runs go back in-process (old hosts finish normally).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import {
  runAgent,
  RESUME_CONTINUATION_PROMPT,
  type RunAgentOpts,
  type StreamEvent,
} from "./agent-runner";
import type { ActiveRunRecord, ImageInput } from "./claude-runner";
import type { GitIdentity } from "./shared/user-mappings";
import { providerFor } from "./models";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  registerHostRun,
  addHostRunKey,
  unregisterHostRun,
  type HostRunControl,
} from "./host-registry";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import {
  ndjsonReader,
  runHostsDir,
  rpcSocketPath,
  HOST_SOCK_NAME,
  HOST_SPEC_NAME,
  HOST_META_NAME,
  HOST_JOURNAL_NAME,
  HOST_LOG_NAME,
  BUN_BIN,
  REPO_ROOT,
  HOST_ENTRY,
  type RunHostSpec,
  type RunHostMeta,
  type HostToClientMsg,
  type ClientToHostMsg,
} from "../runner-host/protocol";

const HOSTS_DIR = runHostsDir(BACKSTAGE_CHATS_DIR);
const DISABLE_FILE = `${BACKSTAGE_CHATS_DIR}/disable-run-hosts`;
const ENV_FILE = `${process.env.HOME || "/home/ubuntu"}/.backstage.env`;

export function runHostsEnabled(): boolean {
  return !existsSync(DISABLE_FILE);
}

/** Options for a hosted run: RunAgentOpts minus the non-serializable bits,
 *  plus the host/session context. */
export interface HostedRunOpts {
  bksSessionId: string;
  prompt: string;
  /** Engine session id to resume (claude session id / codex thread id). */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  model?: string;
  images?: ImageInput[];
  forkSession?: boolean;
  resumeSessionAt?: string;
  mcpServers?: string[];
  /** michael-* servers to expose through the RPC proxy (interactive runs only). */
  proxyMcpServers?: string[];
  reposNote?: string;
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  aws?: boolean;
  author?: GitIdentity | null;
  user?: string;
  fallbackModel?: string;
  journalKind?: string;
  onAskUser?: RunAgentOpts["onAskUser"];
  /** A steer arrived too late at the host — queue it so it isn't dropped. */
  onSteerFailed?: (text: string) => void;
  /** Rebuilds the in-process SDK MCP servers if we fall back to runAgent. */
  fallbackInProcessMcp?: () => Record<string, unknown> | undefined;
}

/**
 * Run a prompt in a detached run host, yielding the same StreamEvents as
 * runAgent. Falls back to an in-process runAgent when hosts are disabled or
 * the spawn fails — a run should never be lost to infrastructure.
 */
export async function* runAgentHosted(opts: HostedRunOpts): AsyncGenerator<StreamEvent> {
  if (runHostsEnabled()) {
    let handle: HostHandle | null = null;
    try {
      handle = await spawnHostRun(opts);
    } catch (e) {
      console.error("[host-client] spawn failed — falling back to in-process run:", e);
    }
    if (handle) {
      yield* handle.events();
      return;
    }
  }
  yield* runAgent({
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    mode: opts.mode,
    model: opts.model,
    images: opts.images,
    forkSession: opts.forkSession,
    resumeSessionAt: opts.resumeSessionAt,
    mcpServers: opts.mcpServers,
    inProcessMcp: opts.fallbackInProcessMcp?.(),
    reposNote: opts.reposNote,
    deniedTools: opts.deniedTools,
    confirmTools: opts.confirmTools,
    aws: opts.aws,
    author: opts.author,
    user: opts.user,
    fallbackModel: opts.fallbackModel,
    journal: { bksSessionId: opts.bksSessionId, kind: opts.journalKind || "prompt" },
    onAskUser: opts.onAskUser,
  });
}

// ── Spawning ──────────────────────────────────────────────────────────────────

async function spawnHostRun(opts: HostedRunOpts): Promise<HostHandle> {
  const hostId = `rh-${Bun.randomUUIDv7()}`;
  const dir = `${HOSTS_DIR}/${hostId}`;
  mkdirSync(dir, { recursive: true });

  const rpcToken = opts.proxyMcpServers?.length ? crypto.randomUUID() : undefined;
  const spec: RunHostSpec = {
    hostId,
    bksSessionId: opts.bksSessionId,
    prompt: opts.prompt,
    engineSessionId: opts.sessionId,
    cwd: opts.cwd,
    mode: opts.mode,
    model: opts.model,
    images: opts.images,
    forkSession: opts.forkSession,
    resumeSessionAt: opts.resumeSessionAt,
    mcpServers: opts.mcpServers,
    proxyMcpServers: opts.proxyMcpServers,
    rpcToken,
    reposNote: opts.reposNote,
    deniedTools: opts.deniedTools,
    confirmTools: opts.confirmTools,
    aws: opts.aws,
    author: opts.author,
    user: opts.user,
    fallbackModel: opts.fallbackModel,
    journalKind: opts.journalKind,
  };
  writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec);
  if (rpcToken) registerRunToken(rpcToken, { sessionId: opts.bksSessionId, user: opts.user });

  try {
    await launchHostUnit(hostId, dir);
    const handle = new HostHandle(dir, spec, {
      onAskUser: opts.onAskUser,
      onSteerFailed: opts.onSteerFailed,
    });
    await handle.connectWithWait(20_000);
    return handle;
  } catch (e) {
    unregisterRunToken(rpcToken);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    throw e;
  }
}

/**
 * Launch the host as a transient SYSTEM unit (via passwordless sudo — the
 * aws-creds precedent). A user-manager unit won't do: it dies with the user
 * session unless linger is on, and — verified — user units silently ignore
 * IPAddressDeny, which would hand agent children the IMDS endpoint that
 * backstage.service deliberately denies.
 */
async function launchHostUnit(hostId: string, dir: string): Promise<void> {
  const env = (kv: string) => ["-p", `Environment=${kv}`];
  const args = [
    "sudo", "-n", "systemd-run", "--collect", "--quiet",
    `--unit=bks-run-${hostId}`,
    `--description=Backstage run host ${hostId}`,
    "--uid=ubuntu", "--gid=ubuntu",
    "-p", `WorkingDirectory=${REPO_ROOT}`,
    // Same env the backstage service runs with; MCP servers and account pools
    // load their own credentials the same way they do for in-process runs.
    "-p", `EnvironmentFile=${ENV_FILE}`,
    ...env(`HOME=${process.env.HOME || "/home/ubuntu"}`),
    ...env(`PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`),
    ...env("NODE_ENV=production"),
    ...(process.env.MICHAEL_MODEL ? env(`MICHAEL_MODEL=${process.env.MICHAEL_MODEL}`) : []),
    ...(process.env.MICHAEL_UI_BASE ? env(`MICHAEL_UI_BASE=${process.env.MICHAEL_UI_BASE}`) : []),
    // Per-host journal — never read-modify-write the shared active-runs.json.
    ...env(`BACKSTAGE_RUN_JOURNAL=${dir}/${HOST_JOURNAL_NAME}`),
    // Mirror backstage.service: agent runs must not reach EC2 instance creds.
    "-p", "IPAddressDeny=169.254.169.254/32",
    "-p", `StandardOutput=append:${dir}/${HOST_LOG_NAME}`,
    "-p", `StandardError=append:${dir}/${HOST_LOG_NAME}`,
    BUN_BIN, "run", HOST_ENTRY, `${dir}/${HOST_SPEC_NAME}`,
  ];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`systemd-run exited ${code}: ${err.trim().slice(0, 400)}`);
  }
}

// ── The handle: socket client + StreamEvent generator ─────────────────────────

/**
 * How a HostHandle's host process is launched/checked — the only part of the
 * handle that differs between backends. The default (systemd transient units)
 * is this module's launchHostUnit; the Docker sandbox provider
 * (src/server/sandbox/docker.ts) supplies a `docker exec` launcher and reuses
 * everything else: NDJSON protocol, ask proxying, reconnect, respawn-to-resume,
 * host-registry steer/cancel registration.
 */
export interface HostLauncher {
  /** Is the host process still alive? (`dir` is the host's run dir, `meta` its
   *  meta.json if readable.) Used to decide reconnect vs respawn. */
  alive(dir: string, meta: RunHostMeta | null): boolean | Promise<boolean>;
  /** Run dir for a respawned host id (spec.json is written there before launch). */
  newRunDir(hostId: string): string;
  /** Launch the host entry for the spec already written at `<dir>/spec.json`. */
  launch(hostId: string, dir: string): Promise<void>;
}

/** Default launcher: transient systemd units on this host. */
const systemdHostLauncher: HostLauncher = {
  alive(dir) {
    const meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    if (!meta?.pid) return false;
    try {
      process.kill(meta.pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  newRunDir: (hostId) => `${HOSTS_DIR}/${hostId}`,
  launch: launchHostUnit,
};

/** Unbounded push queue bridging socket callbacks to an async generator. */
class AsyncEventQueue {
  private items: StreamEvent[] = [];
  private waiters: Array<(r: IteratorResult<StreamEvent>) => void> = [];
  private closed = false;

  push(ev: StreamEvent): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.items.push(ev);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<StreamEvent>>((res) =>
        this.waiters.push(res)
      );
      if (r.done) return;
      yield r.value;
    }
  }
}

export interface HandleCallbacks {
  onAskUser?: RunAgentOpts["onAskUser"];
  onSteerFailed?: (text: string) => void;
}

export class HostHandle {
  private queue = new AsyncEventQueue();
  private sock: any = null;
  private up = false;
  private endedClean = false;
  private sawTerminal = false;
  private handlingAsks = new Set<string>();
  private respawns = 0;
  private readonly ctl: HostRunControl;
  engineSessionId?: string;

  constructor(
    private dir: string,
    private spec: RunHostSpec,
    private cb: HandleCallbacks,
    private launcher: HostLauncher = systemdHostLauncher
  ) {
    this.ctl = {
      hostId: spec.hostId,
      bksSessionId: spec.bksSessionId,
      steerable: providerFor(spec.model) !== "codex",
      connected: () => this.up,
      steer: (text) => this.send({ t: "steer", text }),
      interruptSteer: (text) => this.send({ t: "interrupt_steer", text }),
      cancel: () => this.send({ t: "cancel" }),
    };
    registerHostRun([spec.bksSessionId, spec.engineSessionId], this.ctl);
    if (spec.engineSessionId) this.engineSessionId = spec.engineSessionId;
  }

  events(): AsyncGenerator<StreamEvent> {
    return this.queue[Symbol.asyncIterator]();
  }

  private get sockPath(): string {
    return `${this.dir}/${HOST_SOCK_NAME}`;
  }

  private send(msg: ClientToHostMsg): boolean {
    if (!this.sock) return false;
    try {
      this.sock.write(JSON.stringify(msg) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** Poll for the socket file, then connect; used for fresh spawns and boot reattach. */
  async connectWithWait(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    for (;;) {
      if (existsSync(this.sockPath)) {
        try {
          await this.connectOnce();
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `run host ${this.spec.hostId} socket never became connectable: ${lastErr}`
        );
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const read = ndjsonReader((m) => this.handleMsg(m), "host-client");
      Bun.connect({
        unix: this.sockPath,
        socket: {
          open: (s: any) => {
            this.sock = s;
            this.up = true;
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          data: (_s: any, d: Buffer) => read(d),
          close: () => {
            this.up = false;
            this.sock = null;
            void this.onDisconnect();
          },
          error: (_s: any, e: unknown) => {
            console.warn(`[host-client] ${this.spec.hostId} socket error:`, e);
          },
          connectError: (_s: any, e: unknown) => {
            if (!settled) {
              settled = true;
              reject(e);
            }
          },
        },
      }).catch((e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  private noteEngineId(id: string): void {
    if (!id || id === this.engineSessionId) return;
    this.engineSessionId = id;
    addHostRunKey(id, this.ctl);
  }

  private handleMsg(msg: HostToClientMsg): void {
    switch (msg.t) {
      case "hello": {
        if (msg.engineSessionId) this.noteEngineId(msg.engineSessionId);
        for (const ask of msg.pendingAsks || []) this.handleAsk(ask.askId, ask.input);
        if (msg.state === "ended") {
          if (msg.done && !this.sawTerminal) {
            this.sawTerminal = true;
            this.queue.push(msg.done);
          }
          this.finish();
        }
        break;
      }
      case "event": {
        const ev = msg.event;
        if (ev.type === "init" && ev.sessionId) this.noteEngineId(ev.sessionId);
        if (ev.type === "done" || ev.type === "error") this.sawTerminal = true;
        this.queue.push(ev);
        break;
      }
      case "ask":
        this.handleAsk(msg.askId, msg.input);
        break;
      case "steer_failed":
        this.cb.onSteerFailed?.(msg.text);
        break;
      case "end": {
        if (msg.done && !this.sawTerminal) {
          this.sawTerminal = true;
          this.queue.push(msg.done);
        }
        this.finish();
        break;
      }
    }
  }

  private handleAsk(askId: string, input: Record<string, unknown>): void {
    // A reconnect re-delivers pending asks in hello — don't double-handle ones
    // this process is already blocking a human on.
    if (this.handlingAsks.has(askId)) return;
    this.handlingAsks.add(askId);
    void (async () => {
      let result:
        | { behavior: "allow"; updatedInput: Record<string, unknown> }
        | { behavior: "deny"; message: string };
      try {
        result = this.cb.onAskUser
          ? await this.cb.onAskUser(input)
          : {
              behavior: "deny" as const,
              message:
                "This run is headless — nobody can answer questions. Use your best judgment and note the assumption.",
            };
      } catch (e: any) {
        result = {
          behavior: "deny" as const,
          message: `Question UI failed (${e?.message || e}) — decide yourself and note the assumption.`,
        };
      }
      this.handlingAsks.delete(askId);
      this.send({ t: "ask_answer", askId, result });
    })();
  }

  /** Clean end: ack the host, close out the generator, drop registrations + files. */
  private finish(): void {
    if (this.endedClean) return;
    this.endedClean = true;
    this.send({ t: "shutdown" });
    this.queue.end();
    unregisterHostRun(this.ctl);
    unregisterRunToken(this.spec.rpcToken);
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {}
  }

  private async hostAlive(): Promise<boolean> {
    const meta = readJsonSafe<RunHostMeta>(`${this.dir}/${HOST_META_NAME}`);
    return this.launcher.alive(this.dir, meta);
  }

  /** Socket dropped without a clean end: reconnect while the host lives, else
   *  consume its final state — or respawn a crashed host to resume the run. */
  private async onDisconnect(): Promise<void> {
    while (!this.endedClean) {
      await new Promise((r) => setTimeout(r, 2000));
      if (this.endedClean) return;
      if (!(await this.hostAlive())) break;
      try {
        await this.connectOnce();
        return;
      } catch {}
    }
    if (this.endedClean) return;

    const meta = readJsonSafe<RunHostMeta>(`${this.dir}/${HOST_META_NAME}`);
    if (meta?.done) {
      // Host finished and exited between our polls — take the terminal state.
      if (!this.sawTerminal) {
        this.sawTerminal = true;
        this.queue.push(meta.done);
      }
      this.finish();
      return;
    }

    // Crashed mid-run. If the run had an engine session, respawn a fresh host
    // to resume it — transparent to whoever is consuming events().
    const journal = readHostJournal(this.dir);
    const engineId =
      journal?.claudeSessionId || this.engineSessionId || this.spec.engineSessionId;
    if (engineId && this.respawns < 2) {
      this.respawns++;
      console.warn(
        `[host-client] run host ${this.spec.hostId} died mid-run — respawning to resume ${this.spec.bksSessionId}`
      );
      try {
        await this.respawn(engineId);
        return;
      } catch (e) {
        console.error("[host-client] respawn failed:", e);
      }
    }
    this.queue.push({
      type: "error",
      content: "Run host process died unexpectedly and could not be resumed.",
    });
    this.finish();
  }

  private async respawn(engineId: string): Promise<void> {
    const oldDir = this.dir;
    const hostId = `rh-${Bun.randomUUIDv7()}`;
    const dir = this.launcher.newRunDir(hostId);
    mkdirSync(dir, { recursive: true });
    const spec: RunHostSpec = {
      ...this.spec,
      hostId,
      prompt: RESUME_CONTINUATION_PROMPT,
      engineSessionId: engineId,
      images: undefined,
      forkSession: undefined,
      resumeSessionAt: undefined,
      journalKind: `${this.spec.journalKind || "prompt"}-resume`,
    };
    writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec);
    await this.launcher.launch(hostId, dir);
    this.dir = dir;
    this.spec = spec;
    this.ctl.hostId = hostId;
    try {
      rmSync(oldDir, { recursive: true, force: true });
    } catch {}
    await this.connectWithWait(20_000);
  }
}

// ── Boot-time discovery & reattach ───────────────────────────────────────────

export interface DiscoveredHost {
  dir: string;
  spec: RunHostSpec;
  meta: RunHostMeta | null;
  /** The host's per-run journal record, if the run never finished. */
  journal: ActiveRunRecord | null;
  /** Host process still running (reattachable). */
  alive: boolean;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readHostJournal(dir: string): ActiveRunRecord | null {
  const j = readJsonSafe<Record<string, ActiveRunRecord>>(`${dir}/${HOST_JOURNAL_NAME}`);
  if (!j) return null;
  const records = Object.values(j);
  return records[0] || null;
}

/** Scan the run-hosts dir. Call once at boot, before any new spawns. */
export function discoverRunHosts(): DiscoveredHost[] {
  if (!existsSync(HOSTS_DIR)) return [];
  const out: DiscoveredHost[] = [];
  for (const name of readdirSync(HOSTS_DIR)) {
    const dir = `${HOSTS_DIR}/${name}`;
    const spec = readJsonSafe<RunHostSpec>(`${dir}/${HOST_SPEC_NAME}`);
    if (!spec) {
      // Torn dir from a crash mid-create — nothing to recover.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      continue;
    }
    const meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    let alive = false;
    if (meta?.pid) {
      try {
        process.kill(meta.pid, 0);
        alive = existsSync(`${dir}/${HOST_SOCK_NAME}`);
      } catch {}
    }
    out.push({ dir, spec, meta, journal: readHostJournal(dir), alive });
  }
  return out;
}

/**
 * Reattach to a live host after a backstage restart. Returns the same
 * generator shape as runAgentHosted; the caller runs the normal consumption
 * bookkeeping over it. Re-registers the run's RPC token so its michael-*
 * proxies keep working.
 */
export async function attachRunHost(
  d: DiscoveredHost,
  cb: HandleCallbacks
): Promise<AsyncGenerator<StreamEvent>> {
  if (d.spec.rpcToken) {
    registerRunToken(d.spec.rpcToken, {
      sessionId: d.spec.bksSessionId,
      user: d.spec.user,
    });
  }
  const handle = new HostHandle(d.dir, d.spec, cb);
  if (d.meta?.engineSessionId) {
    (handle as any).noteEngineId?.call(handle, d.meta.engineSessionId);
  }
  await handle.connectWithWait(10_000);
  return handle.events();
}

/** Remove a dead host's dir once its final state has been consumed. */
export function cleanupHostDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
