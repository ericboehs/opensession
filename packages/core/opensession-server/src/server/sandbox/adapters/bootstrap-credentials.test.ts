import { describe, expect, test } from "bun:test";
import {
  projectRemoteOpencodeConfig,
  projectRemoteOpencodeNativeAuth,
  projectRemotePiConfig,
  remoteOpencodeProviderId,
} from "./bootstrap";

describe("remote engine credential projection", () => {
  test("recognizes only third-party OpenCode model providers", () => {
    expect(remoteOpencodeProviderId("opencode/cerebras/gpt-oss-120b")).toBe("cerebras");
    expect(remoteOpencodeProviderId("opencode/anthropic/claude-sonnet-5")).toBeNull();
    expect(remoteOpencodeProviderId("opencode/openai/gpt-5.6-sol")).toBeNull();
    expect(remoteOpencodeProviderId("pi/openai/gpt-5.6-sol")).toBeNull();
  });

  test("Pi projection is allowlisted and disabled state removes the file", () => {
    expect(projectRemotePiConfig({ enabled: false, futureSecret: "do-not-copy" })).toBeNull();
    expect(
      JSON.parse(
        projectRemotePiConfig({
          enabled: true,
          pickerModels: ["pi/anthropic/claude-sonnet-5", "bad"],
          anthropicTransport: "bridge",
          futureSecret: "do-not-copy",
        })!,
      ),
    ).toEqual({
      enabled: true,
      pickerModels: ["pi/anthropic/claude-sonnet-5"],
      anthropicTransport: "bridge",
    });
  });

  test("subscription and Pi launches receive policy but no provider API keys", () => {
    const projected = projectRemoteOpencodeConfig(
      {
        enabled: true,
        bridge: {
          mode: "meridian",
          accounts: ["claude-1"],
          openaiAccounts: ["codex-1"],
          futureSecret: "drop",
        },
        turnTimeoutMinutes: 90,
        providers: {
          cerebras: { apiKey: "csk-secret", baseURL: "https://example.test", extra: "drop" },
        },
        futureSecret: "drop",
      },
      "opencode/anthropic/claude-sonnet-5",
    );
    expect(projected.settingsProviderIds).toEqual([]);
    expect(JSON.parse(projected.content)).toEqual({
      enabled: true,
      turnTimeoutMinutes: 90,
      bridge: {
        mode: "meridian",
        accounts: ["claude-1"],
        openaiAccounts: ["codex-1"],
      },
    });
  });

  test("OpenCode-other gets configured third-party scope but never bridge raw keys", () => {
    const projected = projectRemoteOpencodeConfig(
      {
        enabled: true,
        providers: {
          anthropic: { apiKey: "never" },
          openai: { apiKey: "never" },
          cerebras: { apiKey: "csk-secret", baseURL: "https://cerebras.test", extra: "drop" },
          xai: { apiKey: "xai-secret" },
          empty: { extra: "drop" },
        },
      },
      "opencode/cerebras/gpt-oss-120b",
    );
    expect(projected.settingsProviderIds).toEqual(["cerebras", "xai"]);
    expect(JSON.parse(projected.content).providers).toEqual({
      cerebras: { apiKey: "csk-secret", baseURL: "https://cerebras.test" },
      xai: { apiKey: "xai-secret" },
    });
  });

  test("automation projection pins subscription accounts and one selected API provider", () => {
    const projected = projectRemoteOpencodeConfig(
      {
        enabled: true,
        bridgeAccountIds: ["wide-claude"],
        bridge: {
          accounts: ["wide-claude"],
          openaiAccounts: ["wide-openai"],
        },
        providers: {
          cerebras: { apiKey: "selected" },
          xai: { apiKey: "must-not-cross" },
        },
      },
      "opencode/cerebras/gpt-oss-120b",
      "automation",
      "pinned-account",
    );
    expect(projected.settingsProviderIds).toEqual(["cerebras"]);
    expect(JSON.parse(projected.content)).toEqual({
      enabled: true,
      bridgeAccountIds: ["pinned-account"],
      bridge: {
        accounts: ["pinned-account"],
        openaiAccounts: ["pinned-account"],
      },
      providers: { cerebras: { apiKey: "selected" } },
    });
  });

  test("native auth projection contains exactly the selected provider", () => {
    const projected = projectRemoteOpencodeNativeAuth(
      {
        anthropic: { type: "oauth", refresh: "never-copy" },
        openai: { type: "oauth", refresh: "never-copy" },
        cerebras: { type: "api", key: "selected" },
        xai: { type: "api", key: "other" },
      },
      "opencode/cerebras/gpt-oss-120b",
    );
    expect(projected?.providerId).toBe("cerebras");
    expect(JSON.parse(projected!.content)).toEqual({
      cerebras: { type: "api", key: "selected" },
    });
    expect(
      projectRemoteOpencodeNativeAuth(
        { cerebras: { type: "api", key: "selected" } },
        "opencode/openai/gpt-5.6-sol",
      ),
    ).toBeNull();
  });
});
