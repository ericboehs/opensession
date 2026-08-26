import { describe, expect, test } from "bun:test";
import {
  haikuOneShotFallbackModel,
  haikuOneShotShouldFallOver,
  oneShot,
  oneShotModel,
} from "./one-shot";

describe("oneShot", () => {
  test("routes native and legacy Pi model ids onto Pi", () => {
    expect(oneShotModel("claude-haiku-4-5")).toBe(
      "pi/anthropic/claude-haiku-4-5",
    );
    expect(oneShotModel("pi/openai/gpt-5.6-luna")).toBe(
      "pi/openai/gpt-5.6-luna",
    );
    expect(oneShotModel("pi/anthropic/claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5",
    );
  });

  test("never spends a model turn under tests", async () => {
    expect(await oneShot("Reply with ok")).toBeNull();
  });

  test("falls back from Haiku to OpenAI for provider exhaustion", () => {
    expect(
      haikuOneShotFallbackModel(
        "pi/anthropic/claude-haiku-4-5",
        "no usable Claude account in the pool",
      ),
    ).toBe("pi/openai/gpt-5.6-luna");
    expect(
      haikuOneShotFallbackModel(
        "pi/anthropic/claude-haiku-4-5",
        "timed out after 120000ms",
      ),
    ).toBe("pi/openai/gpt-5.6-luna");
  });

  test("does not fall over for caller or non-Haiku failures", () => {
    expect(haikuOneShotShouldFallOver("invalid model id")).toBe(false);
    expect(
      haikuOneShotFallbackModel(
        "pi/anthropic/claude-haiku-4-5",
        "invalid model id",
      ),
    ).toBeUndefined();
    expect(
      haikuOneShotFallbackModel(
        "pi/openai/gpt-5.6-luna",
        "usage limit reached",
      ),
    ).toBeUndefined();
  });
});
