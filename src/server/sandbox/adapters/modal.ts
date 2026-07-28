/**
 * ModalProvider — remote sandbox adapter over Modal's TypeScript SDK.
 *
 * Modal sandboxes are ephemeral containers with a maximum 24-hour lifetime.
 * The workspace is cloned inside the sandbox and is lost when its idle timeout
 * or lifetime expires, so code-mode sessions must push their work. The shared
 * remote bootstrap provides the runner payload and WS dial-back transport.
 */

import type { ModalClient, Sandbox as ModalSandbox } from "modal";
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

const SESSION_TAG = "backstage.session";
const DEFAULT_APP = "opensession-sandboxes";
const DEFAULT_IMAGE = "daytonaio/sandbox:0.8.0";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RECREATE_BEFORE_EXPIRY_MS = 60 * 60 * 1000;

function memoryMiB(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([kmg])b?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "k") return Math.max(1, Math.ceil(amount / 1024));
  if (unit === "g") return Math.ceil(amount * 1024);
  return Math.ceil(amount);
}

async function modalClient(): Promise<ModalClient> {
  const cfg = sandboxConfig().modal || {};
  const tokenId = cfg.tokenId || process.env.MODAL_TOKEN_ID;
  const tokenSecret = cfg.tokenSecret || process.env.MODAL_TOKEN_SECRET;
  const key = JSON.stringify([tokenId, tokenSecret, cfg.profile, cfg.environment, cfg.endpoint]);
  const cached = (globalThis as any).__opensessionModalClient as
    | { key: string; client: ModalClient }
    | undefined;
  if (cached?.key === key) return cached.client;
  const previousProfile = process.env.MODAL_PROFILE;
  if (cfg.profile) process.env.MODAL_PROFILE = cfg.profile;
  try {
    const { ModalClient } = await import("modal");
    const client = new ModalClient({
      tokenId,
      tokenSecret,
      environment: cfg.environment,
      endpoint: cfg.endpoint,
    });
    (globalThis as any).__opensessionModalClient = { key, client };
    return client;
  } finally {
    if (cfg.profile) {
      if (previousProfile === undefined) delete process.env.MODAL_PROFILE;
      else process.env.MODAL_PROFILE = previousProfile;
    }
  }
}

function modalDriver(sandbox: ModalSandbox): RemoteDriver {
  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      try {
        const process = await sandbox.exec(["sh", "-lc", cmd], {
          workdir: opts?.cwd,
          env: opts?.env,
          timeoutMs: opts?.timeoutMs ?? 120_000,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          process.stdout.readText(),
          process.stderr.readText(),
          process.wait(),
        ]);
        return { exitCode, stdout, stderr };
      } catch (e: any) {
        return { exitCode: 1, stdout: "", stderr: String(e?.message || e) };
      }
    },

    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      await sandbox.exec(["sh", "-lc", cmd], {
        workdir: opts?.cwd,
        env: opts?.env,
      });
    },

    async writeFile(path: string, content: string) {
      // modal@0.9's filesystem.writeText uses ReadableStream.from, which Bun
      // does not implement. Stream through the process stdin instead.
      const process = await sandbox.exec([
        "sh",
        "-lc",
        `mkdir -p $(dirname ${shellQuoteWord(path)}) && cat > ${shellQuoteWord(path)}`,
      ]);
      await process.stdin.writeText(content);
      await process.stdin.close();
      const exitCode = await process.wait();
      if (exitCode !== 0) {
        throw new Error(
          `modal writeFile(${path}) failed: ${(await process.stderr.readText()).slice(0, 300)}`,
        );
      }
    },

    async ensureStarted() {
      if ((await sandbox.poll()) !== null) {
        throw new Error(`modal sandbox ${sandbox.sandboxId} is no longer running`);
      }
    },
  };
}

