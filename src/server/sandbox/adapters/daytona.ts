/**
 * DaytonaProvider — remote sandbox adapter over the Daytona API
 * (docs/sandboxes-plan.md §5 Phase 3).
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

const SESSION_LABEL = "backstage.session";
const DEFAULT_IDLE_STOP_MINUTES = 30;
/** Delimits stdout from stderr inside the merged executeCommand output. */
const ERR_DELIM = "__BKS_STDERR_7f3a__";

async function daytonaClient(): Promise<Daytona> {
  const cfg = sandboxConfig().daytona || {};
  const apiKey = cfg.apiKey || process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'daytona sandbox provider is not configured — set {"daytona":{"apiKey":"…"}} in ~/.backstage-sandbox.json or DAYTONA_API_KEY',
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

/** How long a Shell-tab SSH token lives. Generous (a shell can sit open all
 *  day) but bounded; the token is additionally revoked the moment the shell
 *  closes, so expiry only matters for tokens orphaned by a backstage crash. */
const TERMINAL_SSH_EXPIRY_MINUTES = 12 * 60;

/**
 * Interactive terminal access for a Daytona sandbox (the session viewer's
 * Shell tab — see src/server/terminals.ts): wake the sandbox, mint an SSH
 * gateway token (`createSshAccess`), and return the ssh argv the host PTY
 * spawns plus a revoke() for teardown when the shell closes.
 *
 * Transport: `ssh <token>@ssh.app.daytona.io` (the DTO's own sshCommand),
 * verified reachable from this host 2026-07-08 (bare sandbox, exit 0, user
 * `daytona`). The gateway fronts many sandboxes behind rotating infra, so
 * host keys are not pinned (StrictHostKeyChecking=no) — the per-shell token
 * is the authentication, and everything the browser sees still flows over
 * backstage's tailnet-gated WS, never a public URL.
 */
export async function daytonaTerminalAccess(
  sandboxId: string,
  cwd: string,
): Promise<{ argv: string[]; revoke: () => Promise<void> }> {
  const client = await daytonaClient();
  const sbx = await client.get(sandboxId);
  if (!sbx || stateOf(sbx) === "gone") {
    throw new Error(`daytona sandbox ${sandboxId} is gone`);
  }
  await daytonaDriver(sbx).ensureStarted();
  const access = await (sbx as any).createSshAccess(TERMINAL_SSH_EXPIRY_MINUTES);
  const target = String(access?.sshCommand || "")
    .replace(/^ssh\s+/, "")
    .trim();
  if (!target || !access?.token) {
    throw new Error("daytona createSshAccess returned no usable sshCommand/token");
  }
  return {
    argv: [
      "ssh", "-tt",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ServerAliveInterval=30",
      "-o", "ConnectTimeout=15",
      ...target.split(/\s+/),
      // Land in the workspace when it exists (bare/unbootstrapped sandboxes
      // won't have it yet); always end in a login shell.
      `cd ${shellQuoteWord(cwd)} 2>/dev/null; exec bash -l`,
    ],
    revoke: async () => {
      try {
        await (sbx as any).revokeSshAccess(access.token);
      } catch (e) {
        console.warn(`[sandbox:daytona] revokeSshAccess(${sandboxId}) failed:`, e);
      }
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
    if (!sbx) {
      console.log(`[sandbox:daytona] creating sandbox for ${spec.sessionId}`);
      // Default snapshot (custom `resources` are rejected when creating from a
      // snapshot — live-API behavior 2026-07; size the sandbox via a custom
      // snapshot/image in the daytona config instead when needed).
      sbx = await client.create(
        {
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
    await assertDialbackReachable(driver, "daytona");
    await bootstrapRemoteSandbox(driver, "daytona");
    await setupRemoteWorkspace(
      driver,
      cwd,
      await remoteCloneUrl(repo),
      branch,
      repo.defaultBranch,
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
