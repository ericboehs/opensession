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
import { getSandboxConnection, sandboxProviderCredential } from "../connections";
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
  resolveTrustPolicy,
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
import {
  invalidateRemoteRepoTemplate,
  readRemoteRepoTemplate,
  REMOTE_REPO_TEMPLATE_TTL_MS,
  sealRemoteRepoTemplate,
  writeRemoteRepoTemplate,
} from "../remote-repo-template";

const SESSION_TAG = "opensession.session";
const DEFAULT_APP = "opensession-sandboxes";
const DEFAULT_IMAGE = "daytonaio/sandbox:0.8.0";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RECREATE_BEFORE_EXPIRY_MS = 60 * 60 * 1000;

function modalConfig(): ReturnType<typeof sandboxConfig> {
  const cfg = sandboxConfig();
  const settings = getSandboxConnection("modal")?.settings || {};
  return {
    ...cfg,
    cpus: settings.cpu,
    memory: settings.memoryMb ? `${settings.memoryMb}m` : undefined,
    modal: {
      profile: settings.profile,
      app: settings.app,
      image: settings.image,
      environment: settings.environment,
      endpoint: settings.endpoint,
      region: settings.region,
      cloud: settings.cloud,
      publicPreviews: settings.publicPreviews,
    },
  };
}

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
  const cfg = modalConfig().modal || {};
  const workspaceCredential = sandboxProviderCredential("modal") as
    | { tokenId: string; tokenSecret: string }
    | undefined;
  if (!workspaceCredential) throw new Error("Modal workspace credentials are not configured");
  const { tokenId, tokenSecret } = workspaceCredential;
  const key = JSON.stringify([tokenId, tokenSecret, cfg.profile, cfg.environment, cfg.endpoint]);
  const cached = (globalThis as any).__opensessionModalClient as
    | { key: string; client: ModalClient }
    | undefined;
  if (cached?.key === key) return cached.client;
  const { ModalClient } = await import("modal");
  const client = new ModalClient({
    tokenId,
    tokenSecret,
    environment: cfg.environment,
    endpoint: cfg.endpoint,
  });
  (globalThis as any).__opensessionModalClient = { key, client };
  return client;
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
    const cfg = modalConfig();
    const client = await modalClient();
    const app = await client.apps.fromName(cfg.modal?.app || DEFAULT_APP, {
      createIfMissing: true,
    });
    let prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
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
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        try {
          const candidate = await client.sandboxes.fromId(claim.sandboxId);
          if ((await candidate.poll()) === null) {
            await candidate.setTags({
              [SESSION_TAG]: spec.sessionId,
              "opensession.sandbox": "1",
            });
            sandbox = candidate;
            console.log(
              `[sandbox:modal] adopted prewarmed sandbox ${candidate.sandboxId} for ${spec.sessionId}`,
            );
          } else {
            discardClaimedPrewarm(this.id, claim.sandboxId);
          }
        } catch (error) {
          console.warn("[sandbox:modal] prewarm adoption failed (cold-creating):", error);
          discardClaimedPrewarm(this.id, claim.sandboxId);
          sandbox = null;
        }
      }
    }
    if (!sandbox) {
      if (prevState) {
        removeRemoteState(this.id, prevState.sandboxId);
        prevState = null;
      }
      console.log(`[sandbox:modal] creating sandbox for ${spec.sessionId}`);
      const template = readRemoteRepoTemplate("modal", repo.id);
      const create = async (imageId?: string) => {
        const image = imageId
          ? await client.images.fromId(imageId)
          : client.images.fromRegistry(cfg.modal?.image || DEFAULT_IMAGE);
        return client.sandboxes.create(app, image, {
          tags: { [SESSION_TAG]: spec.sessionId, "opensession.sandbox": "1" },
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
      };
      try {
        sandbox = await create(template?.artifactId);
      } catch (error) {
        if (!template) throw error;
        invalidateRemoteRepoTemplate("modal", repo.id);
        console.warn(
          `[sandbox:modal] repo template ${template.artifactId} is unavailable; retrying cold`,
        );
        sandbox = await create();
      }
      created = true;
    }

    const driver = modalDriver(sandbox);
    try {
      await driver.ensureStarted();
      await assertDialbackReachable(driver, "modal");
      await bootstrapRemoteSandbox(driver, "modal");
      await setupRemoteWorkspace(
        driver,
        cwd,
        await remoteCloneUrl(repo),
        branch,
        repo.defaultBranch,
        repo.id,
        { sandboxId: sandbox.sandboxId, provider: this.id, sessionId: spec.sessionId, repoId: repo.id, trustProfile: trust.trustProfile },
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
      ...trust,
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
        const cfg = modalConfig();
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

// ── Warm-on-typing + post-setup filesystem templates ────────────────────────

export const modalPrewarmAdapter: PrewarmAdapter = {
  async create(labels, opts) {
    const cfg = modalConfig();
    const key = labels[PREWARM_KEY_LABEL] || "";
    const repoId = key.startsWith("modal:") ? key.slice("modal:".length) : "";
    if (!repoId) throw new Error(`invalid Modal prewarm key: ${key || "(missing)"}`);
    const client = await modalClient();
    const app = await client.apps.fromName(cfg.modal?.app || DEFAULT_APP, {
      createIfMissing: true,
    });
    const template = readRemoteRepoTemplate("modal", repoId);
    const create = async (imageId?: string) => {
      const image = imageId
        ? await client.images.fromId(imageId)
        : client.images.fromRegistry(cfg.modal?.image || DEFAULT_IMAGE);
      return client.sandboxes.create(app, image, {
        tags: labels,
        timeoutMs: MAX_LIFETIME_MS,
        // The Open Session prewarm sweep owns the short TTL. Keep Modal's
        // idle timeout session-sized so an adopted sandbox does not die five
        // minutes later with no API to extend that create-time setting.
        idleTimeoutMs:
          (cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000,
        cpu: opts.resources?.cpu || cfg.cpus,
        cpuLimit: opts.resources?.cpu || cfg.cpus,
        memoryMiB: opts.resources?.memoryMb || memoryMiB(cfg.memory),
        memoryLimitMiB: opts.resources?.memoryMb || memoryMiB(cfg.memory),
        regions: cfg.modal?.region ? [cfg.modal.region] : undefined,
        cloud: cfg.modal?.cloud,
        encryptedPorts: cfg.modal?.publicPreviews ? cfg.previewPorts : undefined,
      });
    };
    let sandbox: ModalSandbox;
    let restoredFromTemplate = Boolean(template);
    try {
      sandbox = await create(template?.artifactId);
    } catch (error) {
      if (!template) throw error;
      invalidateRemoteRepoTemplate("modal", repoId);
      restoredFromTemplate = false;
      sandbox = await create();
    }
    return {
      sandboxId: sandbox.sandboxId,
      driver: modalDriver(sandbox),
      restoredFromTemplate,
    };
  },

  async publishTemplate(sandboxId, repo) {
    const client = await modalClient();
    const sandbox = await client.sandboxes.fromId(sandboxId);
    await sealRemoteRepoTemplate(modalDriver(sandbox), "modal", repo);
    const image = await sandbox.snapshotFilesystem({
      timeoutMs: 10 * 60_000,
      ttlMs: REMOTE_REPO_TEMPLATE_TTL_MS,
    });
    const { previous } = writeRemoteRepoTemplate("modal", repo.id, image.imageId);
    if (previous?.artifactId && previous.artifactId !== image.imageId) {
      await client.images.delete(previous.artifactId).catch(() => {});
    }
    console.log(
      `[sandbox:modal] published post-setup repo template ${image.imageId} for ${repo.id}`,
    );
  },

  async destroy(sandboxId) {
    try {
      const client = await modalClient();
      const sandbox = await client.sandboxes.fromId(sandboxId);
      await sandbox.terminate();
    } catch (error) {
      if ((error as { name?: string })?.name !== "NotFoundError") {
        console.warn(`[sandbox:modal] prewarm destroy(${sandboxId}):`, error);
      }
    }
  },

  async listPrewarmed() {
    const cfg = modalConfig();
    const client = await modalClient();
    const app = await client.apps.fromName(cfg.modal?.app || DEFAULT_APP, {
      createIfMissing: true,
    });
    const out: Array<{ id: string; key: string }> = [];
    for await (const sandbox of client.sandboxes.list({
      appId: app.appId,
      tags: { [PREWARM_LABEL]: "1" },
    })) {
      if ((await sandbox.poll()) !== null) continue;
      const tags: Record<string, string> = await sandbox
        .getTags()
        .catch(() => ({} as Record<string, string>));
      out.push({
        id: sandbox.sandboxId,
        key: String(tags[PREWARM_KEY_LABEL] || ""),
      });
    }
    return out;
  },
};

/** Bounded account + native filesystem-image qualification used by Settings. */
export async function qualifyModalConnection(): Promise<void> {
  const cfg = modalConfig();
  const client = await modalClient();
  const suffix = crypto.randomUUID().slice(0, 12);
  const app = await client.apps.fromName(cfg.modal?.app || DEFAULT_APP, {
    createIfMissing: true,
  });
  let source: ModalSandbox | undefined;
  let restored: ModalSandbox | undefined;
  let imageId: string | undefined;
  try {
    const baseImage = client.images.fromRegistry(cfg.modal?.image || DEFAULT_IMAGE);
    source = await client.sandboxes.create(app, baseImage, {
      tags: { "opensession.qualification": suffix },
      timeoutMs: 30 * 60_000,
      idleTimeoutMs: 10 * 60_000,
      cpu: cfg.cpus,
      cpuLimit: cfg.cpus,
      memoryMiB: memoryMiB(cfg.memory),
      memoryLimitMiB: memoryMiB(cfg.memory),
      regions: cfg.modal?.region ? [cfg.modal.region] : undefined,
      cloud: cfg.modal?.cloud,
      encryptedPorts: [8765],
    });
    const probe = await modalDriver(source).exec(
      "set -eu; uname -s; printf opensession-qualified > /tmp/opensession-qualification",
      { timeoutMs: 60_000 },
    );
    if (probe.exitCode !== 0) throw new Error("Modal qualification command failed");
    const semantics = await modalDriver(source).exec(
      "printf qualification-out; printf qualification-err >&2; exit 7",
      { timeoutMs: 60_000 },
    );
    if (
      semantics.exitCode !== 7 ||
      !semantics.stdout.includes("qualification-out") ||
      !semantics.stderr.includes("qualification-err")
    ) {
      throw new Error("Modal exec stream or exit-code semantics are incompatible");
    }
    await modalDriver(source).writeFile("/tmp/opensession-upload", "uploaded");
    const upload = await modalDriver(source).exec(
      "test \"$(cat /tmp/opensession-upload)\" = uploaded",
    );
    if (upload.exitCode !== 0) throw new Error("Modal file upload check failed");
    const tunnels = await source.tunnels(60_000);
    if (!tunnels[8765]?.url.startsWith("https://")) {
      throw new Error("Modal encrypted tunnel discovery failed");
    }
    const image = await source.snapshotFilesystem({
      timeoutMs: 10 * 60_000,
      ttlMs: 60 * 60_000,
    });
    imageId = image.imageId;
    restored = await client.sandboxes.create(app, await client.images.fromId(imageId), {
      tags: { "opensession.qualification": `${suffix}-restore` },
      timeoutMs: 30 * 60_000,
      idleTimeoutMs: 10 * 60_000,
    });
    if (restored.sandboxId === source.sandboxId) {
      throw new Error("Modal filesystem restore was not distinct");
    }
    const restoreProbe = await modalDriver(restored).exec(
      "test \"$(cat /tmp/opensession-qualification)\" = opensession-qualified",
      { timeoutMs: 60_000 },
    );
    if (restoreProbe.exitCode !== 0) {
      throw new Error("Modal qualification image did not restore filesystem state");
    }
  } finally {
    await restored?.terminate().catch(() => {});
    await source?.terminate().catch(() => {});
    if (imageId) await client.images.delete(imageId).catch(() => {});
  }
  for await (const sandbox of client.sandboxes.list({
    appId: app.appId,
    tags: { "opensession.qualification": suffix },
  })) {
    if ((await sandbox.poll()) === null) {
      throw new Error("Modal qualification cleanup left a sandbox behind");
    }
  }
}

export async function deleteModalTemplateArtifact(artifactId: string): Promise<void> {
  const client = await modalClient();
  await client.images.delete(artifactId).catch(() => {});
}
