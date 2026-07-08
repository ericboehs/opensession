import { describe, expect, test } from "bun:test";
import {
  parseOpencodeModel,
  opencodeGateReason,
  proxyOpencodeMcpConfigs,
  buildOpencodeInstructions,
} from "./opencode-runner";
import {
  flattenMessageText,
  replayConversation,
  jsonSchemaToZodShape,
  admitBridgeRequest,
} from "./anthropic-bridge";
import {
  opencodeTurnTimeoutMs,
  bridgeMaxRequestsPerHour,
  DEFAULT_TURN_TIMEOUT_MINUTES,
  DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR,
} from "./opencode-config";

describe("parseOpencodeModel", () => {
  test("splits provider/model", () => {
    expect(parseOpencodeModel("opencode/anthropic/claude-sonnet-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
    });
  });
  test("model id may contain slashes (openrouter-style)", () => {
    expect(parseOpencodeModel("opencode/openrouter/meta/llama-4")).toEqual({
      providerID: "openrouter",
      modelID: "meta/llama-4",
    });
  });
  test("rejects non-opencode and malformed ids", () => {
    expect(parseOpencodeModel("claude-sonnet-5")).toBeNull();
    expect(parseOpencodeModel("opencode/anthropic")).toBeNull();
    expect(parseOpencodeModel("opencode/anthropic/")).toBeNull();
    expect(parseOpencodeModel("opencode//x")).toBeNull();
  });
});

describe("opencodeGateReason (automation hard gate)", () => {
  test("interactive kinds pass", () => {
    expect(opencodeGateReason({ journal: { kind: "prompt" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "create" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "goal" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "prompt-resume" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "prompt-fallback" } })).toBeNull();
  });
  test("deny by default: no journal / no kind / empty kind are all blocked", () => {
    expect(opencodeGateReason({})).toContain("deny by default");
    expect(opencodeGateReason({ journal: {} })).toContain("deny by default");
    expect(opencodeGateReason({ journal: { kind: "" } })).toContain("deny by default");
  });
  test("explicit allowOpencode marker passes without a journal (verify scripts)", () => {
    expect(opencodeGateReason({ allowOpencode: true })).toBeNull();
  });
  test("allowOpencode never overrides the deniedTools block", () => {
    expect(
      opencodeGateReason({
        allowOpencode: true,
        deniedTools: { mcp__plain__reply_to_thread: "no" },
      })
    ).toContain("automation");
  });
  test("automation kinds are blocked, including derivatives", () => {
    expect(opencodeGateReason({ journal: { kind: "automation" } })).toContain("not available");
    expect(opencodeGateReason({ journal: { kind: "automation-resume" } })).toContain("not available");
    expect(opencodeGateReason({ journal: { kind: "automation-fallback" } })).toContain("not available");
    expect(opencodeGateReason({ journal: { kind: "action" } })).toContain("not available");
    expect(opencodeGateReason({ journal: { kind: "github-review" } })).toContain("not available");
    expect(opencodeGateReason({ journal: { kind: "security-scan" } })).toContain("not available");
  });
  test("any deniedTools (automation least-privilege set) blocks, even interactive", () => {
    expect(
      opencodeGateReason({
        journal: { kind: "prompt" },
        deniedTools: { mcp__plain__reply_to_thread: "no" },
      })
    ).toContain("automation");
  });
});

describe("proxyOpencodeMcpConfigs", () => {
  test("builds stdio proxy entries with token env", () => {
    const out = proxyOpencodeMcpConfigs({ "michael-sessions": {}, "michael-ask": {} }, "tok-1");
    expect(Object.keys(out).sort()).toEqual(["michael-ask", "michael-sessions"]);
    const entry = out["michael-sessions"] as any;
    expect(entry.type).toBe("local");
    expect(entry.command[0]).toContain("bun");
    expect(entry.environment.BKS_RPC_TOKEN).toBe("tok-1");
    expect(entry.environment.BKS_MCP_SERVER).toBe("michael-sessions");
  });
  test("empty without token or servers (fail closed)", () => {
    expect(proxyOpencodeMcpConfigs({ "michael-admin": {} }, undefined)).toEqual({});
    expect(proxyOpencodeMcpConfigs(undefined, "tok")).toEqual({});
  });
});

