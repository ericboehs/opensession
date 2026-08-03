/**
 * DaytonaProvider — remote sandbox adapter over the Daytona API
 * (the sandbox rollout plan §5 Phase 3).
 *
 * LICENSING: the Daytona *platform* is AGPL-3.0, but it is consumed here
 * purely over its HTTP API via the official TypeScript SDK `@daytonaio/sdk`
 * (pinned 0.194.0), which is **Apache-2.0** (verified from the npm `license`
 * field, 2026-07-08). No AGPL code is imported, linked, or vendored; AGPL
 * obligations rest with whoever operates the Daytona deployment (their cloud,
 * or a self-hosted Helm/K8s install).
 *
 * Shape (shared machinery in ./bootstrap.ts):
 *  - ensure(): find the session's sandbox by label `backstage.session=<id>`
 *    (create with the config's resources otherwise), bootstrap the runner
 *    payload, clone the workspace INSIDE the sandbox (always volume-style —
 *    never a host mount; `cloneCredential` does the auth). Idle-stop uses
 *    Daytona's NATIVE autoStopInterval (minutes) — no backstage sweep needed.
 *  - launchRun(): HOST_ENTRY in-sandbox via a Daytona process session
 *    (runAsync — survives this call and this process), WS transport back to
 *    `callbackBaseUrl` (remote sandboxes have no socket option).
 *  - exec(): `process.executeCommand` takes a shell string and folds stderr
 *    into stdout, so commands are wrapped to preserve argv semantics AND a
 *    separate stderr/exit code (see daytonaDriver).
 *  - ports(): getPreviewLink(port) URLs → PortMap `{url}` entries (Daytona's
 *    preview domain; non-public sandboxes need Daytona's preview token —
 *    operator-side setting).
 *  - get()/destroy(): by sandbox id; destroy deletes the sandbox and with it
 *    the workspace — push your work (volume-mode contract).
 *
 * The SDK is imported lazily inside methods so backstage boot never pays its
 * dependency tree (otel/aws-sdk) unless the provider is actually used.
 * Unconfigured (no apiKey in ~/.backstage-sandbox.json `daytona` block or
 * DAYTONA_API_KEY) fails loudly at ensure-time.
 */

import type { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
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
import {
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  PREWARM_KEY_LABEL,
  PREWARM_LABEL,
  type PrewarmAdapter,
} from "../prewarm";

const SESSION_LABEL = "backstage.session";
const DEFAULT_IDLE_STOP_MINUTES = 30;
/** Delimits stdout from stderr inside the merged executeCommand output. */
const ERR_DELIM = "__BKS_STDERR_7f3a__";

async function daytonaClient(): Promise<Daytona> {
  const cfg = sandboxConfig().daytona || {};
  const apiKey = cfg.apiKey || process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'daytona sandbox provider is not configured — set {"daytona":{"apiKey":"…"}} in ~/.opensession-sandbox.json or DAYTONA_API_KEY',
    );
  }
  const { Daytona } = await import("@daytonaio/sdk");
  return new Daytona({ apiKey, apiUrl: cfg.apiUrl, target: cfg.target as any });
}

// ── Driver ────────────────────────────────────────────────────────────────────

