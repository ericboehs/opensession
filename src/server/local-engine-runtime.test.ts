import { afterEach, describe, expect, it } from "bun:test";
import {
  assertLocalOpencodeVersion,
  ensureLocalMeridianReady,
  LOCAL_OPENCODE_MIN_VERSION,
  meridianProxyBaseUrl,
  meridianStackInfo,
  latestTurnAssistant,
  missingAssistantTurnError,
  opencodeServerConfigHash,
  type OpencodeServerEntry,
} from "./opencode-runner";

const savedProfile = process.env.OPENSESSION_PROFILE;

afterEach(() => {
  if (savedProfile === undefined) delete process.env.OPENSESSION_PROFILE;
  else process.env.OPENSESSION_PROFILE = savedProfile;
});

function serverEntry(): OpencodeServerEntry {
  return {
    proc: { exitCode: null, killed: false } as any,
    url: "http://127.0.0.1:4000",
    password: "password",
    cwd: "/tmp",
    configHash: "hash",
    key: "test",
    rpcToken: "rpc",
    meridianKey: "bridge-key",
    meridianPort: 4567,
    lastUsed: 0,
    activeRuns: 0,
  };
}

describe("local engine runtime", () => {
  it("accepts the first source-verified OpenCode path-plugin release and newer versions", () => {
    expect(LOCAL_OPENCODE_MIN_VERSION).toBe("1.3.8");
    expect(() => assertLocalOpencodeVersion("1.3.8", "/usr/local/bin/opencode")).not.toThrow();
    expect(() => assertLocalOpencodeVersion("opencode v1.18.4", "/usr/local/bin/opencode")).not.toThrow();
    expect(() => assertLocalOpencodeVersion("2.0.0-beta.1", "/usr/local/bin/opencode")).not.toThrow();
  });

  it("rejects OpenCode versions that cannot load absolute path plugins", () => {
    expect(() => assertLocalOpencodeVersion("1.3.7", "/opt/homebrew/bin/opencode")).toThrow(
      "requires OpenCode >= 1.3.8",
    );
    expect(() => assertLocalOpencodeVersion("1.2.27", "/opt/homebrew/bin/opencode")).toThrow(
      "requires OpenCode >= 1.3.8",
    );
    expect(() => assertLocalOpencodeVersion("1.2.27", "/opt/homebrew/bin/opencode")).toThrow(
      "OPENSESSION_OPENCODE_BIN",
    );
  });

  it("rejects unreadable OpenCode version output", () => {
    expect(() => assertLocalOpencodeVersion("unknown", "opencode-custom")).toThrow(
      "opencode-custom reports unknown",
    );
  });

  it("uses the allocated Meridian port instead of a placeholder", () => {
    expect(meridianProxyBaseUrl("4567")).toBe("http://127.0.0.1:4567");
    expect(() => meridianProxyBaseUrl(undefined)).toThrow("Invalid Meridian proxy port");
  });

  it("does not respawn a cached server only because its next allocated port differs", () => {
    const configFor = (port: number) => ({
      provider: { anthropic: { options: { baseURL: `http://127.0.0.1:${port}`, apiKey: "key" } } },
    });
    const envFor = (port: number) => ({ CLAUDE_PROXY_PORT: String(port), MERIDIAN_API_KEY: "key" });

    expect(opencodeServerConfigHash(configFor(4567), "/tmp", envFor(4567))).toBe(
      opencodeServerConfigHash(configFor(5678), "/tmp", envFor(5678)),
    );
    expect(
      opencodeServerConfigHash(configFor(4567), "/tmp", {
        ...envFor(4567),
        MERIDIAN_API_KEY: "different-key",
      }),
    ).not.toBe(opencodeServerConfigHash(configFor(4567), "/tmp", envFor(4567)));
  });

  it("marks a healthy checkout-local Meridian proxy ready", async () => {
    process.env.OPENSESSION_PROFILE = "local";
    const entry = serverEntry();
    let requested = "";
    await ensureLocalMeridianReady(entry, meridianStackInfo(), {
      fetcher: (async (input: string | URL | Request) => {
        requested = String(input);
        return Response.json({ status: "healthy" });
      }) as typeof fetch,
    });

    expect(requested).toBe("http://127.0.0.1:4567/health");
    expect(entry.meridianReady).toBe(true);
  });

  it("fails loudly when the local bridge plugin never starts its proxy", async () => {
    process.env.OPENSESSION_PROFILE = "local";
    await expect(
      ensureLocalMeridianReady(serverEntry(), meridianStackInfo(), {
        timeoutMs: 1,
        fetcher: (async () => {
          throw new Error("connection refused");
        }) as unknown as typeof fetch,
        sleep: () => Bun.sleep(2),
      }),
    ).rejects.toThrow("Local Claude bridge failed to start");
  });

  it("cancels readiness without contacting or aborting an idle engine session", async () => {
    process.env.OPENSESSION_PROFILE = "local";
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let fetched = false;

    await expect(
      ensureLocalMeridianReady(serverEntry(), meridianStackInfo(), {
        signal: controller.signal,
        fetcher: (async () => {
          fetched = true;
          return Response.json({ status: "healthy" });
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("cancelled");
    expect(fetched).toBe(false);
  });

  it("turns an absent assistant message into a user-facing run error", () => {
    expect(missingAssistantTurnError("anthropic")).toContain(
      "ended without an assistant message",
    );
  });

  it("does not reuse a historical assistant when the current turn has no reply", () => {
    const oldAssistant = { info: { role: "assistant" }, parts: [{ text: "old" }] };
    expect(
      latestTurnAssistant([
        { info: { role: "user" }, parts: [] },
        oldAssistant,
        { info: { role: "user" }, parts: [] },
      ]),
    ).toBeUndefined();
    expect(
      latestTurnAssistant([
        { info: { role: "user" }, parts: [] },
        oldAssistant,
        { info: { role: "user" }, parts: [] },
        { info: { role: "assistant" }, parts: [{ text: "new" }] },
      ])?.parts[0].text,
    ).toBe("new");
  });
});
