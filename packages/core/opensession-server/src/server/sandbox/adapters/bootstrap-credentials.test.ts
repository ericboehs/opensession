import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  projectRemoteClaudeAccounts,
  projectRemoteModelProviderConfig,
  projectRemotePiConfig,
  remoteModelProviderId,
  remoteRunNeedsAnthropic,
  remoteRunNeedsOpenai,
  injectCloneCredential,
  selectedCloneToken,
  warmRemoteWorkspace,
} from "./bootstrap";
import type { RemoteDriver } from "./bootstrap";

describe("GitHub clone credential cutover", () => {
  test("App mode never falls back to a persisted PAT", () => {
    expect(selectedCloneToken(undefined, "retired-pat", true, "app")).toBeUndefined();
    expect(selectedCloneToken("fresh-app", "retired-pat", true, "app")).toBe("fresh-app");
    expect(selectedCloneToken(undefined, "active-pat", true, "pat")).toBe("active-pat");
    expect(selectedCloneToken(undefined, "other-host", false, "app")).toBe("other-host");
  });

  test("scrubs a warm origin before repository dependency code runs", async () => {
    const commands: string[] = [];
    const driver = {
      exec: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await warmRemoteWorkspace(
      driver as unknown as RemoteDriver,
      {
        id: "opensession",
        repo: "/host/opensession",
        ghRepo: "tellahq/opensession",
        defaultBranch: "main",
      },
      "test",
    );

    const scrub = commands.findIndex((command) => command.includes("remote set-url origin"));
    const deps = commands.findIndex((command) => command.includes("install --frozen-lockfile"));
    expect(scrub).toBeGreaterThanOrEqual(0);
    expect(deps).toBeGreaterThan(scrub);
  });

  test("resolves the selected GitHub credential without a legacy clone credential", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-clone-credential-"));
    const previous = {
      config: process.env.OPENSESSION_CONFIG,
      sandbox: process.env.OPENSESSION_SANDBOX_CONFIG,
      token: process.env.GITHUB_API_TOKEN,
    };
    try {
      const config = join(dir, "config.json");
      const sandbox = join(dir, "sandbox.json");
      writeFileSync(config, JSON.stringify({ integrations: { github: { botCredential: "pat" } } }));
      writeFileSync(sandbox, JSON.stringify({ provider: "daytona" }));
      process.env.OPENSESSION_CONFIG = config;
      process.env.OPENSESSION_SANDBOX_CONFIG = sandbox;
      process.env.GITHUB_API_TOKEN = "live-selected-token";

      expect(
        await injectCloneCredential("https://github.com/tellahq/opensession.git"),
      ).toBe(
        "https://x-access-token:live-selected-token@github.com/tellahq/opensession.git",
      );
    } finally {
      if (previous.config === undefined) delete process.env.OPENSESSION_CONFIG;
      else process.env.OPENSESSION_CONFIG = previous.config;
      if (previous.sandbox === undefined) delete process.env.OPENSESSION_SANDBOX_CONFIG;
      else process.env.OPENSESSION_SANDBOX_CONFIG = previous.sandbox;
      if (previous.token === undefined) delete process.env.GITHUB_API_TOKEN;
      else process.env.GITHUB_API_TOKEN = previous.token;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("remote engine credential projection", () => {
  test("every remote provider delegates launch credential projection to bootstrap", () => {
    for (const provider of ["daytona", "box", "e2b", "modal"]) {
      const source = readFileSync(join(import.meta.dir, `${provider}.ts`), "utf-8");
      expect(source).toContain("makeRemoteSandbox({");
      expect(source).not.toContain("listCodexAccounts(");
      expect(source).not.toContain("CODEX_HOME:");
      expect(source).not.toContain("OPENAI_API_KEY:");
    }
  });

  test("run specs are private in both host and guest filesystems", () => {
    const source = readFileSync(join(import.meta.dir, "bootstrap.ts"), "utf-8");
    expect(source).toContain("writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec, true, 0o600)");
    expect(source).toContain("remote run spec chmod failed");
  });

  test("recognizes only third-party Pi model providers", () => {
    expect(remoteModelProviderId("pi/cerebras/gpt-oss-120b")).toBe("cerebras");
    expect(remoteModelProviderId("pi/anthropic/claude-sonnet-5")).toBeNull();
    expect(remoteModelProviderId("pi/openai/gpt-5.6-sol")).toBeNull();
    expect(remoteModelProviderId("pi/openai/gpt-5.6-sol")).toBeNull();
  });

  test("projects subscription credentials only when the reachable walk needs them", () => {
    expect(remoteRunNeedsAnthropic("pi/anthropic/claude-sonnet-5", "none")).toBe(true);
    expect(remoteRunNeedsAnthropic("pi/openai/gpt-5.6-sol", "none")).toBe(false);
    expect(remoteRunNeedsOpenai("pi/openai/gpt-5.6-sol")).toBe(true);
    expect(remoteRunNeedsOpenai("pi/orchestrator/sol")).toBe(true);
    // Production workspace-preset tuple: both the lead and preferred fallback
    // are Opus, but the automatic graph's first reachable hop is Sol.
    expect(
      remoteRunNeedsOpenai("pi/dial/opus-fable", "pi/anthropic/claude-opus-5"),
    ).toBe(true);
    expect(remoteRunNeedsOpenai("pi/dial/opus-fable", "none")).toBe(false);
  });

  test("Claude projection strips host paths and unknown future fields", () => {
    expect(
      projectRemoteClaudeAccounts([
        {
          id: "claude-1",
          name: "Claude one",
          token: "oauth-selected",
          createdAt: "2026-08-20T00:00:00.000Z",
          owner: "Alex",
          credentialsPath: "/home/ubuntu/.claude/credentials.json",
          futureSecret: "drop-me",
        } as any,
      ]),
    ).toEqual([
      {
        id: "claude-1",
        name: "Claude one",
        token: "oauth-selected",
        createdAt: "2026-08-20T00:00:00.000Z",
        owner: "Alex",
      },
    ]);
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
    const projected = projectRemoteModelProviderConfig(
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
      "pi/anthropic/claude-sonnet-5",
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

  test("Pi-other gets configured third-party scope but never bridge raw keys", () => {
    const projected = projectRemoteModelProviderConfig(
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
      "pi/cerebras/gpt-oss-120b",
    );
    expect(projected.settingsProviderIds).toEqual(["cerebras"]);
    expect(JSON.parse(projected.content).providers).toEqual({
      cerebras: { apiKey: "csk-secret", baseURL: "https://cerebras.test" },
    });
  });

  test("interactive provider projection follows only the reachable fallback walk", () => {
    const projected = projectRemoteModelProviderConfig(
      {
        providers: {
          cerebras: { apiKey: "cerebras-key" },
          xai: { apiKey: "xai-key" },
          groq: { apiKey: "must-not-cross" },
        },
      },
      "pi/cerebras/gpt-oss-120b",
      "interactive",
      undefined,
      "pi/xai/grok-4",
    );
    expect(projected.settingsProviderIds).toEqual(["cerebras", "xai"]);
    expect(projected.content).not.toContain("must-not-cross");
  });

  test("automation projection pins subscription accounts and one selected API provider", () => {
    const projected = projectRemoteModelProviderConfig(
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
      "pi/cerebras/gpt-oss-120b",
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

});