function daytonaDriver(sbx: DaytonaSandbox): RemoteDriver {
  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      // executeCommand merges stderr into `result`; wrap to recover streams +
      // exit code (the trailing `exit $__c` propagates the real code).
      const wrapped =
        `__o=$(mktemp); __e=$(mktemp); { ${cmd}\n} >"$__o" 2>"$__e"; __c=$?; ` +
        `cat "$__o"; printf '%s' ${shellQuoteWord(ERR_DELIM)}; cat "$__e"; rm -f "$__o" "$__e"; exit $__c`;
      try {
        const res = await sbx.process.executeCommand(
          wrapped,
          opts?.cwd,
          opts?.env,
          Math.ceil((opts?.timeoutMs ?? 120_000) / 1000),
        );
        const out = String(res.result ?? "");
        const idx = out.indexOf(ERR_DELIM);
        return {
          exitCode: Number(res.exitCode ?? 1),
          stdout: idx >= 0 ? out.slice(0, idx) : out,
          stderr: idx >= 0 ? out.slice(idx + ERR_DELIM.length) : "",
        };
      } catch (e: any) {
        return { exitCode: 1, stdout: "", stderr: String(e?.message || e) };
      }
    },

    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      // Process sessions are Daytona's documented long-lived exec surface;
      // runAsync detaches from this call (and this process) entirely.
      const sid = `bks-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      await sbx.process.createSession(sid);
      const cd = opts?.cwd ? `cd ${shellQuoteWord(opts.cwd)} && ` : "";
      await sbx.process.executeSessionCommand(sid, {
        command: `${cd}${cmd}`,
        runAsync: true,
      } as any);
    },

    async writeFile(path: string, content: string) {
      await sbx.fs.uploadFile(Buffer.from(content, "utf-8"), path);
    },

    async ensureStarted() {
      try {
        await (sbx as any).refreshData?.();
      } catch {}
      if ((sbx as any).state !== "started") {
        await sbx.start();
      }
    },
  };
}

/** IO wiring the Shell tab hands a remote PTY (see src/server/terminals.ts). */
export interface RemotePtyIo {
  cols: number;
  rows: number;
  onData: (chunk: Uint8Array) => void;
  /** Fired once when the remote shell exits (undefined = unknown code). */
  onExit: (code: number | undefined) => void;
}

/** Live remote-PTY handle: input, resize (real SIGWINCH), teardown. */
export interface RemotePtyHandle {
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

/**
 * Interactive shell inside a Daytona sandbox (the session viewer's Shell tab
 * — see src/server/terminals.ts): wake the sandbox and open the SDK's native
 * PTY (`process.createPty`, a WebSocket to the sandbox's toolbox API) in the
 * session's workspace.
 *
 * Why not ssh: the previous transport (`ssh <token>@ssh.app.daytona.io` with
 * a remote command) never got a remote tty — the gateway ignores pty-req on
 * exec channels — so the shell had no prompt/echo and the tab looked dead
 * (2026-07-09). The SDK PTY is a real tty: prompt, echo, and resize all work,
 * and there's no per-shell token to mint/revoke. The socket terminates at
 * backstage; the browser still only speaks the tailnet-gated session WS.
 */
export async function daytonaPtySession(
  sandboxId: string,
  cwd: string,
  io: RemotePtyIo,
): Promise<RemotePtyHandle> {
  const client = await daytonaClient();
  const sbx = await client.get(sandboxId);
  if (!sbx || stateOf(sbx) === "gone") {
    throw new Error(`daytona sandbox ${sandboxId} is gone`);
  }
  await daytonaDriver(sbx).ensureStarted();
  const pty = await sbx.process.createPty({
    id: `shell-${crypto.randomUUID().slice(0, 8)}`,
    cwd,
    envs: { TERM: "xterm-256color" },
    cols: io.cols,
    rows: io.rows,
    onData: io.onData,
  });
  await pty.waitForConnection();
  void pty.wait().then(
    (r) => io.onExit(r?.exitCode),
    () => io.onExit(undefined),
  );
  return {
    write: (data) => void pty.sendInput(data).catch(() => {}),
    resize: (cols, rows) => void pty.resize(cols, rows).catch(() => {}),
    close: () => {
      void pty
        .kill()
        .catch(() => {})
        .finally(() => void pty.disconnect().catch(() => {}));
    },
  };
}

function stateOf(sbx: DaytonaSandbox): SandboxStatus {
  const s = String((sbx as any).state || "");
  if (s === "started") return "running";
  if (["stopped", "archived", "paused", "stopping", "starting"].includes(s)) return "stopped";
  if (!s) return "stopped";
  return s === "destroyed" || s === "destroying" || s === "error" ? "gone" : "stopped";
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class DaytonaProvider implements SandboxProvider {
  readonly id = "daytona" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () => this.ensureInner(spec));
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    if (spec.attachedDirs?.length) {
      throw new Error("attached repos are not supported in remote sandboxes — detach them or use docker/local");
    }
    const cfg = sandboxConfig();
    const client = await daytonaClient();
    const prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd =
      spec.cwd || prevState?.cwd || worktreePathFor(branch, repo.id, { isolated: true });

    // Find by label (authoritative), else create.
    let sbx: DaytonaSandbox | null = null;
    try {
      for await (const s of client.list({ labels: { [SESSION_LABEL]: spec.sessionId } } as any)) {
        sbx = s;
        break;
      }
    } catch (e) {
      console.warn(`[sandbox:daytona] label lookup failed (will create):`, e);
    }
    if (!sbx && prevState) {
      try {
        sbx = await client.get(prevState.sandboxId);
      } catch {}
    }
    if (sbx && stateOf(sbx) === "gone") sbx = null;
    if (!sbx && spec.runtime !== "workspace") {
      // Warm-on-typing adoption (src/server/sandbox/prewarm.ts): a ready
      // prewarm for (daytona, repo) whose runner pin + snapshot still match
      // is claimed atomically and relabeled to this session — the expensive
      // bootstrap below becomes a marker no-op and only the workspace clone
      // remains. When the prewarm is still MID-BOOTSTRAP (the common case:
      // typing→send is seconds, bootstrap ~20-60s) this WAITS for it instead
      // of cold-creating a racing sibling next to the warming sandbox. Any
      // hiccup falls through to the cold create; the claimed sandbox is
      // discarded so paid compute never dangles.
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        try {
          const cand = await client.get(claim.sandboxId);
          if (cand && stateOf(cand) !== "gone") {
            // setLabels REPLACES the label map — the prewarm labels vanish
            // here, which is what retires it from the pool's orphan audit.
            await cand.setLabels({ [SESSION_LABEL]: spec.sessionId, "backstage.sandbox": "1" });
            // Swap the pool's short-TTL backstops for the session lifecycle.
            await cand.setAutostopInterval(cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES);
            await cand.setAutoDeleteInterval(-1);
            sbx = cand;
            console.log(
              `[sandbox:daytona] adopted prewarmed sandbox ${cand.id} for ${spec.sessionId}`,
            );
          } else {
            discardClaimedPrewarm(this.id, claim.sandboxId);
          }
        } catch (e) {
          console.warn(`[sandbox:daytona] prewarm adoption failed (cold-creating):`, e);
          sbx = null;
          discardClaimedPrewarm(this.id, claim.sandboxId);
        }
      }
    }
    if (!sbx) {
      console.log(`[sandbox:daytona] creating sandbox for ${spec.sessionId}`);
      // Sizing comes from the configured org snapshot — custom `resources`
      // are rejected when creating from a snapshot (live-API behavior
      // 2026-07). Unset = Daytona's default snapshot (1 vCPU/1GB/3GiB disk),
      // too small for real repo workspaces: the runner payload alone is ~2GB
      // and a tella-fusion clone died on ENOSPC. See SandboxDaytonaConfig.
      sbx = await client.create(
        {
          ...(cfg.daytona?.snapshot ? { snapshot: cfg.daytona.snapshot } : {}),
          labels: { [SESSION_LABEL]: spec.sessionId, "backstage.sandbox": "1" },
          autoStopInterval: cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES,
        } as any,
        { timeout: 300 },
      );
    }

    const driver = daytonaDriver(sbx);
    await driver.ensureStarted();
    // Cheap dial-back probe BEFORE the expensive bootstrap: a sandbox that
    // can't reach our callback URL can never run anything — fail fast with
    // the documented error instead of 30s+ of doomed bootstrap.
    if (spec.runtime === "workspace") {
      await bootstrapRemoteWorkspaceRuntime(driver, "daytona");
    } else {
      await assertDialbackReachable(driver, "daytona");
      await bootstrapRemoteSandbox(driver, "daytona");
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
      sandboxId: sbx.id,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    return this.makeHandle(sbx, spec.sessionId, cwd);
  }

  private makeHandle(sbx: DaytonaSandbox, sessionId: string, cwd: string): Sandbox {
    const providerId = this.id;
    return makeRemoteSandbox({
      providerId,
      sandboxId: sbx.id,
      sessionId,
      cwd,
      driver: daytonaDriver(sbx),
      async ports(): Promise<PortMap> {
        const map: PortMap = {};
        for (const port of sandboxConfig().previewPorts || []) {
          try {
            const link = await sbx.getPreviewLink(port);
            if (link?.url) map[port] = { url: link.url };
          } catch (e) {
            console.warn(`[sandbox:daytona] getPreviewLink(${port}) failed:`, e);
          }
        }
        return map;
      },
      async status(): Promise<SandboxStatus> {
        try {
          await (sbx as any).refreshData?.();
          return stateOf(sbx);
        } catch {
          return "gone";
        }
      },
      touchActivity: () => touchRemoteState(providerId, sbx.id),
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const client = await daytonaClient();
      const sbx = await client.get(sandboxId);
      if (!sbx || stateOf(sbx) === "gone") return null;
      return this.makeHandle(sbx, state.sessionId, state.cwd);
    } catch (e) {
      console.warn(`[sandbox:daytona] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  /** Deletes the sandbox — and with it the volume-style workspace (documented
   *  data loss: push your work). */
  async destroy(sandboxId: string): Promise<void> {
    try {
      const client = await daytonaClient();
      const sbx = await client.get(sandboxId);
      if (sbx) await client.delete(sbx, 120);
    } catch (e) {
      console.warn(`[sandbox:daytona] destroy(${sandboxId}):`, e);
    }
    removeRemoteState(this.id, sandboxId);
  }
}

