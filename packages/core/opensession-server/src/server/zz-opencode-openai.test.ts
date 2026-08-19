/**
 * Unit tests for opencode/openai subscription-auth binding
 * (opencode-openai-auth.ts). Focus: the fail-fast paths (no usable auth never
 * hangs) and the rotation-hazard resolution (opencode is seeded access-only,
 * NEVER the source refresh token). Pure functions over synthetic accounts +
 * temp dirs — no real codex store, no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bindOpenaiAccount,
  openaiPromptVariant,
  supportsOpenaiFastMode,
  OPENCODE_OPENAI_PLACEHOLDER_REFRESH,
  type OpenaiAccountBinding,
} from "./opencode-openai-auth";
import type { CodexAccount } from "./codex-accounts";

/** Fabricate a JWT whose payload carries the given `exp` (seconds). */
function fakeJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ exp: expSeconds, sub: "user-x" })}.sig`;
}

function homeAccount(dir: string): CodexAccount {
  return { id: "acc-home-123456", name: "test-home", kind: "home", value: dir, createdAt: "2026-01-01T00:00:00Z" };
}

function isBinding(x: OpenaiAccountBinding | { error: string }): x is OpenaiAccountBinding {
  return !("error" in x);
}

describe("bindOpenaiAccount", () => {
  test("api_key account → apiKey provider override, no seeding", () => {
    const acc: CodexAccount = {
      id: "acc-key-000000",
      name: "test-key",
      kind: "api_key",
      value: "sk-test-abc123",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const bound = bindOpenaiAccount(acc);
    expect(isBinding(bound)).toBe(true);
    if (!isBinding(bound)) return;
    expect(bound.mechanism).toBe("api-key");
    expect(bound.extraEnv).toEqual({});
    expect(bound.providerOverride).toEqual({
      openai: { options: { apiKey: "sk-test-abc123", headerTimeout: 60000 } },
    });
  });

  test("home account with missing auth.json → fail-fast error (never hangs)", () => {
    const bound = bindOpenaiAccount(homeAccount("/nonexistent/codex-home-xyz"));
    expect("error" in bound).toBe(true);
    if ("error" in bound) expect(bound.error).toContain("auth.json");
  });

  test("home account with expired ChatGPT token → fail-fast expired error", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-openai-exp-"));
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) - 3600), refresh_token: "rt.SECRET", account_id: "cf-1" },
      })
    );
    const bound = bindOpenaiAccount(homeAccount(dir));
    expect("error" in bound).toBe(true);
    if ("error" in bound) expect(bound.error).toContain("expired");
  });

  test("home account with a valid ChatGPT token → seeds access-only oauth (rotation-safe)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-openai-ok-"));
    const expSec = Math.floor(Date.now() / 1000) + 8 * 3600;
    const access = fakeJwt(expSec);
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: access, refresh_token: "rt.SECRET-MUST-NOT-LEAK", account_id: "cf-account-99" },
      })
    );
    const bound = bindOpenaiAccount(homeAccount(dir));
    expect(isBinding(bound)).toBe(true);
    if (!isBinding(bound)) return;
    expect(bound.mechanism).toBe("oauth-subscription");
    const models = (bound.providerOverride!.openai as any).models;
    // The ChatGPT backend accepts input up to the measured 372k context wall;
    // OpenCode subtracts its own 20k safety reserve when arming autocompact.
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(models[model].limit).toEqual({
        context: 372_000,
        input: 372_000,
        output: 128_000,
      });
    }
    // Retired 5.5 remains conservative (and is rerouted before dispatch).
    expect(models["gpt-5.5"].limit).toEqual({
      context: 272_000,
      input: 144_000,
      output: 128_000,
    });
    expect(models["gpt-5.5"].variants["high-fast"]).toEqual({
      reasoningEffort: "high",
      serviceTier: "priority",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    });
    const xdg = bound.extraEnv.XDG_DATA_HOME;
    expect(xdg).toContain("acc-home-123456");

    const seededPath = join(xdg, "opencode", "auth.json");
    const seeded = JSON.parse(readFileSync(seededPath, "utf-8"));
    // Access token seeded verbatim; expiry from the JWT; accountId carried.
    expect(seeded.openai.type).toBe("oauth");
    expect(seeded.openai.access).toBe(access);
    expect(seeded.openai.expires).toBe(expSec * 1000);
    expect(seeded.openai.accountId).toBe("cf-account-99");
    // THE rotation-hazard guarantee: the source refresh token is NEVER copied;
    // opencode gets a placeholder so it can never rotate & invalidate CODEX_HOME.
    expect(seeded.openai.refresh).toBe(OPENCODE_OPENAI_PLACEHOLDER_REFRESH);
    expect(JSON.stringify(seeded)).not.toContain("SECRET-MUST-NOT-LEAK");
    // Seeded file is 0600.
    expect(statSync(seededPath).mode & 0o777).toBe(0o600);
  });
});

describe("openaiPromptVariant", () => {
  test("combines priority service tier with reasoning effort", () => {
    expect(openaiPromptVariant("high", true)).toBe("high-fast");
    expect(openaiPromptVariant("none", true)).toBe("none-fast");
    expect(openaiPromptVariant(undefined, true)).toBe("fast");
    expect(openaiPromptVariant("high", false)).toBe("high");
  });

  test("exposes Fast mode only for models with configured variants", () => {
    expect(supportsOpenaiFastMode("opencode/openai/gpt-5.5")).toBe(true);
    expect(supportsOpenaiFastMode("opencode/openai/future-model")).toBe(false);
  });
});
