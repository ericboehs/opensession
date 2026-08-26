import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const scratch = mkdtempSync(join(tmpdir(), "opensession-github-webhook-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;

const {
  githubDeliveriesStore,
  loadGithubDeliveries,
  isGithubDeliveryProcessed,
  markGithubDeliveryProcessed,
} = await import("./webhook-deliveries");
const { writeJsonAtomic } = await import("../../server/shared/atomic-write");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("GitHub delivery replay protection", () => {
  test("hydrates a persisted delivery before explicit startup", () => {
    const deliveryId = "github-delivery-before-startup";
    writeJsonAtomic(
      githubDeliveriesStore(),
      [[deliveryId, Date.now() + 60_000]],
      false,
    );

    // The check itself performs the one-time synchronous hydration.
    expect(isGithubDeliveryProcessed(deliveryId)).toBe(true);
  });

  test("persists delivery ids at the legacy Slack-store path and restores them after a reload", () => {
    const deliveryId = "github-delivery-persists";
    markGithubDeliveryProcessed(deliveryId);
    expect(githubDeliveriesStore()).toBe(`${scratch}/.slack-sessions/github-deliveries.json`);
    expect(isGithubDeliveryProcessed(deliveryId)).toBe(true);

    // A forced load clears the in-memory map first, mirroring a restart.
    loadGithubDeliveries(true);
    expect(isGithubDeliveryProcessed(deliveryId)).toBe(true);
  });

  test("drops expired delivery ids when restoring the persistent store", () => {
    writeJsonAtomic(githubDeliveriesStore(), [["expired-delivery", 0]], false);
    loadGithubDeliveries(true);
    expect(isGithubDeliveryProcessed("expired-delivery")).toBe(false);
  });
});
