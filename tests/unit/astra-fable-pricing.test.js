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

  // reasoning_tokens is a SUBSET of completion_tokens, so it must be billed
  // by splitting the output total, never by adding a second charge on top.
  // Adding it overcharged Astra ~57% on a typical reasoning-heavy request.
  it.each([
    ["gpt-6-astra", 10, 50],
    ["claude-fable-5", 10, 50],
    ["claude-fable-5-1", 10, 50],
  ])("bills %s reasoning tokens inside output, not on top", (model, input, output) => {
    const pricing = getPricingForModel(null, model);
    const withReasoning = calculateCostFromTokens(
      { prompt_tokens: 10000, completion_tokens: 5000, reasoning_tokens: 4000 }, pricing);
    // reasoning === output rate for these models, so the total must not move.
    expect(withReasoning).toBeCloseTo((10000 * input + 5000 * output) / 1e6, 12);
    expect(withReasoning).toBeCloseTo(
      calculateCostFromTokens({ prompt_tokens: 10000, completion_tokens: 5000 }, pricing), 12);
  });

  it("splits output at the reasoning rate when the two rates differ", () => {
    const pricing = getPricingForModel(null, "gemini-3.8-flash"); // output 7.50, reasoning 11.25
    expect(calculateCostFromTokens(
      { prompt_tokens: 0, completion_tokens: 1000, reasoning_tokens: 400 }, pricing))
      .toBeCloseTo((600 * pricing.output + 400 * pricing.reasoning) / 1e6, 12);
  });

  it("clamps a reasoning count larger than the output total", () => {
    const pricing = getPricingForModel(null, "gpt-6-astra");
    expect(calculateCostFromTokens(
      { prompt_tokens: 0, completion_tokens: 100, reasoning_tokens: 99999 }, pricing))
      .toBeCloseTo(100 * pricing.reasoning / 1e6, 12);
  });

  it("preserves every provider-specific price override", () => {
    for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
      for (const [model, price] of Object.entries(models)) {
        expect(getPricingForModel(provider, model)).toBe(price);
      }
    }
  });
});
