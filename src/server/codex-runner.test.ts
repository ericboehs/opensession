import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import {
  buildCodexMcpNameMap,
  buildCodexPrompt,
  codexMcpEntryFromServer,
  writeCodexImages,
} from "./codex-runner";

describe("buildCodexPrompt", () => {
  it("adds Claude-equivalent Backstage context for interactive Codex runs", () => {
    const prompt = buildCodexPrompt({
      prompt: "Implement the thing.",
      isAsk: false,
      bksSessionId: "bks-demo",
      reposNote: "This session spans multiple repos.",
      inProcessMcp: { "michael-sessions": {}, "michael-repos": {} },
      confirmTools: { mcp__stripe__create_refund: "Create a refund" },
    });

    expect(prompt).toContain("This session spans multiple repos.");
    expect(prompt).toContain("https://michael.taila5d766.ts.net/backstage/session/bks-demo");
    expect(prompt).toContain("michael-sessions MCP tools");
    expect(prompt).toContain("Model routing and Codex delegation");
    expect(prompt).toContain("Money-moving tools");
    expect(prompt.endsWith("Implement the thing.")).toBe(true);
  });

  it("adds MCP alias guidance when runtime server names are remapped", () => {
    const prompt = buildCodexPrompt({
      prompt: "Reply in Plain.",
      isAsk: false,
      mcpAliasNote:
        "## MCP Server Aliases\n- `plain` is exposed as `backstage_plain`",
    });

    expect(prompt).toContain("MCP Server Aliases");
    expect(prompt).toContain("`plain` is exposed as `backstage_plain`");
    expect(prompt.endsWith("Reply in Plain.")).toBe(true);
  });

  it("adds read-only guardrails for ask-mode Codex runs", () => {
    const prompt = buildCodexPrompt({
      prompt: "What changed?",
      isAsk: true,
    });

    expect(prompt).toContain("READ-ONLY session");
    expect(prompt).toContain("never modify, create, or delete files");
    expect(prompt).toContain("What changed?");
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
    });
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
