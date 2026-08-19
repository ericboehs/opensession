/**
 * Durable post-setup repo templates for remote sandbox providers.
 *
 * Daytona stores templates as provider snapshots, Box as named snapshots,
 * and Modal as Image ids returned by Sandbox.snapshotFilesystem(). This file owns only the
 * small local index that maps (provider, repo, runner/create signature) to the
 * provider artifact.  The artifact itself is credential-free and expires
 * after 24 hours; adapters are responsible for publishing/deleting it.
 */

import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "../paths";
import { writeJsonAtomic } from "../shared/atomic-write";
import { sandboxConfig } from "./config";
import {
  bootstrapSignature,
  remoteWarmWorkspaceDir,
  shellQuoteWord,
  type RemoteDriver,
} from "./adapters/bootstrap";
import { getSandboxConnection } from "./connections";

export type RemoteTemplateProvider = "daytona" | "box" | "modal";

export interface RemoteRepoTemplate {
  provider: RemoteTemplateProvider;
  repoId: string;
  artifactId: string;
  signature: string;
  createdAt: string;
  expiresAt: string;
}

export const REMOTE_REPO_TEMPLATE_TTL_MS = 24 * 60 * 60 * 1000;

export function remoteRepoTemplateProofPath(repoId: string): string {
  return `/home/ubuntu/.opensession/repo-template-${clean(repoId)}.json`;
}

/** Fail closed before a provider snapshot is published, then write a nonce
 * into the filesystem. Certification restores a second sandbox and requires
 * the exact nonce, proving it used the artifact rather than merely repeating
 * setup in another cold sandbox. */
export async function sealRemoteRepoTemplate(
  driver: RemoteDriver,
  provider: RemoteTemplateProvider,
  repo: { id: string },
): Promise<string> {
  const warmDir = remoteWarmWorkspaceDir(repo.id);
  const origin = await driver.exec("git remote get-url origin", { cwd: warmDir });
  if (origin.exitCode !== 0 || /https?:\/\/[^/\s]+@/i.test(origin.stdout)) {
    throw new Error(`refusing to snapshot ${repo.id}: clone authority was not scrubbed`);
  }
  const sensitive = await driver.exec(
    "for f in " +
      [
        "/home/ubuntu/.claude/.credentials.json",
        "/home/ubuntu/.codex/auth.json",
        "/home/ubuntu/.config/opencode/auth.json",
        "/home/ubuntu/.opensession-claude-accounts.json",
        "/home/ubuntu/.opensession-opencode.json",
        "/home/ubuntu/.opensession-pi.json",
      ]
        .map(shellQuoteWord)
        .join(" ") +
      '; do [ ! -s "$f" ] || echo "$f"; done',
  );
  if (sensitive.exitCode !== 0 || sensitive.stdout.trim()) {
    throw new Error(
      `refusing to snapshot ${repo.id}: launch credentials are present (${sensitive.stdout.trim()})`,
    );
  }
  const nonce = randomUUID();
  const proof = JSON.stringify({
    provider,
    repoId: repo.id,
    signature: remoteRepoTemplateSignature(provider),
    nonce,
    sealedAt: new Date().toISOString(),
  });
  const path = remoteRepoTemplateProofPath(repo.id);
  const written = await driver.exec(
    `mkdir -p ${shellQuoteWord(path.slice(0, path.lastIndexOf("/")))} && printf %s ${shellQuoteWord(proof)} > ${shellQuoteWord(path)}`,
  );
  if (written.exitCode !== 0) {
    throw new Error(`could not seal ${provider} repo template: ${written.stderr.trim()}`);
  }
  return nonce;
}

