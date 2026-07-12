import { describe, expect, test } from "bun:test";
import { isLikelyPromptCacheMiss, type TurnUsage } from "./run-events";

const usage = (contextTokens: number, cacheReadTokens = 0): TurnUsage => ({
  inputTokens: contextTokens - cacheReadTokens,
  outputTokens: 100,
  cacheReadTokens,
  cacheCreationTokens: 0,
  contextTokens,
});

describe("isLikelyPromptCacheMiss", () => {
  test("warns on a large repeated Anthropic turn without a meaningful cache read", () => {
    expect(isLikelyPromptCacheMiss(usage(20_000), 2, "anthropic")).toBe(true);
    expect(isLikelyPromptCacheMiss(usage(20_000, 500), 2, "anthropic")).toBe(true);
  });

  test("ignores first turns, small prompts, and other providers", () => {
    expect(isLikelyPromptCacheMiss(usage(20_000), 1, "anthropic")).toBe(false);
    expect(isLikelyPromptCacheMiss(usage(9_999), 2, "anthropic")).toBe(false);
    expect(isLikelyPromptCacheMiss(usage(20_000), 2, "openai")).toBe(false);
  });

  test("accepts either a substantial absolute or proportional cache read", () => {
    expect(isLikelyPromptCacheMiss(usage(20_000, 1_024), 2, "anthropic")).toBe(false);
    expect(isLikelyPromptCacheMiss(usage(10_000, 500), 2, "anthropic")).toBe(false);
  });
});
