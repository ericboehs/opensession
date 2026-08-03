/**
 * Local Firecracker MicroVM sandbox provider.
 *
 * This reuses the proven preview-pool clone/network/control machinery but
 * requires a separate credential-free, control-only golden. Each session gets
 * a COW ext4 disk and restored VM in a transient systemd scope. The guest is a
 * volume-style workspace: model/provider auth stays on the host and only the
 * explicit opensession-workspace methods cross the control API.
 */

import { homeDir } from "../../paths";
import { getRepo } from "../../worktree";
import { sandboxConfig, sandboxProviderConfigured } from "../config";
import type {
  PortMap,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import {
  bootstrapRemoteWorkspaceRuntime,
  findRemoteStateBySession,
  listRemoteStates,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  removeRemoteState,
  setupRemoteWorkspace,
  touchRemoteState,
  warmRemoteWorkspace,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";
import {
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  type PrewarmAdapter,
} from "../prewarm";

const SCRIPTS = `${process.cwd()}/deploy/sandbox/microvm`;
const CONTROL_PORT = 8080;
const ROOT_CONTROL_PORT = 8081;

function config() {
  const cfg = sandboxConfig().firecrackerMicrovm;
  if (!cfg?.enabled || !sandboxProviderConfigured("microvm")) {
    throw new Error(
      "microvm sandbox provider is not configured — build a clean golden with " +
        "deploy/sandbox/microvm/refresh-sandbox-golden.sh and enable firecrackerMicrovm in ~/.opensession-sandbox.json",
    );
  }
  return cfg;
}

function sandboxId(idx: number): string {
  return `microvm-${idx}`;
}

function indexFromId(id: string): number | null {
  const match = /^microvm-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

function ipFor(idx: number): string {
  return `10.200.${idx}.2`;
}

function workspacePath(sessionId: string): string {
  const safe = sessionId
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "");
  return `${homeDir()}/microvm-workspaces/${safe}`;
}

async function run(
  argv: string[],
  timeoutMs = 180_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

async function unitRunning(idx: number): Promise<boolean> {
  return (
    await run(
      ["systemctl", "is-active", "--quiet", `bks-fc-clone${idx}`],
      5_000,
    )
  ).exitCode === 0;
}

async function request(
  idx: number,
  path: string,
  body?: unknown,
  root = false,
  timeoutMs = 125_000,
): Promise<Response> {
  const response = await fetch(
    `http://${ipFor(idx)}:${root ? ROOT_CONTROL_PORT : CONTROL_PORT}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Firecracker MicroVM ${idx} ${path} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response;
}

function driverFor(idx: number): RemoteDriver {
  return {
    async exec(command: string, opts?: RemoteExecOpts) {
      try {
        const response = await request(
          idx,
          "/exec",
          {
            command,
            cwd: opts?.cwd,
            env: opts?.env,
            timeoutMs: opts?.timeoutMs ?? 120_000,
          },
          false,
          (opts?.timeoutMs ?? 120_000) + 5_000,
        );
        const result = (await response.json()) as {
          exitCode?: number;
          stdout?: string;
          stderr?: string;
        };
        return {
          exitCode: Number(result.exitCode ?? 1),
          stdout: result.stdout || "",
          stderr: result.stderr || "",
        };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: String((error as Error)?.message || error),
        };
      }
    },
    async execBackground(command: string, opts?: RemoteExecOpts) {
      await request(idx, "/background", {
        command,
        cwd: opts?.cwd,
        env: opts?.env,
      });
    },
    async writeFile(path: string, content: string) {
      await request(idx, "/files", {
        path,
        content: Buffer.from(content, "utf-8").toString("base64"),
      });
    },
    async ensureStarted() {
      if (!(await unitRunning(idx))) {
        throw new Error(`Firecracker MicroVM ${idx} is not running`);
      }
      await request(idx, "/health", undefined, false, 5_000);
    },
  };
}

const TRANSIENT_CONTROL_ERROR =
  /socket connection was closed|connection reset|econnreset|fetch\(\) failed|fetch failed/i;

/**
 * A restored Firecracker guest can drop its first control connection while
 * the snapshot-frozen network stack settles after the clock repair. Bootstrap
 * commands are deliberately idempotent, so retry only this provisioning
 * driver—not the Sandbox handle used for arbitrary agent execute calls.
 */
export function microvmBootstrapDriver(driver: RemoteDriver): RemoteDriver {
  return {
    ...driver,
    async exec(command: string, opts?: RemoteExecOpts) {
      let result = await driver.exec(command, opts);
      for (let attempt = 1; attempt < 3; attempt++) {
        const detail = `${result.stderr}\n${result.stdout}`;
        if (result.exitCode === 0 || !TRANSIENT_CONTROL_ERROR.test(detail)) {
          return result;
        }
        await Bun.sleep(attempt * 250);
        await driver.ensureStarted().catch(() => {});
        result = await driver.exec(command, opts);
      }
      return result;
    },
  };
}

async function destroyClone(idx: number, storeDir: string): Promise<void> {
  const result = await run(
    ["sudo", "-n", "bash", `${SCRIPTS}/clone.sh`, "destroy", String(idx), storeDir],
    60_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `destroying Firecracker MicroVM ${idx} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    );
  }
}

async function allocateClone(
  storeDir: string,
  indexStart: number,
  indexEnd: number,
): Promise<number> {
  return withRemoteEnsureLock("microvm", "__allocate__", async () => {
    for (let candidate = indexStart; candidate <= indexEnd; candidate++) {
      const result = await run(
        [
          "sudo",
          "-n",
          "bash",
          `${SCRIPTS}/clone.sh`,
          "create",
          String(candidate),
          storeDir,
        ],
        300_000,
      );
      if (result.exitCode === 0) return candidate;
      if (
        result.exitCode === 3 ||
        /already has a live VM/i.test(result.stderr + result.stdout)
      ) {
        continue;
      }
      throw new Error(
        `creating Firecracker MicroVM ${candidate} failed: ${(result.stderr || result.stdout).trim().slice(-1000)}`,
      );
    }
    throw new Error(
      `no free Firecracker MicroVM clone index in ${indexStart}..${indexEnd}`,
    );
  });
}

export class MicrovmProvider implements SandboxProvider {
  readonly id = "microvm" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    if (spec.runtime !== "workspace") {
      throw new Error(
        "local Firecracker MicroVM currently supports host-engine/workspace mode only; choose an OpenCode provider whose auth stays on Host",
      );
    }
    if (spec.attachedDirs?.length) {
      throw new Error(
        "attached repos are not supported in MicroVM sandboxes — detach them or use docker/local",
      );
    }
    const cfg = config();
    let previous = findRemoteStateBySession(this.id, spec.sessionId);
    const repo = getRepo(spec.repo || previous?.repoId);
    const branch = spec.branch || previous?.branch || repo.defaultBranch;
    // Keep workspaces in a guest-only namespace. The minimal golden deliberately
    // has no runner checkout, and the Sandbox handle reports this real cwd to
    // the host-side engine.
    const cwd = previous?.cwd || workspacePath(spec.sessionId);

    let idx = previous ? indexFromId(previous.sandboxId) : null;
    if (idx != null) {
      try {
        await driverFor(idx).ensureStarted();
      } catch {
        await destroyClone(idx, cfg.storeDir).catch(() => {});
        removeRemoteState(this.id, previous!.sandboxId);
        previous = null;
        idx = null;
      }
    }

    let created = false;
    if (idx == null) {
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        const candidate = indexFromId(claim.sandboxId);
        if (candidate != null) {
          try {
            await driverFor(candidate).ensureStarted();
            idx = candidate;
            created = true;
            console.log(
              `[sandbox:microvm] adopted prewarmed clone ${claim.sandboxId} for ${spec.sessionId}`,
            );
          } catch (error) {
            console.warn(
              `[sandbox:microvm] prewarm adoption failed (cold-creating):`,
              error,
            );
            discardClaimedPrewarm(this.id, claim.sandboxId);
          }
        } else {
          discardClaimedPrewarm(this.id, claim.sandboxId);
        }
      }
    }
    if (idx == null) {
      idx = await allocateClone(cfg.storeDir, cfg.indexStart, cfg.indexEnd);
      created = true;
    }
    if (created) {
      writeRemoteState({
        sandboxId: sandboxId(idx),
        provider: this.id,
        sessionId: spec.sessionId,
        cwd,
        repoId: repo.id,
        branch,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      });
    }

    const driver = driverFor(idx);
    try {
      await driver.ensureStarted();
      // clone.sh repairs the snapshot-frozen clock through the root control
      // port before it returns. Doing it again here can sever an in-flight
      // keep-alive socket when the guest clock jumps.
      await bootstrapRemoteWorkspaceRuntime(
        microvmBootstrapDriver(driver),
        "microvm",
      );
      await setupRemoteWorkspace(
        driver,
        cwd,
        await remoteCloneUrl(repo),
        branch,
        repo.defaultBranch,
        repo.id,
      );
    } catch (error) {
      if (created) {
        await destroyClone(idx, cfg.storeDir).catch(() => {});
        removeRemoteState(this.id, sandboxId(idx));
      }
      throw error;
    }
    writeRemoteState({
      sandboxId: sandboxId(idx),
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: previous?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    return this.makeHandle(idx, spec.sessionId, cwd);
  }

  private makeHandle(idx: number, sessionId: string, cwd: string): Sandbox {
    const id = sandboxId(idx);
    return makeRemoteSandbox({
      providerId: this.id,
      sandboxId: id,
      sessionId,
      cwd,
      driver: driverFor(idx),
      async ports(): Promise<PortMap> {
        // The guest subnet is host-private. Add a Caddy proxy before exposing
        // browser preview URLs; structured workspace execution needs no port.
        return {};
      },
      async status(): Promise<SandboxStatus> {
        if (!(await unitRunning(idx))) return "gone";
        try {
          await request(idx, "/health", undefined, false, 3_000);
          return "running";
        } catch {
          return "stopped";
        }
      },
      touchActivity: () => touchRemoteState(this.id, id),
    });
  }

  async get(id: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, id);
    const idx = indexFromId(id);
    if (!state || idx == null || !(await unitRunning(idx))) return null;
    try {
      await driverFor(idx).ensureStarted();
      return this.makeHandle(idx, state.sessionId, state.cwd);
    } catch {
      return null;
    }
  }

  async destroy(id: string): Promise<void> {
    const idx = indexFromId(id);
    if (idx == null) return;
    const cfg = sandboxConfig().firecrackerMicrovm;
    // Cleanup must remain possible after an operator disables/removes the
    // provider block. Custom-store operators should destroy live sessions
    // before removing their config; the default remains recoverable.
    await destroyClone(idx, cfg?.storeDir || "/opt/firecracker/sandbox-store");
    removeRemoteState(this.id, id);
  }
}

// ── Warm-on-typing workspace prewarm hooks ──────────────────────────────────

export const microvmPrewarmAdapter: PrewarmAdapter = {
  async create(labels) {
    const cfg = config();
    const key = labels["backstage.prewarm.key"];
    if (!key?.startsWith("microvm:")) {
      throw new Error(`invalid MicroVM prewarm key: ${key || "(missing)"}`);
    }
    const repoId = key.slice("microvm:".length);
    const idx = await allocateClone(cfg.storeDir, cfg.indexStart, cfg.indexEnd);
    const id = sandboxId(idx);
    try {
      writeRemoteState({
        sandboxId: id,
        provider: "microvm",
        sessionId: `__prewarm__:${key}`,
        cwd: workspacePath(`prewarm-${idx}`),
        repoId,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      });
      return { sandboxId: id, driver: driverFor(idx) };
    } catch (error) {
      await destroyClone(idx, cfg.storeDir).catch(() => {});
      removeRemoteState("microvm", id);
      throw error;
    }
  },

  async prepare(driver, repo, label) {
    await driver.ensureStarted();
    await bootstrapRemoteWorkspaceRuntime(microvmBootstrapDriver(driver), label);
    if (!(await warmRemoteWorkspace(driver, repo, label, { installDeps: false }))) {
      throw new Error(`MicroVM prewarm could not clone ${repo.id}`);
    }
  },

  async destroy(id) {
    const idx = indexFromId(id);
    if (idx == null) return;
    const cfg = sandboxConfig().firecrackerMicrovm;
    await destroyClone(idx, cfg?.storeDir || "/opt/firecracker/sandbox-store");
    removeRemoteState("microvm", id);
  },

  async listPrewarmed() {
    const out: Array<{ id: string; key: string }> = [];
    for (const state of listRemoteStates("microvm")) {
      if (!state.sessionId.startsWith("__prewarm__:")) continue;
      const idx = indexFromId(state.sandboxId);
      if (idx == null || !(await unitRunning(idx))) continue;
      out.push({
        id: state.sandboxId,
        key: state.sessionId.slice("__prewarm__:".length),
      });
    }
    return out;
  },
};