export async function validateRemoteRepoTemplate(
  driver: RemoteDriver,
  provider: RemoteTemplateProvider,
  repo: { id: string },
): Promise<string> {
  const proof = await driver.exec(
    `cat ${shellQuoteWord(remoteRepoTemplateProofPath(repo.id))}`,
  );
  if (proof.exitCode !== 0) {
    throw new Error(`restored ${provider} template has no seal for ${repo.id}`);
  }
  let parsed: { provider?: string; repoId?: string; signature?: string; nonce?: string };
  try {
    parsed = JSON.parse(proof.stdout);
  } catch {
    throw new Error(`restored ${provider} template has a malformed seal for ${repo.id}`);
  }
  if (
    parsed.provider !== provider ||
    parsed.repoId !== repo.id ||
    parsed.signature !== remoteRepoTemplateSignature(provider) ||
    !parsed.nonce
  ) {
    throw new Error(`restored ${provider} template seal does not match ${repo.id}`);
  }
  const warm = await driver.exec(
    `test -d ${shellQuoteWord(remoteWarmWorkspaceDir(repo.id))}/.git && git remote get-url origin`,
    { cwd: remoteWarmWorkspaceDir(repo.id) },
  );
  if (warm.exitCode !== 0 || /https?:\/\/[^/\s]+@/i.test(warm.stdout)) {
    throw new Error(`restored ${provider} template is missing or retained clone authority`);
  }
  return parsed.nonce;
}

function clean(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function dir(): string {
  return `${process.env.OPENSESSION_SESSIONS_DIR || OPENSESSION_SESSIONS_DIR}/sandbox-repo-templates`;
}

function file(provider: RemoteTemplateProvider, repoId: string): string {
  return `${dir()}/${provider}-${clean(repoId)}.json`;
}

/** Includes every create-time input whose change makes an artifact unsafe to
 * reuse. The repo contents intentionally age out on the 24-hour TTL; adoption
 * fetches the current default branch before creating the session branch. */
export function remoteRepoTemplateSignature(
  provider: RemoteTemplateProvider,
): string {
  const cfg = sandboxConfig();
  const settings = getSandboxConnection(provider)?.settings || {};
  const shape =
    provider === "daytona"
      ? { baseSnapshot: settings.snapshot || "default" }
      : provider === "box"
        ? { machineProfile: settings.profile || "default" }
      : {
          image: settings.image || "daytonaio/sandbox:0.8.0",
          cpu: settings.cpu || null,
          memory: settings.memoryMb || null,
          region: settings.region || null,
          cloud: settings.cloud || null,
        };
  return createHash("sha256")
    .update(`${bootstrapSignature()}|${JSON.stringify(shape)}`)
    .digest("hex");
}

/** Deterministic, provider-safe name used by Daytona and Box snapshot APIs. */
export function remoteRepoTemplateName(
  provider: RemoteTemplateProvider,
  repoId: string,
): string {
  const suffix = remoteRepoTemplateSignature(provider).slice(0, 16);
  return `opensession-${clean(repoId).slice(0, 36)}-${suffix}`;
}

export function readRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
  now = Date.now(),
): RemoteRepoTemplate | null {
  try {
    const path = file(provider, repoId);
    if (!existsSync(path)) return null;
    const entry = JSON.parse(readFileSync(path, "utf-8")) as RemoteRepoTemplate;
    if (
      entry.provider !== provider ||
      entry.repoId !== repoId ||
      !entry.artifactId ||
      entry.signature !== remoteRepoTemplateSignature(provider) ||
      Date.parse(entry.expiresAt) <= now
    ) {
      try {
        unlinkSync(path);
      } catch {}
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export function writeRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
  artifactId: string,
  now = Date.now(),
): { current: RemoteRepoTemplate; previous: RemoteRepoTemplate | null } {
  const path = file(provider, repoId);
  let previous: RemoteRepoTemplate | null = null;
  try {
    previous = JSON.parse(readFileSync(path, "utf-8")) as RemoteRepoTemplate;
  } catch {}
  const current: RemoteRepoTemplate = {
    provider,
    repoId,
    artifactId,
    signature: remoteRepoTemplateSignature(provider),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + REMOTE_REPO_TEMPLATE_TTL_MS).toISOString(),
  };
  mkdirSync(dir(), { recursive: true });
  writeJsonAtomic(path, current);
  return { current, previous };
}

export function invalidateRemoteRepoTemplate(
  provider: RemoteTemplateProvider,
  repoId: string,
): RemoteRepoTemplate | null {
  const path = file(provider, repoId);
  let previous: RemoteRepoTemplate | null = null;
  try {
    previous = JSON.parse(readFileSync(path, "utf-8")) as RemoteRepoTemplate;
  } catch {}
  try {
    unlinkSync(path);
  } catch {}
  return previous;
}
