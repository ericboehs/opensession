import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import {
  buildCodexDeveloperInstructions,
  buildCodexMcpNameMap,
  codexMcpEntryFromServer,
  normalizeCodexEffort,
  writeCodexImages,
} from "./codex-runner";

describe("buildCodexDeveloperInstructions", () => {
  it("adds Claude-equivalent Backstage context for interactive Codex runs", () => {
    const instructions = buildCodexDeveloperInstructions({
      isAsk: false,
      bksSessionId: "bks-demo",
      reposNote: "This session spans multiple repos.",
      inProcessMcp: { "michael-sessions": {}, "michael-repos": {} },
      confirmTools: { mcp__stripe__create_refund: "Create a refund" },
    })!;

    expect(instructions).toContain("This session spans multiple repos.");
    expect(instructions).toContain("https://michael.taila5d766.ts.net/backstage/session/bks-demo");
    expect(instructions).toContain("michael-sessions MCP tools");
    expect(instructions).toContain("Model routing and Codex delegation");
    expect(instructions).toContain("Money-moving tools");
  });

  it("explains the ask_user bridge when michael-ask is wired", () => {
    const instructions = buildCodexDeveloperInstructions({
      isAsk: false,
      inProcessMcp: { "michael-ask": {}, "michael-sessions": {} },
    })!;

    expect(instructions).toContain("ask_user");
    expect(instructions).toContain("question card");
  });

  it("adds MCP alias guidance when runtime server names are remapped", () => {
    const instructions = buildCodexDeveloperInstructions({
      isAsk: false,
      mcpAliasNote:
        "## MCP Server Aliases\n- `plain` is exposed as `backstage_plain`",
    })!;

    expect(instructions).toContain("MCP Server Aliases");
    expect(instructions).toContain("`plain` is exposed as `backstage_plain`");
  });

  it("adds read-only guardrails for ask-mode Codex runs", () => {
    const instructions = buildCodexDeveloperInstructions({ isAsk: true })!;

    expect(instructions).toContain("READ-ONLY session");
    expect(instructions).toContain("never modify, create, or delete");
  });

  it("returns undefined when there is no context to add", () => {
    expect(buildCodexDeveloperInstructions({ isAsk: false })).toBeUndefined();
  });
});

describe("normalizeCodexEffort", () => {
  it("passes valid efforts through and maps Claude's max to xhigh", () => {
    expect(normalizeCodexEffort("high")).toBe("high");
    expect(normalizeCodexEffort("Low")).toBe("low");
    expect(normalizeCodexEffort("max")).toBe("xhigh");
    expect(normalizeCodexEffort("bogus")).toBeUndefined();
    expect(normalizeCodexEffort(undefined)).toBeUndefined();
  });
});

describe("buildCodexMcpNameMap", () => {
  it("aliases runtime MCP servers that collide with project Codex config", () => {
    const aliases = buildCodexMcpNameMap(
      ["plain", "linear", "workos"],
      new Set(["plain", "workos", "backstage_plain"])
    );

    expect(aliases.get("plain")).toBe("backstage_plain_2");
    expect(aliases.get("workos")).toBe("backstage_workos");
    expect(aliases.has("linear")).toBe(false);
  });
});

describe("codexMcpEntryFromServer", () => {
  it("serializes stdio servers with command even when metadata includes a url", () => {
    const entry = codexMcpEntryFromServer({
      command: "bun",
      args: ["run", "/tmp/plain-mcp/src/index.ts"],
      url: "https://app.plain.com/thread/example",
    });

    expect(entry).toEqual({
      command: "bun",
      args: ["run", "/tmp/plain-mcp/src/index.ts"],
      tool_timeout_sec: 600,
    });
  });

  it("honors per-server timeout overrides from mcp-config.json", () => {
    const entry = codexMcpEntryFromServer({
      command: "bun",
      tool_timeout_sec: 120,
      startup_timeout_sec: 20,
    });

    expect(entry.tool_timeout_sec).toBe(120);
    expect(entry.startup_timeout_sec).toBe(20);
  });
});

describe("writeCodexImages", () => {
  it("writes pasted image inputs as local files for the Codex SDK", () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const written = writeCodexImages([
      { mediaType: "image/png", data: pngBytes.toString("base64") },
    ]);

    try {
      expect(written.paths).toHaveLength(1);
      expect(written.paths[0].endsWith(".png")).toBe(true);
      expect(readFileSync(written.paths[0])).toEqual(pngBytes);
    } finally {
      written.cleanup();
    }

    expect(existsSync(written.paths[0])).toBe(false);
  });
});
