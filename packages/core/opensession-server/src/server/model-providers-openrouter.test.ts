import { describe, expect, test } from "bun:test";
import { OX_ALPHA_MODEL_ID, piProviderCatalog } from "./model-providers";
import { modelEfforts, piModelLabel } from "./models";

describe("OpenRouter model supplements", () => {
  test("catalogues Ox Alpha at its advertised limits", () => {
    const catalog = piProviderCatalog("openrouter");
    const model = catalog?.models.find((candidate) => candidate.id === OX_ALPHA_MODEL_ID);

    expect(catalog?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(model).toMatchObject({
      name: "Ox Alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 0, output: 0 },
    });
  });

  test("exposes the provider's supported reasoning efforts", () => {
    expect(piModelLabel(`pi/openrouter/${OX_ALPHA_MODEL_ID}`)).toBe("Ox Alpha");
    expect(modelEfforts(`pi/openrouter/${OX_ALPHA_MODEL_ID}`)).toEqual(["low", "high", "max"]);
  });
});
