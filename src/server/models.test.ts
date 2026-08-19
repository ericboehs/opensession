import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BEST_AVAILABLE_CODEX_MODEL,
  accountProviderForModel,
  modelEngineKey,
  modelSupportsSteer,
  directModelLabel,
  explicitEngineFor,
  modelLabel,
  routeModel,
  DIAL_ORACLE_AGENTS,
  DIAL_PRESETS,
  dialPreset,
  sameBridgeDialOracle,
  ORCHESTRATOR_PRESETS,
  ORCHESTRATOR_WORKER_AGENTS,
  orchestratorPreset,
  orchestratorWorkerForBridge,
  modelPreset,
  fallbackPlan,
  fallbackTier,
  nextFallbackModel,
  modelEfforts,
  interactiveDefaultModel,
  interactiveFallbackModel,
  KNOWN_MODELS,
  normalizeModelEffort,
  opencodeModelLabel,
  piModelLabel,
  providerFor,
  resolveConcreteModel,
  resolveModel,
  toOpencodeModel,
  toPiModel,
} from "./models";

const savedModel = process.env.OPENSESSION_MODEL;
const savedHome = process.env.HOME;
afterEach(() => {
  if (savedModel === undefined) delete process.env.OPENSESSION_MODEL;
  else process.env.OPENSESSION_MODEL = savedModel;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe("opencodeModelLabel", () => {
  it("gives opencode ids first-class friendly names — never the engine", () => {
    expect(opencodeModelLabel("opencode/anthropic/claude-sonnet-5")).toBe("Sonnet 5");
    expect(opencodeModelLabel("opencode/anthropic/claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(opencodeModelLabel("opencode/anthropic/claude-opus-4-8")).toBe("Opus 4.8");
    expect(opencodeModelLabel("opencode/anthropic/claude-fable-5")).toBe("Fable 5");
    expect(opencodeModelLabel("opencode/openai/gpt-5.5")).toBe("GPT-5.5");
    expect(opencodeModelLabel("opencode/openai/gpt-5.4-mini")).toBe("GPT-5.4 mini");
    expect(opencodeModelLabel("opencode/openai/gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(opencodeModelLabel("opencode/openai/gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(opencodeModelLabel("opencode/openai/gpt-5.6-luna")).toBe("GPT-5.6 Luna");
  });

  it("prettifies slugs with no native registry entry to borrow from", () => {
    expect(opencodeModelLabel("opencode/anthropic/claude-sonnet-6")).toBe("Sonnet 6");
    expect(opencodeModelLabel("opencode/openai/gpt-6")).toBe("GPT-6");
    expect(opencodeModelLabel("opencode/cerebras/zai-glm-4.7")).toBe("Z.ai GLM-4.7");
    expect(opencodeModelLabel("opencode/example/glm-5.3")).toBe("GLM-5.3");
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
    expect(toOpencodeModel("gpt-5.6-terra")).toBe("opencode/openai/gpt-5.6-terra");
    expect(toOpencodeModel(BEST_AVAILABLE_CODEX_MODEL)).toBe("opencode/openai/gpt-5.6-sol");
  });
  it("reroutes retired 272k-window codex models to a 5.6 model in every id shape", () => {
    expect(toOpencodeModel("gpt-5.5")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("gpt-5.4")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("gpt-5.4-mini")).toBe("opencode/openai/gpt-5.6-luna");
    expect(toOpencodeModel("gpt-5.3-codex-spark")).toBe("opencode/openai/gpt-5.6-luna");
    expect(toOpencodeModel("openai/gpt-5.5")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("opencode/openai/gpt-5.5")).toBe("opencode/openai/gpt-5.6-sol");
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
  it("maps claude tiers onto the single opencode engine", () => {
    expect(toOpencodeModel("claude-fable-5")).toBe(
      "opencode/anthropic/claude-fable-5",
    );
  });
});

describe("pi engine model routing", () => {
  it("resolves explicit pi/<provider>/<model> ids to the pi provider", () => {
    const m = resolveModel("pi/anthropic/claude-opus-5");
    expect(m?.id).toBe("pi/anthropic/claude-opus-5");
    expect(m?.provider).toBe("pi");
    expect(resolveModel("PI/Anthropic/Claude-Opus-5")?.id).toBe(
      "pi/anthropic/claude-opus-5"
    );
    expect(providerFor("pi/anthropic/claude-opus-5")).toBe("pi");
  });

  it("rejects truncated pi ids instead of minting a bogus opencode passthrough", () => {
    expect(resolveModel("pi/anthropic")).toBeNull();
    expect(resolveModel("pi/")).toBeNull();
  });

  it("never maps pi ids onto the opencode engine", () => {
    expect(toOpencodeModel("pi/anthropic/claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5"
    );
  });

  it("draws pi/anthropic from the claude account pool (the bridge's pool)", () => {
    expect(accountProviderForModel("pi/anthropic/claude-opus-5")).toBe("claude");
  });

  it("exposes the anthropic effort variants on pi/anthropic ids", () => {
    expect(modelEfforts("pi/anthropic/claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(modelEfforts("pi/anthropic/claude-haiku-4-5")).toEqual(["high", "max"]);
    expect(normalizeModelEffort("pi/anthropic/claude-haiku-4-5", "low")).toBe("high");
  });

  it("labels pi ids with the engine kept visible", () => {
    expect(piModelLabel("pi/anthropic/claude-opus-5")).toBe("Pi · Claude Opus 5");
    expect(piModelLabel("pi/anthropic/claude-sonnet-6")).toBe("Pi · Sonnet 6");
  });

  it("tiers pi ids by their native model for the fallback walk", () => {
    expect(fallbackTier("pi/anthropic/claude-opus-5")).toBe(
      fallbackTier("claude-opus-5")
    );
  });

  it("resolves pi/openai ids to the pi provider on the codex pool with openai efforts", () => {
    const m = resolveModel("pi/openai/gpt-5.6-sol");
    expect(m?.id).toBe("pi/openai/gpt-5.6-sol");
    expect(m?.provider).toBe("pi");
    expect(providerFor("pi/openai/gpt-5.6-sol")).toBe("pi");
    // Account pinning draws from the codex (ChatGPT-subscription) pool, same
    // as opencode/openai.
    expect(accountProviderForModel("pi/openai/gpt-5.6-sol")).toBe("codex");
    expect(modelEfforts("pi/openai/gpt-5.6-sol")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(piModelLabel("pi/openai/gpt-5.6-sol")).toBe("Pi · GPT-5.6 Sol");
    expect(fallbackTier("pi/openai/gpt-5.6-sol")).toBe(fallbackTier("gpt-5.6-sol"));
  });

  it("reroutes retired codex slugs on pi ids too, preserving the engine prefix", () => {
    expect(toOpencodeModel("pi/openai/gpt-5.5")).toBe("pi/openai/gpt-5.6-sol");
    expect(toOpencodeModel("pi/openai/gpt-5.4")).toBe("pi/openai/gpt-5.6-sol");
    expect(toOpencodeModel("pi/openai/gpt-5.4-mini")).toBe("pi/openai/gpt-5.6-luna");
    expect(toOpencodeModel("pi/openai/gpt-5.3-codex-spark")).toBe(
      "pi/openai/gpt-5.6-luna"
    );
    // Non-retired and non-openai pi ids stay untouched.
    expect(toOpencodeModel("pi/openai/gpt-5.6-sol")).toBe("pi/openai/gpt-5.6-sol");
    expect(toOpencodeModel("pi/anthropic/claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5"
    );
  });

  it("never registers pi entries: the model list is engine-agnostic", () => {
    expect(KNOWN_MODELS.some((m) => m.provider === "pi")).toBe(false);
  });

  it("resolves pi-routed preset ids to their preset", () => {
    expect(dialPreset("pi/dial/opus-fable")?.id).toBe("dial/opus-fable");
    expect(modelPreset("pi/dial/ultra")?.id).toBe("dial/ultra");
    const orch = ORCHESTRATOR_PRESETS[0];
    expect(orchestratorPreset(`pi/${orch.id}`)?.id).toBe(orch.id);
    expect(piModelLabel("pi/dial/opus-fable")).toBe("Pi · Opus 5 + Fable oracle");
    expect(toPiModel("opencode/anthropic/claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5",
    );
    expect(toPiModel("dial/opus-fable")).toBe("pi/anthropic/claude-opus-5");
    expect(toPiModel(ORCHESTRATOR_PRESETS[0].id)).toBe(
      "pi/anthropic/claude-fable-5",
    );
  });
});

describe("legacy direct-engine ids (claude/ and codex/)", () => {
  // The direct-SDK engines are removed. Their prefixes survive in stored
  // sessions and modelHistory, so they must keep RESOLVING — onto the
  // opencode engine, same upstream model — rather than going null (which
  // would degrade a legacy session to the default model) or routing to a
  // dead engine.
  it("normalizes a legacy claude/<vendor>/<model> id onto opencode", () => {
    const m = resolveModel("claude/anthropic/claude-opus-5");
    expect(m?.id).toBe("opencode/anthropic/claude-opus-5");
    expect(m?.provider).toBe("opencode");
    expect(resolveModel("CLAUDE/Anthropic/Claude-Opus-5")?.id).toBe(
      "opencode/anthropic/claude-opus-5"
    );
    expect(providerFor("claude/anthropic/claude-opus-5")).toBe("opencode");
    expect(toOpencodeModel("claude/anthropic/claude-opus-5")).toBe(
      "opencode/anthropic/claude-opus-5"
    );
  });

  it("normalizes a legacy codex/<vendor>/<model> id onto opencode", () => {
    const m = resolveModel("codex/openai/gpt-5.6-sol");
    expect(m?.id).toBe("opencode/openai/gpt-5.6-sol");
    expect(m?.provider).toBe("opencode");
    expect(toOpencodeModel("codex/openai/gpt-5.6-sol")).toBe(
      "opencode/openai/gpt-5.6-sol"
    );
  });

  it("normalizes a legacy preset-routed id onto the preset itself", () => {
    // The vendor scoping died with the engines: what matters now is that the
    // id under the prefix resolves, whatever vendor it names.
    expect(resolveModel("claude/orchestrator/fable")?.id).toBe("orchestrator/fable");
    expect(resolveModel("claude/orchestrator/not-real")).toBeNull();
  });

  it("still rejects truncated ids instead of minting a bogus passthrough", () => {
    expect(resolveModel("claude/anthropic")).toBeNull();
    expect(resolveModel("codex/openai")).toBeNull();
    expect(resolveModel("claude/")).toBeNull();
    // A bare native id is still the native model, not an engine id.
    expect(resolveModel("claude-opus-5")?.id).toBe("claude-opus-5");
    // A workspace-preset id under a legacy prefix resolves exactly as the
    // bare id does (the opencode engine resolves the preset at dispatch).
    expect(resolveModel("claude/workspace-preset/ws-x/nope")?.id).toBe(
      resolveModel("workspace-preset/ws-x/nope")?.id
    );
  });

  it("applies the retired-codex reroute under the legacy prefix", () => {
    expect(toOpencodeModel("codex/openai/gpt-5.5")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("codex/openai/gpt-5.4-mini")).toBe(
      "opencode/openai/gpt-5.6-luna"
    );
  });

  it("keeps the shared bookkeeping working on legacy ids", () => {
    expect(accountProviderForModel("claude/anthropic/claude-opus-5")).toBe("claude");
    expect(accountProviderForModel("codex/openai/gpt-5.6-sol")).toBe("codex");
    expect(modelEfforts("claude/anthropic/claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(normalizeModelEffort("claude/anthropic/claude-haiku-4-5", "low")).toBe("high");
    expect(fallbackTier("claude/anthropic/claude-opus-5")).toBe(
      fallbackTier("claude-opus-5")
    );
    expect(fallbackTier("codex/openai/gpt-5.6-sol")).toBe(fallbackTier("gpt-5.6-sol"));
    expect(modelSupportsSteer("claude/anthropic/claude-opus-5")).toBe(true);
    expect(modelSupportsSteer("codex/openai/gpt-5.6-sol")).toBe(true);
  });

  it("labels legacy ids with the engine kept visible, for stored history", () => {
    expect(directModelLabel("claude/anthropic/claude-opus-5")).toBe(
      "Claude · Claude Opus 5"
    );
    expect(directModelLabel("codex/openai/gpt-5.6-sol")).toBe("Codex · GPT-5.6 Sol");
    expect(modelLabel("claude/anthropic/claude-opus-5")).toBe("Claude · Claude Opus 5");
  });

  it("never registers direct entries: the model list stays engine-agnostic", () => {
    expect(
      KNOWN_MODELS.some((m) => m.id.startsWith("claude/") || m.id.startsWith("codex/"))
    ).toBe(false);
  });
});

describe("routeModel (engine resolution order)", () => {
  // Point the engines config at a scratch file so the host's real one (and
  // any other session's) can't decide these assertions.
  let dir = "";
  const savedConfig = process.env.OPENSESSION_ENGINES_CONFIG;
  const savedFlag = process.env.OPENSESSION_ENGINE_CLAUDE_DIRECT;
  const writeConfig = (raw: unknown) => {
    writeFileSync(join(dir, "engines.json"), JSON.stringify(raw));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "os-engines-"));
    process.env.OPENSESSION_ENGINES_CONFIG = join(dir, "engines.json");
    delete process.env.OPENSESSION_ENGINE_CLAUDE_DIRECT;
  });
  afterEach(() => {
    if (savedConfig === undefined) delete process.env.OPENSESSION_ENGINES_CONFIG;
    else process.env.OPENSESSION_ENGINES_CONFIG = savedConfig;
    if (savedFlag === undefined) delete process.env.OPENSESSION_ENGINE_CLAUDE_DIRECT;
    else process.env.OPENSESSION_ENGINE_CLAUDE_DIRECT = savedFlag;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to opencode with no prefix and no per-model default", () => {
    expect(routeModel("claude-opus-5")).toEqual({
      engine: "opencode",
      model: "opencode/anthropic/claude-opus-5",
    });
    expect(routeModel("opencode/openai/gpt-5.6-sol", { interactive: true })).toEqual({
      engine: "opencode",
      model: "opencode/openai/gpt-5.6-sol",
    });
  });

  it("honors an explicit engine prefix over everything else", () => {
    writeConfig({ modelEngines: { "claude-opus-5": "opencode" } });
    expect(routeModel("pi/anthropic/claude-opus-5", { interactive: true })).toEqual({
      engine: "pi",
      model: "pi/anthropic/claude-opus-5",
    });
    // The removed direct engines' legacy prefixes are NOT an engine choice
    // anymore: they normalize onto opencode instead of routing to a dead
    // engine.
    expect(routeModel("claude/anthropic/claude-opus-5")).toEqual({
      engine: "opencode",
      model: "opencode/anthropic/claude-opus-5",
    });
    expect(routeModel("codex/openai/gpt-5.6-sol")).toEqual({
      engine: "opencode",
      model: "opencode/openai/gpt-5.6-sol",
    });
  });

  it("applies the per-model default engine for interactive runs only", () => {
    writeConfig({
      modelEngines: { "claude-opus-5": "pi" },
    });
    expect(routeModel("opencode/anthropic/claude-opus-5", { interactive: true })).toEqual({
      engine: "pi",
      model: "pi/anthropic/claude-opus-5",
    });
    // Automations and agent loops stay on their current routing this phase.
    expect(routeModel("opencode/anthropic/claude-opus-5").engine).toBe("opencode");
  });

  it("fails soft on a stale default naming a removed engine", () => {
    // A modelEngines entry left over from the removed direct engines is
    // dropped by normalization, and the run stays on opencode.
    writeConfig({
      claude: { enabled: true },
      modelEngines: { "claude-opus-5": "claude", "gpt-5.6-sol": "codex" },
    });
    expect(routeModel("opencode/anthropic/claude-opus-5", { interactive: true })).toEqual({
      engine: "opencode",
      model: "opencode/anthropic/claude-opus-5",
    });
    expect(routeModel("opencode/openai/gpt-5.6-sol", { interactive: true }).engine).toBe(
      "opencode"
    );
  });

  it("keys the default map by the engine-stripped base id", () => {
    // Same key shape the UI writes (frontend lib/model-engine.ts): the bare
    // model slug, or the whole preset id.
    expect(modelEngineKey("opencode/anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(modelEngineKey("claude/anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(modelEngineKey("codex/openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(modelEngineKey("pi/dial/ultra")).toBe("dial/ultra");
    expect(modelEngineKey("claude/dial/opus-fable")).toBe("dial/opus-fable");
    expect(modelEngineKey("claude-opus-5")).toBe("claude-opus-5");
    // Legacy prefixes are no longer an explicit engine choice.
    expect(explicitEngineFor("claude/anthropic/claude-opus-5")).toBeNull();
    expect(explicitEngineFor("pi/anthropic/claude-opus-5")).toBe("pi");
    expect(explicitEngineFor("claude-opus-5")).toBeNull();
    expect(explicitEngineFor("anthropic/claude-opus-5")).toBeNull();
  });
});

describe("accountProviderForModel", () => {
  it("resolves legacy, provider-path, and preset model ids to their account pool", () => {
    expect(accountProviderForModel("claude-fable-5")).toBe("claude");
    expect(accountProviderForModel("anthropic/claude-sonnet-5")).toBe("claude");
    expect(accountProviderForModel("gpt-5.6-sol")).toBe("codex");
    expect(accountProviderForModel("openai/gpt-5.5")).toBe("codex");
    expect(accountProviderForModel("dial/ultra")).toBe("claude");
    expect(accountProviderForModel("dial/high")).toBe("codex");
    // Pi-routed forms hit the same pools: the engine prefix is routing only.
    expect(accountProviderForModel("pi/dial/ultra")).toBe("claude");
    expect(accountProviderForModel("pi/dial/high")).toBe("codex");
    expect(accountProviderForModel("pi/anthropic/claude-opus-5")).toBe("claude");
  });

  it("does not expose account pinning for unrelated providers", () => {
    expect(accountProviderForModel("opencode/xai/grok-4.5")).toBeUndefined();
  });
});


describe("The Dial", () => {
  it("resolves preset ids without minting a bogus opencode/dial passthrough", () => {
    const high = resolveModel("dial/high");
    expect(high?.id).toBe("dial/high");
    expect(high?.provider).toBe("opencode");
    expect(high?.group).toBe("dial");
    expect(resolveModel("DIAL/HIGH")?.id).toBe("dial/high");
    expect(resolveModel("dial/nonsense")).toBeNull();
  });

  it("maps a dial id to its MAIN model at dispatch", () => {
    // dial/high's main model is Sol (openai) — maps regardless of bridge state.
    expect(toOpencodeModel("dial/high")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("dial/nonsense")).toBeUndefined();
  });

  it("bakes effort into the preset — no selectable efforts on dial ids", () => {
    expect(modelEfforts("dial/high")).toEqual([]);
    expect(normalizeModelEffort("dial/high", "low")).toBeUndefined();
  });

  it("looks up presets case-insensitively via dialPreset", () => {
    expect(dialPreset("dial/ultra")?.oracleAgent).toBe("oracle-sol");
    expect(dialPreset("dial/high")?.oracleAgent).toBe("oracle-fable");
    expect(dialPreset("opencode/openai/gpt-5.6-sol")).toBeUndefined();
    expect(dialPreset(undefined)).toBeUndefined();
  });

  it("wires each tier to its intended main and oracle model effort", () => {
    expect(
      DIAL_PRESETS.map(({ id, model, effort, oracleAgent }) => ({ id, model, effort, oracleAgent }))
    ).toEqual([
      {
        id: "dial/ultra",
        model: "claude-fable-5",
        effort: "high",
        oracleAgent: "oracle-sol",
      },
      {
        id: "dial/high",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        oracleAgent: "oracle-fable",
      },
      {
        id: "dial/medium",
        model: "gpt-5.6-sol",
        effort: "high",
        oracleAgent: "oracle-sol",
      },
      {
        id: "dial/low",
        model: "gpt-5.6-luna",
        effort: "high",
        oracleAgent: "oracle-sol",
      },
      {
        id: "dial/opus-fable",
        model: "claude-opus-5",
        effort: "xhigh",
        oracleAgent: "oracle-fable",
      },
    ]);
    expect(DIAL_ORACLE_AGENTS["oracle-sol"]?.variant).toBe("xhigh");
    expect(DIAL_ORACLE_AGENTS["oracle-fable"]?.variant).toBe("high");
  });

  it("defines every preset's oracle agent and a valid main model + effort", () => {
    for (const p of DIAL_PRESETS) {
      expect(DIAL_ORACLE_AGENTS[p.oracleAgent]).toBeDefined();
      // The preset's effort must be one its main model actually supports
      // (modelEfforts infers the provider from bare claude-*/gpt-* slugs).
      expect(modelEfforts(p.model)).toContain(p.effort);
      expect(resolveModel(p.model)).not.toBeNull();
    }
  });
});

describe("The Orchestrator", () => {
  it("resolves preset ids without minting a bogus opencode/orchestrator passthrough", () => {
    const fable = resolveModel("orchestrator/fable");
    expect(fable?.id).toBe("orchestrator/fable");
    expect(fable?.provider).toBe("opencode");
    expect(fable?.group).toBe("orchestrator");
    expect(resolveModel("ORCHESTRATOR/FABLE")?.id).toBe("orchestrator/fable");
    expect(resolveModel("orchestrator/nonsense")).toBeNull();
  });

  it("maps an orchestrator id to its MAIN model at dispatch", () => {
    expect(toOpencodeModel("orchestrator/sol")).toBe("opencode/openai/gpt-5.6-sol");
    expect(toOpencodeModel("orchestrator/nonsense")).toBeUndefined();
  });

  it("bakes effort into the preset — no selectable efforts on orchestrator ids", () => {
    expect(modelEfforts("orchestrator/fable")).toEqual([]);
    expect(normalizeModelEffort("orchestrator/fable", "low")).toBeUndefined();
  });

  it("looks up presets case-insensitively and via the shared modelPreset guard", () => {
    expect(orchestratorPreset("orchestrator/fable")?.model).toBe("claude-fable-5");
    expect(orchestratorPreset("opencode/anthropic/claude-fable-5")).toBeUndefined();
    expect(orchestratorPreset(undefined)).toBeUndefined();
    expect(modelPreset("orchestrator/sol")?.id).toBe("orchestrator/sol");
    expect(modelPreset("dial/high")?.id).toBe("dial/high");
    expect(modelPreset("claude-fable-5")).toBeUndefined();
  });

  it("defines every preset's workers on both bridges with valid models + efforts", () => {
    for (const p of ORCHESTRATOR_PRESETS) {
      expect(modelEfforts(p.model)).toContain(p.effort);
      expect(resolveModel(p.model)).not.toBeNull();
      for (const name of p.workerAgents) {
        const w = ORCHESTRATOR_WORKER_AGENTS[name];
        expect(w).toBeDefined();
        // A server carries ONE bridge's auth: every worker NAME must resolve
        // on both subscription bridges, to a model that supports its variant.
        for (const bridge of ["anthropic", "openai"]) {
          const b = orchestratorWorkerForBridge(name, bridge, new Set());
          expect(b).toBeDefined();
          expect(b!.model.startsWith(`${bridge}/`)).toBe(true);
          expect(modelEfforts(b!.model)).toContain(b!.variant);
        }
      }
    }
    // Unknown/third-party bridges keep the oracle status quo: fall back to a
    // defined backing instead of undefined.
    expect(orchestratorWorkerForBridge("worker", "xai")).toBeDefined();
    expect(orchestratorWorkerForBridge("no-such-worker", "anthropic")).toBeUndefined();
  });

  it("keeps every worker strictly cheaper than its preset's main (tier or effort)", () => {
    // With the 272k codex models retired the openai bridge has no cheaper
    // model TIER — its cheap workers are the same-tier 5.6 siblings
    // (Terra/Luna) at a LOWER effort variant.
    const effortRank: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
    for (const p of ORCHESTRATOR_PRESETS) {
      // Workers resolve on the MAIN model's bridge in prod — that's the only
      // pairing the cheapness invariant is about.
      const mainProviderID = p.model.startsWith("claude-") ? "anthropic" : "openai";
      for (const name of p.workerAgents) {
        const b = orchestratorWorkerForBridge(name, mainProviderID)!;
        // fallbackTier keys off native slugs — strip the bridge prefix.
        const workerTier = fallbackTier(b.model.split("/").pop());
        const mainTier = fallbackTier(p.model);
        const cheaper =
          workerTier < mainTier ||
          (workerTier === mainTier && effortRank[b.variant] < effortRank[p.effort]);
        expect(cheaper).toBe(true);
      }
    }
  });
});

describe("fallback graph (nextFallbackModel)", () => {
  // Sol is openai → always maps regardless of the anthropic bridge flag; the
  // claude ids adapt to bridge state via toOpencodeModel so the assertions hold
  // whether the bridge is on or off.
  const sol = "opencode/openai/gpt-5.6-sol";
  const terra = "opencode/openai/gpt-5.6-terra";
  const luna = "opencode/openai/gpt-5.6-luna";
  const opus = toOpencodeModel("claude-opus-5")!;
  const fable = toOpencodeModel("claude-fable-5")!;
  const sonnet = toOpencodeModel("claude-sonnet-5")!;

  it("keeps equal-or-smarter switches automatic, downgrades ask (configured policy)", () => {
    // Fable → Sol: equal tier, automatic.
    expect(nextFallbackModel(fable, new Set([fable]), "claude-opus-5")).toEqual({
      id: sol,
      mode: "auto",
    });
    // Fable, Sol gone → Opus: next top-tier destination, automatic.
    expect(
      nextFallbackModel(fable, new Set([fable, sol]), "claude-opus-5")
    ).toEqual({ id: opus, mode: "auto" });
    // Fable, Sol, and Opus gone → Terra: same-tier sibling, automatic.
    expect(
      nextFallbackModel(fable, new Set([fable, sol, opus]), "claude-opus-5")
    ).toEqual({ id: terra, mode: "auto" });
    // Opus → Sol: same tier, automatic.
    expect(nextFallbackModel(opus, new Set([opus]), "claude-opus-5")).toEqual({
      id: sol,
      mode: "auto",
    });
    // Opus + every 5.6 gone → Sonnet next (5.5/5.4/spark are retired, no
    // longer destinations): downgrade, ASK.
    expect(
      nextFallbackModel(opus, new Set([opus, sol, terra, luna]), "claude-opus-5")
    ).toEqual({ id: sonnet, mode: "ask" });
    // Sol → Opus: preferred top-tier destination, automatic.
    expect(nextFallbackModel(sol, new Set([sol]), "claude-opus-5")).toEqual({
      id: opus,
      mode: "auto",
    });
    // Sol + Opus gone → Terra: same-tier sibling, automatic.
    expect(
      nextFallbackModel(sol, new Set([sol, opus]), "claude-opus-5")
    ).toEqual({ id: terra, mode: "auto" });
  });

  it("never routes back into Fable (scarce weekly-scoped credit pool)", () => {
    const plan = fallbackPlan("claude-opus-5", "claude-opus-5");
    expect(plan.map((h) => h.id)).not.toContain(fable);
  });

  it("returns no plan when no fallback is configured / disabled", () => {
    expect(fallbackPlan("claude-fable-5", undefined)).toEqual([]);
    expect(fallbackPlan("claude-fable-5", "none")).toEqual([]);
  });

  it("orders Fable fallbacks as Sol, Opus, Terra, then Luna", () => {
    const plan = fallbackPlan("claude-fable-5", "claude-opus-5");
    expect(plan.slice(0, 4)).toEqual([
      { id: sol, mode: "auto" },
      { id: opus, mode: "auto" },
      { id: terra, mode: "auto" },
      { id: luna, mode: "auto" },
    ]);
    // The single-engine fallback graph always emits OpenCode ids.
    for (const hop of plan) expect(hop.id.startsWith("opencode/")).toBe(true);
  });

  it("tiers Fable, Sol, and Opus above Sonnet", () => {
    expect(fallbackTier("claude-fable-5")).toBe(fallbackTier("claude-opus-5"));
    expect(fallbackTier(sol)).toBe(fallbackTier("claude-opus-5"));
    expect(fallbackTier("claude-opus-5")).toBeGreaterThan(fallbackTier("claude-sonnet-5"));
  });
});

describe("sameBridgeDialOracle", () => {
  it("keeps same-bridge oracles and substitutes cross-bridge ones", () => {
    // dial/medium: sol main, sol oracle — same bridge, unchanged.
    expect(sameBridgeDialOracle("oracle-sol", "openai")).toBe("oracle-sol");
    // dial/high: sol main (openai server), fable oracle → Terra substitute.
    expect(sameBridgeDialOracle("oracle-fable", "openai")).toBe("oracle-terra");
    // dial/ultra: fable main (anthropic server), sol oracle → Opus substitute.
    expect(sameBridgeDialOracle("oracle-sol", "anthropic")).toBe("oracle-opus");
    // Fable oracle on an anthropic server stays.
    expect(sameBridgeDialOracle("oracle-fable", "anthropic")).toBe("oracle-fable");
    // Unknown provider or agent: status quo.
    expect(sameBridgeDialOracle("oracle-sol", "google")).toBe("oracle-sol");
    expect(sameBridgeDialOracle("nonexistent", "openai")).toBe("nonexistent");
  });
});

describe("alias table (pinned)", () => {
  // PINNED: what users get when they type these. A change here silently
  // redirects /model shortcuts and default-codex dispatch — deliberate only
  // (last deliberate change: codex/gpt → 5.6-sol).
  it("resolves the load-bearing aliases", () => {
    expect(resolveModel("codex")?.id).toBe("gpt-5.6-sol");
    expect(resolveModel("gpt")?.id).toBe("gpt-5.6-sol");
    expect(resolveModel("sol")?.id).toBe("gpt-5.6-sol");
    expect(resolveModel("best")?.id).toBe("codex-best-available");
    expect(resolveModel("opus")?.id).toBe("claude-opus-5");
    expect(resolveModel("opus4.8")?.id).toBe("claude-opus-4-8");
    expect(resolveModel("fable")?.id).toBe("claude-fable-5");
  });
});

describe("resolveConcreteModel", () => {
  it("resolves best available codex to the strongest usable codex model", () => {
    expect(resolveConcreteModel(BEST_AVAILABLE_CODEX_MODEL)).toBe("gpt-5.6-sol");
  });
});
