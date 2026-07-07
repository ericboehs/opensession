import { describe, expect, it } from "bun:test";
import {
  describeAppServerToolUse,
  describeAppServerToolResult,
} from "./codex-appserver";

describe("describeAppServerToolUse", () => {
  it("maps v2 camelCase items onto the exec-transport tool names", () => {
    expect(
      describeAppServerToolUse({ type: "commandExecution", command: "ls -la" })
    ).toEqual({ toolName: "Bash", toolInput: { command: "ls -la" } });
    expect(
      describeAppServerToolUse({
        type: "mcpToolCall",
        server: "plain",
        tool: "get_thread",
        arguments: { id: "t1" },
      })
    ).toEqual({ toolName: "mcp__plain__get_thread", toolInput: { id: "t1" } });
    expect(
      describeAppServerToolUse({ type: "webSearch", query: "bun idle timeout" })
    ).toEqual({ toolName: "WebSearch", toolInput: { query: "bun idle timeout" } });
    expect(describeAppServerToolUse({ type: "userMessage" })).toBeNull();
    expect(describeAppServerToolUse({ type: "reasoning" })).toBeNull();
  });
});

describe("describeAppServerToolResult", () => {
  it("renders command output with exit code", () => {
    expect(
      describeAppServerToolResult({
        type: "commandExecution",
        exitCode: 0,
        aggregatedOutput: "done",
      })
    ).toBe("exit 0\ndone");
  });

  it("joins MCP text content and surfaces errors", () => {
    expect(
      describeAppServerToolResult({
        type: "mcpToolCall",
        result: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      })
    ).toBe("a\nb");
    expect(
      describeAppServerToolResult({
        type: "mcpToolCall",
        error: { message: "boom" },
      })
    ).toBe("Error: boom");
  });

  it("summarizes file changes", () => {
    expect(
      describeAppServerToolResult({
        type: "fileChange",
        status: "completed",
        changes: [{ kind: "update", path: "a.ts" }],
      })
    ).toBe("completed: update a.ts");
  });

  it("returns null for non-tool items", () => {
    expect(describeAppServerToolResult({ type: "agentMessage", text: "hi" })).toBeNull();
  });
});
