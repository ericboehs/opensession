import { describe, expect, it } from "bun:test";
import {
  BEST_AVAILABLE_CODEX_MODEL,
  fallbackModelChain,
  markCodexModelExhausted,
  opencodeModelLabel,
  resolveConcreteModel,
  resolveModel,
  toOpencodeModel,
} from "./models";
import { bridgeEnabled } from "./opencode-config";

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

describe("toOpencodeModel", () => {
  it("maps openai/codex tiers onto the opencode engine unconditionally", () => {
    expect(toOpencodeModel("gpt-5.5")).toBe("opencode/openai/gpt-5.5");
    expect(toOpencodeModel("gpt-5.4-mini")).toBe("opencode/openai/gpt-5.4-mini");
    expect(toOpencodeModel(BEST_AVAILABLE_CODEX_MODEL)).toBe("opencode/openai/gpt-5.5");
  });
  it("passes opencode ids through untouched", () => {
    expect(toOpencodeModel("opencode/anthropic/claude-sonnet-5")).toBe(
      "opencode/anthropic/claude-sonnet-5"
    );
  });
  it("maps a bare provider/model path onto the opencode engine", () => {
    // A workflow agent({model}) override may write the provider path without the
    // engine prefix — it must reach the intended model, not degrade to default.
    expect(toOpencodeModel("openai/gpt-5.6-sol")).toBe(
      "opencode/openai/gpt-5.6-sol"
    );
    expect(resolveModel("openai/gpt-5.6-sol")?.id).toBe(
      "opencode/openai/gpt-5.6-sol"
    );
  });
  it("maps claude tiers only when the anthropic bridge is enabled (fail-safe)", () => {
    const mapped = toOpencodeModel("claude-fable-5");
    if (bridgeEnabled()) {
      expect(mapped).toBe("opencode/anthropic/claude-fable-5");
    } else {
      expect(mapped).toBe("claude-fable-5"); // degrades to native, not broken
    }
  });
});

describe("fallbackModelChain", () => {
  it("maps the whole chain onto the opencode engine — never a native SDK id", () => {
    const chain = fallbackModelChain("claude-fable-5", "gpt-5.5");
    const ids = chain.map((m) => m.id);

    // configured fallback first, mapped onto opencode; openai always maps.
    expect(chain[0].id).toBe("opencode/openai/gpt-5.5");
    expect(ids).not.toContain("gpt-5.5"); // no bare native id
    expect(ids).not.toContain("claude-fable-5");
    // With the anthropic bridge on, every entry (incl. claude tiers) is opencode.
    if (bridgeEnabled()) {
      for (const m of chain) {
        expect(m.provider).toBe("opencode");
        expect(m.id.startsWith("opencode/")).toBe(true);
      }
      expect(chain[1].id).toBe("opencode/anthropic/claude-opus-4-8");
    }
  });

  it("skips the primary when the configured fallback maps to the same engine model", () => {
    const chain = fallbackModelChain("gpt-5.5", "gpt-5.5").map((m) => m.id);
    expect(chain).not.toContain("opencode/openai/gpt-5.5");
    expect(chain).not.toContain("gpt-5.5");
  });

  it("expands the best available codex fallback into concrete opencode/openai models", () => {
    const chain = fallbackModelChain("gpt-5.5", BEST_AVAILABLE_CODEX_MODEL).map(
      (m) => m.id
    );
    expect(chain.slice(0, 3)).toEqual([
      "opencode/openai/gpt-5.4",
      "opencode/openai/gpt-5.4-mini",
      "opencode/openai/gpt-5.3-codex-spark",
    ]);
    expect(chain).not.toContain("opencode/openai/gpt-5.5");
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
