/**
 * Replay protection for GitHub webhook deliveries.
 *
 * Keep the historical Slack-store path so upgrading a GitHub-only deployment
 * retains delivery IDs that were accepted before webhook ownership moved here.
 */
import { existsSync, readFileSync } from "fs";
import { statePath } from "../../server/paths";
import { writeJsonAtomic } from "../../server/shared/atomic-write";

export function githubDeliveriesStore(): string {
  return statePath(".slack-sessions/github-deliveries.json");
}
const GITHUB_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GITHUB_DELIVERIES = 500;
const githubDeliveryExpiry: Map<string, number> = ((globalThis as any).__githubDeliveryExpiry ??=
  new Map<string, number>());
let githubDeliveriesLoaded = false;

function pruneGithubDeliveries(now = Date.now()): void {
  for (const [id, expiresAt] of githubDeliveryExpiry) {
    if (expiresAt <= now) githubDeliveryExpiry.delete(id);
  }
  // Map iteration is insertion ordered, so evict the oldest delivery first.
  while (githubDeliveryExpiry.size > MAX_GITHUB_DELIVERIES) {
    const oldest = githubDeliveryExpiry.keys().next().value;
    if (oldest === undefined) break;
    githubDeliveryExpiry.delete(oldest);
  }
}

function persistGithubDeliveries(): void {
  try {
    writeJsonAtomic(githubDeliveriesStore(), [...githubDeliveryExpiry], false);
  } catch (e) {
    console.error("[github] Failed to persist webhook deliveries:", e);
  }
}

/**
 * Restore replay protection once per module lifetime. Checks and writes call
 * this lazily so a webhook accepted before agent startup cannot bypass replay
 * protection. A hot reload safely rehydrates from the atomically persisted file.
 */
export function loadGithubDeliveries(force = false): void {
  if (githubDeliveriesLoaded && !force) return;
  githubDeliveriesLoaded = true;
  githubDeliveryExpiry.clear();
  try {
    const store = githubDeliveriesStore();
    if (existsSync(store)) {
      const entries = JSON.parse(readFileSync(store, "utf-8")) as [string, number][];
      const now = Date.now();
      for (const [id, expiresAt] of entries) {
        if (typeof id === "string" && Number.isFinite(expiresAt) && expiresAt > now) {
          githubDeliveryExpiry.set(id, expiresAt);
        }
      }
      pruneGithubDeliveries(now);
      persistGithubDeliveries();
    }
  } catch (e) {
    console.error("[github] Failed to load webhook deliveries:", e);
  }
}

/** True if this signed GitHub delivery was already accepted within its TTL. */
export function isGithubDeliveryProcessed(id: string): boolean {
  loadGithubDeliveries();
  const expiresAt = githubDeliveryExpiry.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    githubDeliveryExpiry.delete(id);
    persistGithubDeliveries();
    return false;
  }
  return true;
}

/** Record a signed GitHub delivery before dispatching its side effects. */
export function markGithubDeliveryProcessed(id: string): void {
  loadGithubDeliveries();
  githubDeliveryExpiry.set(id, Date.now() + GITHUB_DELIVERY_TTL_MS);
  pruneGithubDeliveries();
  persistGithubDeliveries();
}

let githubWebhooksReceived = 0;

export function incrementGithubWebhooks(): void {
  githubWebhooksReceived++;
}

export function githubWebhookCount(): number {
  return githubWebhooksReceived;
}