export class ModalProvider implements SandboxProvider {
  readonly id = "modal" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () => this.ensureInner(spec));
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    if (spec.attachedDirs?.length) {
      throw new Error("attached repos are not supported in remote sandboxes — detach them or use docker/local");
    }
    const cfg = sandboxConfig();
    const client = await modalClient();
    const app = await client.apps.fromName(cfg.modal?.app || DEFAULT_APP, {
      createIfMissing: true,
    });
    let prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cwd =
      spec.cwd || prevState?.cwd || worktreePathFor(branch, repo.id, { isolated: true });

    let sandbox: ModalSandbox | null = null;
    let created = false;
    try {
      for await (const candidate of client.sandboxes.list({
        appId: app.appId,
        tags: { [SESSION_TAG]: spec.sessionId },
      })) {
        sandbox = candidate;
        break;
      }
    } catch (e) {
      console.warn("[sandbox:modal] tag lookup failed (will use local state/create):", e);
    }
    if (!sandbox && prevState) {
      try {
        const candidate = await client.sandboxes.fromId(prevState.sandboxId);
        if ((await candidate.poll()) === null) sandbox = candidate;
      } catch {}
    }
    if (sandbox && prevState && sandbox.sandboxId !== prevState.sandboxId) {
      removeRemoteState(this.id, prevState.sandboxId);
      prevState = null;
    }
    // Modal's absolute timeout is not extended by activity. Leave a one-hour
    // margin so a newly-started turn cannot be killed by the 24-hour deadline.
    if (
      sandbox &&
      prevState &&
      Date.now() - Date.parse(prevState.createdAt) >=
        MAX_LIFETIME_MS - RECREATE_BEFORE_EXPIRY_MS
    ) {
      const pending = await modalDriver(sandbox).exec(
        `cd ${shellQuoteWord(cwd)} && ` +
          `git rev-parse --verify '@{upstream}' >/dev/null 2>&1 && ` +
          `test -z "$(git status --porcelain)" && ` +
          `test -z "$(git log --format=%H '@{upstream}..HEAD')"`,
      );
      if (pending.exitCode !== 0) {
        throw new Error(
          "Modal sandbox is nearing its hard lifetime without a clean, fully pushed upstream branch; commit and push before it can rotate",
        );
      }
      await sandbox.terminate();
      removeRemoteState(this.id, sandbox.sandboxId);
      prevState = null;
      sandbox = null;
    }
    if (!sandbox) {
      if (prevState) {
        removeRemoteState(this.id, prevState.sandboxId);
        prevState = null;
      }
      console.log(`[sandbox:modal] creating sandbox for ${spec.sessionId}`);
      const image = client.images.fromRegistry(cfg.modal?.image || DEFAULT_IMAGE);
      sandbox = await client.sandboxes.create(app, image, {
        tags: { [SESSION_TAG]: spec.sessionId, "backstage.sandbox": "1" },
        timeoutMs: MAX_LIFETIME_MS,
        idleTimeoutMs:
          (cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000,
        cpu: cfg.cpus,
        cpuLimit: cfg.cpus,
        memoryMiB: memoryMiB(cfg.memory),
        memoryLimitMiB: memoryMiB(cfg.memory),
        regions: cfg.modal?.region ? [cfg.modal.region] : undefined,
        cloud: cfg.modal?.cloud,
        encryptedPorts: cfg.modal?.publicPreviews ? cfg.previewPorts : undefined,
      });
      created = true;
    }

    const driver = modalDriver(sandbox);
    try {
      await driver.ensureStarted();
      if (spec.runtime === "workspace") {
        await bootstrapRemoteWorkspaceRuntime(driver, "modal");
      } else {
        await assertDialbackReachable(driver, "modal");
        await bootstrapRemoteSandbox(driver, "modal");
      }
      await setupRemoteWorkspace(
        driver,
        cwd,
        await remoteCloneUrl(repo),
        branch,
        repo.defaultBranch,
        repo.id,
      );
    } catch (e) {
      // A failed first bootstrap is not useful and otherwise remains paid
      // compute for up to 24 hours without a session-side sandbox id.
      if (created) await sandbox.terminate().catch(() => {});
      throw e;
    }
    const createdAt = created ? new Date().toISOString() : prevState?.createdAt;
    writeRemoteState({
      sandboxId: sandbox.sandboxId,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    return this.makeHandle(sandbox, spec.sessionId, cwd);
  }

  private makeHandle(sandbox: ModalSandbox, sessionId: string, cwd: string): Sandbox {
    const providerId = this.id;
    return makeRemoteSandbox({
      providerId,
      sandboxId: sandbox.sandboxId,
      sessionId,
      cwd,
      driver: modalDriver(sandbox),
      async ports(): Promise<PortMap> {
        const map: PortMap = {};
        const cfg = sandboxConfig();
        if (!cfg.modal?.publicPreviews || !cfg.previewPorts?.length) return map;
        try {
          const tunnels = await sandbox.tunnels();
          for (const port of cfg.previewPorts) {
            const tunnel = tunnels[port];
            if (tunnel?.url) map[port] = { url: tunnel.url };
          }
        } catch (e) {
          console.warn("[sandbox:modal] tunnel lookup failed:", e);
        }
        return map;
      },
      async status(): Promise<SandboxStatus> {
        try {
          return (await sandbox.poll()) === null ? "running" : "gone";
        } catch {
          return "gone";
        }
      },
      touchActivity: () => touchRemoteState(providerId, sandbox.sandboxId),
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const client = await modalClient();
      const sandbox = await client.sandboxes.fromId(sandboxId);
      if ((await sandbox.poll()) !== null) return null;
      return this.makeHandle(sandbox, state.sessionId, state.cwd);
    } catch (e) {
      console.warn(`[sandbox:modal] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    try {
      const client = await modalClient();
      const sandbox = await client.sandboxes.fromId(sandboxId);
      await sandbox.terminate();
    } catch (e) {
      console.warn(`[sandbox:modal] destroy(${sandboxId}):`, e);
      if ((e as { name?: string })?.name !== "NotFoundError") throw e;
    }
    removeRemoteState(this.id, sandboxId);
  }
}
