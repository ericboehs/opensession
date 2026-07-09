import { describe, expect, test } from "bun:test";
import { resolveDirectSdkModel } from "./model-resolve";

describe("resolveDirectSdkModel", () => {
  test("opencode/anthropic/* → native Claude id (the live bug)", () => {
    expect(resolveDirectSdkModel("opencode/anthropic/claude-sonnet-5")).toBe(
      "claude-sonnet-5"
    );
    expect(resolveDirectSdkModel("opencode/anthropic/claude-opus-4-8")).toBe(
      "claude-opus-4-8"
    );
  });

  test("opencode/openai/* → native GPT/Codex id", () => {
    expect(resolveDirectSdkModel("opencode/openai/gpt-5.5")).toBe("gpt-5.5");
    expect(resolveDirectSdkModel("opencode/openai/gpt-5.4-mini")).toBe(
      "gpt-5.4-mini"
    );
  });

  test("native ids pass through unchanged", () => {
    expect(resolveDirectSdkModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resolveDirectSdkModel("claude-fable-5")).toBe("claude-fable-5");
    expect(resolveDirectSdkModel("gpt-5.5")).toBe("gpt-5.5");
    expect(resolveDirectSdkModel("codex-best-available")).toBe(
      "codex-best-available"
    );
  });

  test("unknown / bare ids pass through (native passthrough contract)", () => {
    expect(resolveDirectSdkModel("claude-some-future-model")).toBe(
      "claude-some-future-model"
    );
    expect(resolveDirectSdkModel("whatever")).toBe("whatever");
  });

  test("a single-segment opencode/* (no provider) is left alone", () => {
    // Not a valid engine id; don't accidentally strip it to "".
    expect(resolveDirectSdkModel("opencode/foo")).toBe("opencode/foo");
  });

  test("empty / nullish → empty string", () => {
    expect(resolveDirectSdkModel("")).toBe("");
    expect(resolveDirectSdkModel(null)).toBe("");
    expect(resolveDirectSdkModel(undefined)).toBe("");
    expect(resolveDirectSdkModel("  opencode/anthropic/claude-sonnet-5  ")).toBe(
      "claude-sonnet-5"
    );
  });
});
