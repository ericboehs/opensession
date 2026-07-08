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
} from "./anthropic-bridge";

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
    expect(opencodeGateReason({})).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "prompt" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "create" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "goal" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "prompt-resume" } })).toBeNull();
    expect(opencodeGateReason({ journal: { kind: "prompt-fallback" } })).toBeNull();
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
