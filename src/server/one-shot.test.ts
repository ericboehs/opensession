import { describe, expect, test } from "bun:test";
import { oneShot, oneShotModel } from "./one-shot";

describe("oneShot", () => {
  test("routes native and legacy OpenCode model ids onto Pi", () => {
    expect(oneShotModel("claude-haiku-4-5")).toBe(
      "pi/anthropic/claude-haiku-4-5",
    );
    expect(oneShotModel("opencode/openai/gpt-5.6-luna")).toBe(
      "pi/openai/gpt-5.6-luna",
    );
    expect(oneShotModel("pi/anthropic/claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5",
    );
  });

  test("never spends a model turn under tests", async () => {
    expect(await oneShot("Reply with ok")).toBeNull();
  });
});
