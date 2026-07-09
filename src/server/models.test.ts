import { describe, expect, it } from "bun:test";
import {
  BEST_AVAILABLE_CODEX_MODEL,
  fallbackModelChain,
  markCodexModelExhausted,
  opencodeModelLabel,
  resolveConcreteModel,
} from "./models";

describe("opencodeModelLabel", () => {
  it("gives opencode ids first-class friendly names — never the engine", () => {
    expect(opencodeModelLabel("opencode/anthropic/claude-sonnet-5")).toBe("Sonnet 5");
    expect(opencodeModelLabel("opencode/anthropic/claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(opencodeModelLabel("opencode/anthropic/claude-opus-4-8")).toBe("Opus 4.8");
    expect(opencodeModelLabel("opencode/anthropic/claude-fable-5")).toBe("Fable 5");
    expect(opencodeModelLabel("opencode/openai/gpt-5.5")).toBe("GPT-5.5");
    expect(opencodeModelLabel("opencode/openai/gpt-5.4-mini")).toBe("GPT-5.4 mini");
  });

  it("prettifies slugs with no native registry entry to borrow from", () => {
    expect(opencodeModelLabel("opencode/anthropic/claude-sonnet-6")).toBe("Sonnet 6");
    expect(opencodeModelLabel("opencode/openai/gpt-6")).toBe("GPT-6");
  });
});

describe("fallbackModelChain", () => {
  it("tries the configured fallback first, then other top models", () => {
    const chain = fallbackModelChain("claude-fable-5", "gpt-5.5").map(
      (m) => m.id
    );

    expect(chain[0]).toBe("gpt-5.5");
    expect(chain[1]).toBe("claude-opus-4-8");
    expect(chain).toContain("gpt-5.5");
    expect(chain).not.toContain("claude-fable-5");
  });

  it("skips the primary when the configured fallback is the same model", () => {
    const chain = fallbackModelChain("gpt-5.5", "gpt-5.5").map((m) => m.id);

    expect(chain[0]).toBe("claude-opus-4-8");
    expect(chain).not.toContain("gpt-5.5");
  });

  it("expands the best available codex fallback into concrete codex models", () => {
    const chain = fallbackModelChain("gpt-5.5", BEST_AVAILABLE_CODEX_MODEL).map(
      (m) => m.id
    );

    expect(chain.slice(0, 3)).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(chain).not.toContain("gpt-5.5");
  });
});

describe("resolveConcreteModel", () => {
  it("resolves best available codex to the strongest usable codex model", () => {
    expect(resolveConcreteModel(BEST_AVAILABLE_CODEX_MODEL)).toBe("gpt-5.5");
  });

  it("skips codex models marked exhausted", () => {
    markCodexModelExhausted("gpt-5.5");

    expect(resolveConcreteModel(BEST_AVAILABLE_CODEX_MODEL)).toBe("gpt-5.4");
  });
});