// ── Warm-on-typing prewarm hooks (src/server/sandbox/prewarm.ts) ─────────────

/**
 * The pool's provider hooks. Prewarm creates mirror the session create shape
 * (same org snapshot — sizing is create-time, so an adopted sandbox must
 * already be the right size) but carry the PREWARM labels instead of a
 * session label, plus provider-side autoStop/autoDelete backstops so a
 * crashed backstage can't leak paid compute. Loaded lazily by prewarm.ts —
 * this module statically imports claimPrewarm from there, so the reverse
 * edge must stay dynamic.
 */
export const daytonaPrewarmAdapter: PrewarmAdapter = {
  async create(labels, opts) {
    const cfg = sandboxConfig();
    const sbx = await (await daytonaClient()).create(
      {
        ...(cfg.daytona?.snapshot ? { snapshot: cfg.daytona.snapshot } : {}),
        labels,
        autoStopInterval: opts.autoStopMinutes,
        autoDeleteInterval: opts.autoDeleteMinutes,
      } as any,
      { timeout: 300 },
    );
    return { sandboxId: sbx.id, driver: daytonaDriver(sbx) };
  },

  async destroy(sandboxId) {
    try {
      const client = await daytonaClient();
      const sbx = await client.get(sandboxId);
      if (sbx) await client.delete(sbx, 120);
    } catch (e) {
      console.warn(`[sandbox:daytona] prewarm destroy(${sandboxId}):`, e);
    }
  },

  async listPrewarmed() {
    const client = await daytonaClient();
    const out: Array<{ id: string; key: string }> = [];
    for await (const s of client.list({ labels: { [PREWARM_LABEL]: "1" } } as any)) {
      // Mid-teardown sandboxes still list with their labels for a few
      // seconds — same guard as the conformance leftovers audit.
      const state = String((s as any).state || "");
      if (/destroy|delet/i.test(state)) continue;
      out.push({
        id: (s as any).id,
        key: String((s as any).labels?.[PREWARM_KEY_LABEL] || ""),
      });
    }
    return out;
  },
};
