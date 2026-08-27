/**
 * Onboard config construction: an org install (`--org`) records the App owner
 * and the intent to turn on per-user sign-in at first connect, and NEVER writes
 * userPrAuth (nobody is signed in at install — flipping the gate here would lock
 * the operator out). A single-user install writes neither GitHub key. Every new
 * install starts with an explicit incomplete web-onboarding flag. buildConfig
 * is the pure config-writing half, tested directly so the
 * assertion doesn't run the installer's service/scratch-repo side effects.
 */

import { describe, expect, test } from "bun:test";
import { buildConfig, type Answers } from "./onboard";

function answers(org?: string): Answers {
  return {
    productName: "Open Session",
    host: "127.0.0.1",
    port: 3850,
    publicBaseUrl: "http://127.0.0.1:3850",
    repoId: "scratch",
    repoPath: "/tmp/scratch",
    repoBranch: "main",
    worktreesDir: "/tmp/worktrees",
    enabled: [],
    ...(org ? { org } : {}),
  };
}

/** integrations.github as a plain object. */
function github(config: Record<string, unknown>): Record<string, unknown> {
  const integrations = config.integrations as Record<string, unknown>;
  return (integrations.github as Record<string, unknown>) ?? {};
}

describe("onboard buildConfig org intent", () => {
  test("marks the web onboarding as incomplete", () => {
    expect(buildConfig(answers()).onboardingCompleted).toBe(false);
  });

  test("--org writes appOrg + authOnConnect, never userPrAuth", () => {
    const gh = github(buildConfig(answers("acme-inc")));
    expect(gh.appOrg).toBe("acme-inc");
    expect(gh.authOnConnect).toBe(true);
    // The gate flip happens only at connect, with a live session — never here.
    expect(gh.userPrAuth).toBeUndefined();
    // The github integration is still written explicitly off (registry default).
    expect(gh.enabled).toBe(false);
  });

  test("no --org writes neither appOrg nor authOnConnect (single-user, unchanged)", () => {
    const gh = github(buildConfig(answers()));
    expect(gh.appOrg).toBeUndefined();
    expect(gh.authOnConnect).toBeUndefined();
    expect(gh.userPrAuth).toBeUndefined();
    expect(gh.enabled).toBe(false);
  });
});
