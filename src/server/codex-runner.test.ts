import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { buildCodexPrompt, writeCodexImages } from "./codex-runner";

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
