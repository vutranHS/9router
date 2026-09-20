import { describe, expect, it } from "vitest";
import { calculateCostFromTokens, getPricingForModel, MODEL_PRICING, PROVIDER_PRICING } from "../../open-sse/providers/pricing.js";

describe("Astra and Fable Standard short-context prices", () => {
  it.each([
    ["gpt-6-astra", 1],
    ["claude-fable-5", 1],
    ["claude-fable-5-1", 0.25],
  ])("uses the verified rates for %s", (model, cached) => {
    const pricing = getPricingForModel(null, model);
    expect(pricing).toEqual({ input: 10, output: 50, cached, reasoning: 50, cache_creation: 12.5 });
    // Canonical prompt count includes both cache reads and cache writes.
    expect(calculateCostFromTokens({ prompt_tokens: 1000, cached_tokens: 300,
      cache_creation_input_tokens: 200, completion_tokens: 100 }, pricing))
      .toBeCloseTo((500 * 10 + 300 * cached + 200 * 12.5 + 100 * 50) / 1e6, 12);
  });

  it.each([
    ["openai/gpt-6-astra", "gpt-6-astra"],
    ["gpt-6-astra-high", "gpt-6-astra"],
    ["gpt-6-astra-2026-09-01", "gpt-6-astra"],
    ["anthropic/claude-fable-5", "claude-fable-5"],
    ["claude-fable-5-thinking", "claude-fable-5"],
    ["anthropic/claude-fable-5-1", "claude-fable-5-1"],
    ["claude-fable-5-1-thinking", "claude-fable-5-1"],
    ["claude-fable-5.1", "claude-fable-5-1"],
    ["claude-fable-5.1-thinking", "claude-fable-5-1"],
  ])("resolves %s without falling into generic Claude pricing", (alias, canonical) => {
    expect(getPricingForModel(null, alias)).toBe(MODEL_PRICING[canonical]);
  });

  it("preserves every provider-specific price override", () => {
    for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
      for (const [model, price] of Object.entries(models)) {
        expect(getPricingForModel(provider, model)).toBe(price);
      }
    }
  });
});
