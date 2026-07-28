/**
 * BoxProvider — remote sandbox adapter over the ascii.dev Box API
 * (https://docs.ascii.dev/box/api/v1; the third remote provider next to
 * Daytona/E2B). Boxes are persistent Ubuntu VMs (4 vCPU / 8GB, Docker inside,
 * per-second billing, EU) with archive/resume snapshots — archival is
 * recoverable, so the idle contract is gentler than E2B's kill-on-countdown.
 *
 * No SDK dependency: the official @asciidev/box-sdk is a young (0.0.x)
 * OpenAPI-generated client, and the six endpoints used here are plain JSON —
 * a tiny fetch client keeps the dependency tree flat. Endpoints (base
 * https://ascii.dev/api/box/v1, Bearer `box_…` key):
 *   POST /boxes {ttlSeconds,noEnv}    create (returns provisioning; poll GET)
 *   GET  /boxes, GET /boxes/{id}      list (cursor-paginated) / get
 *   PATCH /boxes/{id} {name,ttlSeconds}  rename + reset the auto-stop timer
 *   POST /boxes/{id}/commands         sync shell exec — capped at 60s (!)
 *   PUT  /boxes/{id}/files            write file (base64)
 *   POST /boxes/{id}/resume, DELETE /boxes/{id}
 *
 * Shape (shared machinery in ./bootstrap.ts):
 *  - ensure(): find the session's box by NAME (`PATCH name=<sessionId>` after
 *    create — the API has no labels; the local state file is the fallback
 *    index), create otherwise, resume if archived, bootstrap the runner
 *    payload, clone the workspace inside (always volume-style).
 *  - Idle model: a box has a TTL countdown to ARCHIVAL (max 30 days; archived
 *    boxes resume with disk intact). Created with idleStopMinutes and reset
 *    via PATCH on touchActivity — mirroring E2B's countdown-extension, but a
 *    missed touch archives (recoverable) instead of killing the workspace.
 *  - exec(): the commands endpoint hard-caps timeoutSeconds at 60, but
 *    bootstrap needs multi-minute execs (bun install ~900s) — longer commands
 *    run DETACHED (setsid, exit code + output tails to /tmp/.bks-exec/<id>)
 *    and are polled with short commands until done or deadline.
 *  - execBackground(): setsid on the persistent VM — the process survives the
 *    API call and this backstage process.
 *  - ports(): the in-box `host <port>` CLI registers a public HTTPS route
 *    (https://<subdomain>-<port>.on.ascii.dev, `_token`-protected by default)
 *    and prints the URL — parsed into PortMap `{url}` entries.
 *  - get()/destroy(): by box id; destroy deletes the box and with it the
 *    volume-style workspace — push your work (volume-mode contract).
 *
 * Not built yet (follow-ups, same as e2b): no prewarm adapter, no Shell-tab
 * remote PTY (the API's PTY surface is SSH — needs key provisioning).
 * Unconfigured (no apiKey in the config's `box` block or BOX_API_KEY) fails
 * loudly at ensure-time.
 */