describe("buildOpencodeInstructions", () => {
  test("ask mode gets the read-only guardrail", () => {
    expect(buildOpencodeInstructions({ isAsk: true })).toContain("READ-ONLY");
  });
  test("code mode gets the session link, dropped servers are named", () => {
    const s = buildOpencodeInstructions({
      isAsk: false,
      bksSessionId: "abc-123",
      droppedForConfirm: ["stripe"],
    });
    expect(s).toContain("/session/abc-123");
    expect(s).toContain("stripe");
    expect(s).toContain("human approval");
  });
});

describe("anthropic-bridge message flattening", () => {
  test("tool_results unwrap to raw output", () => {
    expect(
      flattenMessageText([
        { type: "tool_result", tool_use_id: "t1", content: "exit 0" },
        { type: "text", text: "and a note" },
      ])
    ).toBe("exit 0\nand a note");
  });
  test("replay labels prior assistant turns", () => {
    const replay = replayConversation([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "42" }] },
    ]);
    expect(replay).toContain("hi");
    expect(replay).toContain("[Your previous reply]\nhello");
    expect(replay.endsWith("42")).toBe(true);
  });
});

describe("anthropic-bridge rate limiting", () => {
  test("admits under the ceiling, rejects past it, tracks tokens", () => {
    const account = `test-acct-${crypto.randomUUID()}`;
    const limit = bridgeMaxRequestsPerHour();
    const t0 = Date.now();
    for (let i = 0; i < limit; i++) {
      expect(admitBridgeRequest(account, 100, t0 + i).allowed).toBe(true);
    }
    const rejected = admitBridgeRequest(account, 100, t0 + limit);
    expect(rejected.allowed).toBe(false);
    expect(rejected.requests).toBe(limit);
    expect(rejected.tokens).toBe(limit * 100);
    expect(rejected.limit).toBe(limit);
  });
  test("window is rolling: old requests age out after an hour", () => {
    const account = `test-acct-${crypto.randomUUID()}`;
    const limit = bridgeMaxRequestsPerHour();
    const t0 = Date.now();
    for (let i = 0; i < limit; i++) admitBridgeRequest(account, 10, t0);
    expect(admitBridgeRequest(account, 10, t0 + 1).allowed).toBe(false);
    expect(admitBridgeRequest(account, 10, t0 + 60 * 60 * 1000 + 1).allowed).toBe(true);
  });
  test("accounts are limited independently", () => {
    const a = `test-acct-${crypto.randomUUID()}`;
    const b = `test-acct-${crypto.randomUUID()}`;
    const limit = bridgeMaxRequestsPerHour();
    const t0 = Date.now();
    for (let i = 0; i < limit; i++) admitBridgeRequest(a, 1, t0);
    expect(admitBridgeRequest(a, 1, t0 + 1).allowed).toBe(false);
    expect(admitBridgeRequest(b, 1, t0 + 1).allowed).toBe(true);
  });
});

describe("opencode config defaults", () => {
  test("turn timeout and bridge request ceiling have sane defaults", () => {
    // Reads the live config file when present; both knobs must be positive and
    // default to the documented values when unset.
    expect(opencodeTurnTimeoutMs()).toBeGreaterThan(0);
    expect(DEFAULT_TURN_TIMEOUT_MINUTES).toBe(60);
    expect(bridgeMaxRequestsPerHour()).toBeGreaterThan(0);
    expect(DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR).toBe(300);
  });
});

describe("anthropic-bridge jsonSchemaToZodShape", () => {
  test("required vs optional and basic types", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        cmd: { type: "string", description: "shell command" },
        timeout: { type: "number" },
        flags: { type: "array", items: { type: "string" } },
      },
      required: ["cmd"],
    });
    expect(shape.cmd.safeParse("ls").success).toBe(true);
    expect(shape.cmd.safeParse(undefined).success).toBe(false);
    expect(shape.timeout.safeParse(undefined).success).toBe(true);
    expect(shape.flags.safeParse(["-a"]).success).toBe(true);
    expect(shape.flags.safeParse([1]).success).toBe(false);
  });
  test("degrades unknown constructs to permissive", () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape({ type: "string" })).toEqual({});
  });
});
