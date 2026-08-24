import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountProviderForModel,
  explicitEngineFor,
  fallbackPlan,
  modelEngineKey,
  modelLabel,
  nextFallbackModel,
  resolveModel,
  routeModel,
  toPiModel,
  KNOWN_MODELS,
  refreshPickerModels,
} from "./models";

const originalPiConfig = process.env.OPENSESSION_PI_CONFIG;
let pickerConfigDir = "";
afterEach(() => {
  if (originalPiConfig === undefined) delete process.env.OPENSESSION_PI_CONFIG;
  else process.env.OPENSESSION_PI_CONFIG = originalPiConfig;
  refreshPickerModels();
  if (pickerConfigDir) rmSync(pickerConfigDir, { recursive: true, force: true });
  pickerConfigDir = "";
});

describe("Pi-only model routing", () => {
  test("maps native model ids to Pi", () => {
    expect(toPiModel("claude-opus-5")).toBe("pi/anthropic/claude-opus-5");
    expect(toPiModel("gpt-5.6-sol")).toBe("pi/openai/gpt-5.6-sol");
  });

  test("preserves explicit Pi ids", () => {
    expect(toPiModel("pi/wafer/glm-5.2")).toBe("pi/wafer/glm-5.2");
    expect(explicitEngineFor("pi/openai/gpt-5.6-sol")).toBe("pi");
  });

  test("reroutes retired OpenAI slugs", () => {
    expect(toPiModel("gpt-5.5")).toBe("pi/openai/gpt-5.6-sol");
    expect(toPiModel("openai/gpt-5.5")).toBe("pi/openai/gpt-5.6-sol");
    expect(toPiModel("pi/openai/gpt-5.4-mini")).toBe("pi/openai/gpt-5.6-luna");
    expect(resolveModel("gpt5.5")?.id).toBe("gpt-5.6-sol");
    expect(resolveModel("pi/openai/gpt-5.5")?.id).toBe(
      "pi/openai/gpt-5.6-sol",
    );
  });

  test("routes every accepted id to Pi", () => {
    expect(routeModel("claude-fable-5")).toEqual({
      engine: "pi",
      model: "pi/anthropic/claude-fable-5",
    });
    expect(routeModel("openai/gpt-5.6-sol")).toEqual({
      engine: "pi",
      model: "pi/openai/gpt-5.6-sol",
    });
  });

  test("resolves provider paths and Pi ids", () => {
    expect(resolveModel("pi/anthropic/claude-opus-5")?.provider).toBe("pi");
    expect(resolveModel("wafer/glm-5.2")?.id).toBe("pi/wafer/glm-5.2");
  });

  test("selects the account pool from Pi's upstream provider", () => {
    expect(accountProviderForModel("pi/anthropic/claude-opus-5")).toBe("claude");
    expect(accountProviderForModel("pi/openai/gpt-5.6-sol")).toBe("codex");
    expect(accountProviderForModel("pi/wafer/glm-5.2")).toBeUndefined();
  });

  test("keeps engine keys provider-neutral", () => {
    expect(modelEngineKey("pi/anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(modelEngineKey("pi/dial/opus-fable")).toBe("dial/opus-fable");
  });

  test("builds a Pi-only fallback chain", () => {
    const first = nextFallbackModel(
      "pi/anthropic/claude-fable-5",
      new Set(),
      "pi/openai/gpt-5.6-sol",
    );
    expect(first?.id.startsWith("pi/")).toBe(true);
    expect(fallbackPlan("pi/anthropic/claude-fable-5", "pi/openai/gpt-5.6-sol"))
      .toSatisfy((hops) => hops.every((hop) => hop.id.startsWith("pi/")));
  });

  test("labels Pi models without an engine prefix", () => {
    expect(modelLabel("pi/openai/gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  });

  test("seeds subscription models without the retired pickerModels setting", () => {
    pickerConfigDir = mkdtempSync(join(tmpdir(), "pi-picker-models-"));
    const path = join(pickerConfigDir, "pi.json");
    writeFileSync(path, JSON.stringify({ enabled: true, pickerModels: [] }));
    process.env.OPENSESSION_PI_CONFIG = path;

    refreshPickerModels();

    const pickerIds = KNOWN_MODELS
      .filter((model) => model.provider === "pi")
      .map((model) => model.id);
    expect(pickerIds).toContain("pi/openai/gpt-5.6-sol");
    expect(pickerIds).toContain("pi/anthropic/claude-fable-5");
  });
});