import { getRepo, worktreePathFor } from "../../worktree";
import { sandboxConfig } from "../config";
import type {
  PortMap,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  bootstrapRemoteWorkspaceRuntime,
  findRemoteStateBySession,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  removeRemoteState,
  setupRemoteWorkspace,
  shellQuoteWord,
  touchRemoteState,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";

const DEFAULT_API_URL = "https://ascii.dev/api/box/v1";
const DEFAULT_IDLE_STOP_MINUTES = 30;
/** The commands endpoint rejects timeoutSeconds > 60 — anything longer goes
 *  through the detached-exec poll path. Kept under the cap for slack. */
const SYNC_EXEC_MAX_MS = 55_000;
const POLL_INTERVAL_MS = 2_500;
/** Bound on the out/err tails read back from a detached exec (their API also
 *  truncates large command outputs — bootstrap only greps errors from these). */
const TAIL_BYTES = 200_000;
/** Delimits stdout from stderr in the detached-exec readback. */
const OUT_ERR_DELIM = "__BKS_OUT_ERR_9c1b__";

/** States where the VM is up and can take commands. `running` is their
 *  "agent busy" state — still a live VM. */
const LIVE_STATES = new Set(["ready", "idle", "running"]);

interface BoxRecord {
  id: string;
  name?: string;
  state?: string;
  url?: string | null;
  ip?: string | null;
}

interface BoxCommandResponse {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

interface BoxListPage {
  boxes: BoxRecord[];
  pageInfo?: { nextCursor: string | null; hasMore: boolean };
}

interface BoxClientConfig {
  apiKey: string;
  apiUrl: string;
}

function boxClientConfig(): BoxClientConfig {
  const cfg = sandboxConfig().box || {};
  const apiKey = cfg.apiKey || process.env.BOX_API_KEY;
  if (!apiKey) {
    throw new Error(
      'box sandbox provider is not configured — set {"box":{"apiKey":"…"}} in ~/.opensession-sandbox.json or BOX_API_KEY',
    );
  }
  return { apiKey, apiUrl: (cfg.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "") };
}

async function boxApi<T>(
  cfg: BoxClientConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(
      `box API ${method} ${path} failed: HTTP ${res.status}${text ? ` ${text.slice(0, 300)}` : ""}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

function isNotFound(e: unknown): boolean {
  return (e as { status?: number })?.status === 404;
}

async function getBox(cfg: BoxClientConfig, boxId: string): Promise<BoxRecord | null> {
  try {
    const res = await boxApi<{ box?: BoxRecord } & BoxRecord>(cfg, "GET", `/boxes/${boxId}`);
    return res.box || res;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function stateOf(box: BoxRecord | null): SandboxStatus {
  if (!box) return "gone";
  const s = String(box.state || "");
  if (LIVE_STATES.has(s)) return "running";
  if (s === "error") return "gone";
  // init/provisioning/provisioned/cloning/archiving/archived — recoverable.
  return "stopped";
}

function idleTtlSeconds(): number {
  return (sandboxConfig().idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLive(
  cfg: BoxClientConfig,
  boxId: string,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < deadline) {
    const box = await getBox(cfg, boxId);
    if (!box) throw new Error(`box ${boxId} is gone`);
    last = String(box.state || "");
    if (LIVE_STATES.has(last)) return;
    if (last === "error") throw new Error(`box ${boxId} is in error state`);
    if (last === "archived") {
      try {
        await boxApi(cfg, "POST", `/boxes/${boxId}/resume`, { noEnv: true });
      } catch (e) {
        // Racing resumes 4xx — the state poll below decides.
        console.warn(`[sandbox:box] resume(${boxId}) failed (will re-poll):`, e);
      }
    }
    await sleep(3_000);
  }
  throw new Error(`box ${boxId} did not become ready in ${deadlineMs}ms (state: ${last})`);
}

// ── Driver ────────────────────────────────────────────────────────────────────

/** cwd/env fold into the command string: the commands endpoint only takes a
 *  cwd RELATIVE to the box work dir, and no env at all. */
function composeShell(cmd: string, opts?: RemoteExecOpts): string {
  let s = cmd;
  const env = opts?.env && Object.keys(opts.env).length ? opts.env : undefined;
  if (env) {
    const pairs = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuoteWord(v)}`)
      .join(" ");
    s = `env ${pairs} sh -c ${shellQuoteWord(s)}`;
  }
  if (opts?.cwd) s = `cd ${shellQuoteWord(opts.cwd)} && { ${s}\n}`;
  return s;
}

function boxDriver(cfg: BoxClientConfig, boxId: string): RemoteDriver {
  /** One sync call to the commands endpoint (≤60s server cap). */
  const execSync = async (shell: string, timeoutMs: number) => {
    try {
      const r = await boxApi<BoxCommandResponse>(
        cfg,
        "POST",
        `/boxes/${boxId}/commands`,
        {
          command: shell,
          timeoutSeconds: Math.min(60, Math.max(1, Math.ceil(timeoutMs / 1000))),
        },
        timeoutMs + 30_000,
      );
      return {
        exitCode: r.timedOut ? 124 : Number(r.exitCode ?? 1),
        stdout: r.stdout ?? "",
        stderr: (r.stderr ?? "") + (r.timedOut ? "\n[box] command timed out" : ""),
      };
    } catch (e: any) {
      return { exitCode: 1, stdout: "", stderr: String(e?.message || e) };
    }
  };

  /** Detached exec + poll for commands longer than the endpoint's 60s cap:
   *  start under setsid writing exit code + streams to a scratch dir, then
   *  poll with short commands until the code file appears or we hit the
   *  caller's deadline. The START command itself waits ~2.5s inline and emits
   *  the result when the command already finished — fast commands (git
   *  status & co, which reach this path because Sandbox.exec has no timeout
   *  knob and defaults over the sync cap) cost ONE round-trip, not a poll. */
  const execPolled = async (shell: string, timeoutMs: number) => {
    const id = `bks-${crypto.randomUUID().slice(0, 8)}`;
    const dir = `/tmp/.bks-exec/${id}`;
    const script = `{ ${shell}\n} >${dir}/out 2>${dir}/err; echo $? >${dir}/code`;
    const emit =
      `if [ -f ${dir}/code ]; then echo "BKS_DONE:$(cat ${dir}/code)"; ` +
      `tail -c ${TAIL_BYTES} ${dir}/out; printf '%s' ${shellQuoteWord(OUT_ERR_DELIM)}; ` +
      `tail -c ${TAIL_BYTES} ${dir}/err; rm -rf ${dir}; else echo BKS_WAIT; fi`;
    const parseDone = (stdout: string) => {
      if (!stdout.startsWith("BKS_DONE:")) return null;
      const nl = stdout.indexOf("\n");
      const code = Number(stdout.slice("BKS_DONE:".length, nl < 0 ? undefined : nl).trim());
      const rest = nl < 0 ? "" : stdout.slice(nl + 1);
      const di = rest.indexOf(OUT_ERR_DELIM);
      return {
        exitCode: Number.isFinite(code) ? code : 1,
        stdout: di >= 0 ? rest.slice(0, di) : rest,
        stderr: di >= 0 ? rest.slice(di + OUT_ERR_DELIM.length) : "",
      };
    };
    const start = await execSync(
      `mkdir -p ${dir} && setsid sh -c ${shellQuoteWord(script)} </dev/null >/dev/null 2>&1 & ` +
        `i=0; while [ $i -lt 25 ] && [ ! -f ${dir}/code ]; do sleep 0.1; i=$((i+1)); done; ${emit}`,
      30_000,
    );
    if (start.exitCode !== 0 || (!start.stdout.startsWith("BKS_DONE:") && !start.stdout.includes("BKS_WAIT"))) {
      return {
        exitCode: start.exitCode || 1,
        stdout: "",
        stderr: `[box] detached exec failed to start: ${(start.stderr || start.stdout).slice(0, 300)}`,
      };
    }
    const early = parseDone(start.stdout);
    if (early) return early;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const p = await execSync(emit, 30_000);
      if (p.exitCode !== 0) continue; // transient API hiccup — keep polling
      const done = parseDone(p.stdout);
      if (done) return done;
    }
    void execSync(`rm -rf ${dir}`, 15_000);
    return {
      exitCode: 124,
      stdout: "",
      stderr: `[box] command still running after ${timeoutMs}ms (detached exec ${id})`,
    };
  };

  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      const shell = composeShell(cmd, opts);
      const timeoutMs = opts?.timeoutMs ?? 120_000;
      return timeoutMs <= SYNC_EXEC_MAX_MS
        ? execSync(shell, timeoutMs)
        : execPolled(shell, timeoutMs);
    },

    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      // setsid on a persistent VM detaches from the command's process tree —
      // the process survives this API call and this backstage process.
      const shell = composeShell(cmd, opts);
      const r = await execSync(
        `setsid sh -c ${shellQuoteWord(shell)} </dev/null >/dev/null 2>&1 & echo BKS_BG`,
        30_000,
      );
      if (r.exitCode !== 0 || !r.stdout.includes("BKS_BG")) {
        throw new Error(`box execBackground failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
      }
    },

    async writeFile(path: string, content: string) {
      // base64 keeps arbitrary content (tokens, JSON with newlines) intact
      // through the JSON body.
      await boxApi(
        cfg,
        "PUT",
        `/boxes/${boxId}/files`,
        {
          path,
          content: Buffer.from(content, "utf-8").toString("base64"),
          encoding: "base64",
        },
        60_000,
      );
    },

    async ensureStarted() {
      const box = await getBox(cfg, boxId);
      if (!box) throw new Error(`box ${boxId} is gone`);
      if (LIVE_STATES.has(String(box.state || ""))) return;
      await waitForLive(cfg, boxId, 300_000);
    },
  };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class BoxProvider implements SandboxProvider {
  readonly id = "box" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () => this.ensureInner(spec));
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    if (spec.attachedDirs?.length) {
      throw new Error("attached repos are not supported in remote sandboxes — detach them or use docker/local");
    }
    const cfg = boxClientConfig();
    const prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd =
      spec.cwd || prevState?.cwd || worktreePathFor(branch, repo.id, { isolated: true });

    // Find by name (authoritative — set via PATCH below), else state file.
    let box: BoxRecord | null = null;
    try {
      box = await this.findBoxBySession(cfg, spec.sessionId);
    } catch (e) {
      console.warn(`[sandbox:box] name lookup failed (will create):`, e);
    }
    if (!box && prevState) {
      try {
        box = await getBox(cfg, prevState.sandboxId);
      } catch {}
    }
    if (box && stateOf(box) === "gone") box = null;
    if (!box) {
      console.log(`[sandbox:box] creating box for ${spec.sessionId}`);
      // noEnv: never inject the ascii account's dashboard secrets — every
      // credential a run needs is uploaded scoped per launch (bootstrap.ts).
      const created = await boxApi<{ box: BoxRecord }>(
        cfg,
        "POST",
        `/boxes`,
        { ttlSeconds: idleTtlSeconds(), noEnv: true },
        60_000,
      );
      box = created.box;
      // The session name is the recovery index (the API has no labels). A
      // rename failure is non-fatal — the local state file still maps it.
      try {
        await boxApi(cfg, "PATCH", `/boxes/${box.id}`, { name: spec.sessionId });
      } catch (e) {
        console.warn(`[sandbox:box] rename(${box.id}) failed (state file still maps it):`, e);
      }
    } else {
      // Adopted an existing box — reset the archival countdown for this turn.
      try {
        await boxApi(cfg, "PATCH", `/boxes/${box.id}`, { ttlSeconds: idleTtlSeconds() });
      } catch {}
    }

    const driver = boxDriver(cfg, box.id);
    await driver.ensureStarted();
    // Cheap dial-back probe BEFORE the expensive bootstrap — same rationale
    // as daytona: a box that can't reach our callback URL can never run.
    if (spec.runtime === "workspace") {
      await bootstrapRemoteWorkspaceRuntime(driver, "box");
    } else {
      await assertDialbackReachable(driver, "box");
      await bootstrapRemoteSandbox(driver, "box");
    }
    await setupRemoteWorkspace(
      driver,
      cwd,
      await remoteCloneUrl(repo),
      branch,
      repo.defaultBranch,
      repo.id,
    );
    writeRemoteState({
      sandboxId: box.id,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    return this.makeHandle(cfg, box.id, spec.sessionId, cwd);
  }

  /** Cursor-paginated list, matched by name client-side (no server filter). */
  private async findBoxBySession(
    cfg: BoxClientConfig,
    sessionId: string,
  ): Promise<BoxRecord | null> {
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const qs = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res: BoxListPage = await boxApi<BoxListPage>(cfg, "GET", `/boxes?${qs}`);
      const hit = (res.boxes || []).find(
        (b) => b.name === sessionId && String(b.state || "") !== "error",
      );
      if (hit) return hit;
      if (!res.pageInfo?.hasMore || !res.pageInfo.nextCursor) return null;
      cursor = res.pageInfo.nextCursor;
    }
    return null;
  }

  private makeHandle(
    cfg: BoxClientConfig,
    boxId: string,
    sessionId: string,
    cwd: string,
  ): Sandbox {
    const providerId = this.id;
    const driver = boxDriver(cfg, boxId);
    return makeRemoteSandbox({
      providerId,
      sandboxId: boxId,
      sessionId,
      cwd,
      driver,
      async ports(): Promise<PortMap> {
        const map: PortMap = {};
        for (const port of sandboxConfig().previewPorts || []) {
          try {
            // The in-box `host` CLI registers (idempotently) a public HTTPS
            // route for the port and prints its URL — `_token`-protected by
            // default, which suits us: these land in the session UI, not on
            // the open internet.
            const r = await driver.exec(`host ${port}`, { timeoutMs: 45_000 });
            const m = `${r.stdout} ${r.stderr}`.match(
              /https:\/\/[^\s"']+\.on\.ascii\.dev[^\s"']*/,
            );
            if (m) map[port] = { url: m[0] };
            else {
              console.warn(
                `[sandbox:box] host ${port} printed no URL:`,
                (r.stderr || r.stdout).trim().slice(0, 200),
              );
            }
          } catch (e) {
            console.warn(`[sandbox:box] host ${port} failed:`, e);
          }
        }
        return map;
      },
      async status(): Promise<SandboxStatus> {
        try {
          return stateOf(await getBox(cfg, boxId));
        } catch {
          return "gone";
        }
      },
      touchActivity: () => {
        touchRemoteState(providerId, boxId);
        // Reset the archival countdown (their TTL is a hard deadline, not an
        // idle timer) — same keepalive shape as E2B's setTimeout extension.
        void boxApi(cfg, "PATCH", `/boxes/${boxId}`, { ttlSeconds: idleTtlSeconds() }).catch(
          (e) => console.warn(`[sandbox:box] ttl refresh(${boxId}) failed:`, e),
        );
      },
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const cfg = boxClientConfig();
      const box = await getBox(cfg, sandboxId);
      if (!box || stateOf(box) === "gone") return null;
      return this.makeHandle(cfg, sandboxId, state.sessionId, state.cwd);
    } catch (e) {
      console.warn(`[sandbox:box] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  /** Deletes the box — and with it the volume-style workspace (documented
   *  data loss: push your work). */
  async destroy(sandboxId: string): Promise<void> {
    try {
      const cfg = boxClientConfig();
      await boxApi(cfg, "DELETE", `/boxes/${sandboxId}`, undefined, 60_000);
    } catch (e) {
      if (!isNotFound(e)) console.warn(`[sandbox:box] destroy(${sandboxId}):`, e);
    }
    removeRemoteState(this.id, sandboxId);
  }
}
