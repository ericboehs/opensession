import { describe, expect, it } from "bun:test";
import {
  BEST_AVAILABLE_CODEX_MODEL,
  fallbackPlan,
  fallbackTier,
  nextFallbackModel,
  markCodexModelExhausted,
  modelEfforts,
  normalizeModelEffort,
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

describe("model efforts", () => {
  it("exposes the variants supported by each configured model family", () => {
    expect(modelEfforts("opencode/openai/gpt-5.6-sol")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(modelEfforts("opencode/anthropic/claude-fable-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(modelEfforts("opencode/anthropic/claude-haiku-4-5")).toEqual([
      "high",
      "max",
    ]);
    expect(modelEfforts("opencode/meta/muse-spark-1.1")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(modelEfforts("opencode/xai/grok-4.5")).toEqual([]);
  });

  it("falls back to a supported effort when models change", () => {
    expect(normalizeModelEffort("opencode/anthropic/claude-haiku-4-5", "low")).toBe(
      "high"
    );
    expect(normalizeModelEffort("opencode/anthropic/claude-fable-5", "max")).toBe(
      "max"
    );
    expect(normalizeModelEffort("opencode/xai/grok-4.5", "high")).toBeUndefined();
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

describe("fallback graph (nextFallbackModel)", () => {
  // Sol is openai → always maps regardless of the anthropic bridge flag; the
  // claude ids adapt to bridge state via toOpencodeModel so the assertions hold
  // whether the bridge is on or off.
  const sol = "opencode/openai/gpt-5.6-sol";
  const opus = toOpencodeModel("claude-opus-4-8")!;
  const fable = toOpencodeModel("claude-fable-5")!;
  const sonnet = toOpencodeModel("claude-sonnet-5")!;

  it("keeps equal-or-smarter switches automatic, downgrades ask (Michiel's policy)", () => {
    // Fable → Sol: equal tier, automatic.
    expect(nextFallbackModel(fable, new Set([fable]), "claude-opus-4-8")).toEqual({
      id: sol,
      mode: "auto",
    });
    // Fable, Sol gone → Opus: downgrade, ASK.
    expect(
      nextFallbackModel(fable, new Set([fable, sol]), "claude-opus-4-8")
    ).toEqual({ id: opus, mode: "ask" });
    // Opus → Sol: upgrade-ish, automatic.
    expect(nextFallbackModel(opus, new Set([opus]), "claude-opus-4-8")).toEqual({
      id: sol,
      mode: "auto",
    });
    // Opus, Sol + gpt-5.5 gone → Sonnet: downgrade, ASK.
    expect(
      nextFallbackModel(
        opus,
        new Set([opus, sol, "opencode/openai/gpt-5.5"]),
        "claude-opus-4-8"
      )
    ).toEqual({ id: sonnet, mode: "ask" });
    // Sol → Opus: downgrade, ASK.
    expect(nextFallbackModel(sol, new Set([sol]), "claude-opus-4-8")).toEqual({
      id: opus,
      mode: "ask",
    });
  });

  it("never routes back into Fable (scarce weekly-scoped credit pool)", () => {
    const plan = fallbackPlan("claude-opus-4-8", "claude-opus-4-8");
    expect(plan.map((h) => h.id)).not.toContain(fable);
  });

  it("returns no plan when no fallback is configured / disabled", () => {
    expect(fallbackPlan("claude-fable-5", undefined)).toEqual([]);
    expect(fallbackPlan("claude-fable-5", "none")).toEqual([]);
  });

  it("Fable's plan leads with the automatic Sol hop; the drop to Opus is ask-gated", () => {
    const plan = fallbackPlan("claude-fable-5", "claude-opus-4-8");
    expect(plan.length).toBeGreaterThan(0);
    // First hop off Fable is the equal-tier Sol, taken automatically.
    expect(plan[0]).toEqual({ id: sol, mode: "auto" });
    // Dropping down to Opus is a downgrade → always ask (each hop's mode is
    // re-evaluated against the model it leaves, so lateral moves lower in the
    // chain can be auto again — that's intended).
    expect(plan.find((h) => h.id === opus)?.mode).toBe("ask");
    // With the anthropic bridge on, every hop is an opencode id (no native SDK).
    if (bridgeEnabled()) {
      for (const hop of plan) expect(hop.id.startsWith("opencode/")).toBe(true);
    }
  });

  it("tiers Fable/Sol above Opus above Sonnet", () => {
    expect(fallbackTier("claude-fable-5")).toBeGreaterThan(fallbackTier("claude-opus-4-8"));
    expect(fallbackTier(sol)).toBeGreaterThan(fallbackTier("claude-opus-4-8"));
    expect(fallbackTier("claude-opus-4-8")).toBeGreaterThan(fallbackTier("claude-sonnet-5"));
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
