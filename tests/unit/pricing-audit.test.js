import { describe, expect, it, vi } from "vitest";
import { calculateCostFromTokens, getPricingForModel, MODEL_PRICING, PROVIDER_PRICING } from "../../open-sse/providers/pricing.js";
import { canonicalizeUsage, extractUsage } from "../../open-sse/utils/usageTracking.js";

vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ getAll: async () => ({ openai: { "gpt-6-astra": { input: 7, output: 17, cached: 0 } } }) }),
}));

// Official Standard text rates checked 2026-09-21. Source links live beside each family in pricing.js.
describe("verified model prices", () => {
  it.each([
    ["gpt-6-astra", 10, 50, 1, 12.5],
    ["gpt-5.6-sol", 4, 20, 0.4, 5],
    ["gpt-5.6-terra", 2, 12, 0.2, 2.5],
    ["gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
    ["gpt-5.5", 5, 30, 0.5, 5],
    ["gpt-5.4", 2.5, 15, 0.25, 2.5],
    ["gpt-5.4-mini", 0.75, 4.5, 0.075, 0.75],
    ["gpt-5.4-nano", 0.2, 1.25, 0.02, 0.2],
    ["gpt-5", 1.25, 10, 0.125, 1.25],
    ["gpt-5-mini", 0.25, 2, 0.025, 0.25],
    ["gpt-5.1", 1.25, 10, 0.125, 1.25],
    ["gpt-5-codex", 1.25, 10, 0.125, 1.25],
    ["gpt-5.1-codex-mini", 0.25, 2, 0.025, 0.25],
    ["gpt-5.1-codex-max", 1.25, 10, 0.125, 1.25],
    ["gpt-4.1", 2, 8, 0.5, 2],
    ["gpt-4.1-mini", 0.4, 1.6, 0.1, 0.4],
    ["gpt-4.1-nano", 0.1, 0.4, 0.025, 0.1],
    ["o1-mini", 1.1, 4.4, 0.55, 1.1],
    ["o3", 2, 8, 0.5, 2],
    ["o4-mini", 1.1, 4.4, 0.275, 1.1],
    ["gemini-3.8-flash", 0.75, 3.75, 0.075, 0.75],
    ["gemini-3.7-flash", 0.75, 3.75, 0.075, 0.75],
    ["gemini-3.6-flash", 0.75, 3.75, 0.075, 0.75],
    ["gemini-3.5-flash", 1.5, 9, 0.15, 1.5],
    ["gemini-3-flash-preview", 0.5, 3, 0.05, 0.5],
    ["gemini-3.1-pro-high", 2, 12, 0.2, 2],
    ["gemini-2.5-pro", 1.25, 10, 0.125, 1.25],
    ["gemini-2.5-flash-lite", 0.1, 0.4, 0.01, 0.1],
    ["kimi-k2.6", 0.95, 4, 0.16, 0.95],
    ["deepseek-v4-flash", 0.3, 1.2, 0.006, 0.3],
    ["deepseek-v4-pro", 1.32, 3.96, 0.044, 1.32],
    ["glm-4.6", 0.6, 2.2, 0.11, 0.6],
    ["glm-4.6v", 0.3, 0.9, 0.05, 0.3],
    ["glm-4.7", 0.6, 2.2, 0.11, 0.6],
    ["glm-5", 1, 3.2, 0.2, 1],
    ["glm-5.3", 1.4, 4.4, 0.26, 1.4],
    ["MiniMax-M2.1", 0.3, 1.2, 0.03, 0.375],
    ["MiniMax-M2.5", 0.3, 1.2, 0.03, 0.375],
    ["MiniMax-M2.7", 0.3, 1.2, 0.06, 0.375],
    ["grok-code-fast-1", 1, 2, 0.2, 1],
  ])("%s uses the verified rates", (model, input, output, cached, cache_creation) => {
    expect(getPricingForModel(null, model)).toMatchObject({ input, output, cached, cache_creation, reasoning: output });
  });

  it.each([
    ["openai/gpt-6-astra-high", "gpt-6-astra"],
    ["gpt-5.6-luna-2026-09-01", "gpt-5.6-luna"],
    ["gpt-5.6-sol-xhigh", "gpt-5.6-sol"],
    ["gpt-5.3-codex-xhigh", "gpt-5.3-codex"],
    ["gpt-5.1-codex-max-high", "gpt-5.1-codex-max"],
    ["gpt-5.1-codex-mini-medium", "gpt-5.1-codex-mini"],
    ["gpt-5-mini-2025-08-07", "gpt-5-mini"],
    ["gpt-4o-2024-08-06", "gpt-4o"],
    ["gpt-4o-mini-2024-07-18", "gpt-4o-mini"],
    ["o1-2024-12-17", "o1"],
    ["o3-mini-high", "o3-mini"],
    ["MINIMAX-M2.5", "MiniMax-M2.5"],
    ["gemini-3.8-flash-xhigh", "gemini-3.8-flash"],
    ["claude-opus-4-20250514-thinking", "claude-opus-4-20250514"],
    ["deepseek-v4-pro-0813", "deepseek-v4-pro"],
  ])("%s resolves to %s", (alias, model) => {
    expect(getPricingForModel(null, alias)).toEqual(MODEL_PRICING[model]);
  });

  it("retains differently priced historical snapshots", () => {
    expect(getPricingForModel(null, "gpt-4o-2024-05-13")).toMatchObject({ input: 5, output: 15 });
    expect(getPricingForModel(null, "gpt-3.5-turbo-1106")).toMatchObject({ input: 1, output: 2 });
    expect(getPricingForModel(null, "gpt-4")).toMatchObject({ input: 30, output: 60 });
  });

  it.each([
    ["gpt-6-astra", 272000, 10, 50, 20, 75],
    ["gpt-5.6-luna", 272000, 0.2, 1.2, 0.4, 1.8],
    ["gemini-2.5-pro", 200000, 1.25, 10, 2.5, 15],
    ["gemini-3.1-pro-high", 200000, 2, 12, 4, 18],
    ["MiniMax-M3", 512000, 0.3, 1.2, 0.6, 2.4],
    ["grok-code-fast-1", 199999, 1, 2, 2, 4],
  ])("%s applies the long-context boundary to the entire request", (model, limit, input, output, longInput, longOutput) => {
    const price = getPricingForModel(null, model);
    expect(calculateCostFromTokens({ prompt_tokens: limit, completion_tokens: 100 }, price))
      .toBeCloseTo((limit * input + 100 * output) / 1e6, 12);
    expect(calculateCostFromTokens({ prompt_tokens: limit + 1, completion_tokens: 100 }, price))
      .toBeCloseTo(((limit + 1) * longInput + 100 * longOutput) / 1e6, 12);
    expect(price.input).toBe(input);
  });

  it("counts cache reads/writes toward context length and bills each token once", () => {
    const price = getPricingForModel("cx", "gpt-6-astra");
    expect(calculateCostFromTokens({ prompt_tokens: 300000, cached_tokens: 200000,
      cache_creation_input_tokens: 90000, completion_tokens: 1000 }, price))
      .toBeCloseTo((10000 * 20 + 200000 * 2 + 90000 * 25 + 1000 * 75) / 1e6, 12);
  });

  it("does not charge OpenAI reasoning twice after usage normalization", () => {
    for (const event of [
      { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 80,
        output_tokens_details: { reasoning_tokens: 60 } } } },
      { usage: { prompt_tokens: 100, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 60 } } },
    ]) {
      const usage = canonicalizeUsage(extractUsage(event));
      expect(calculateCostFromTokens(usage, getPricingForModel("cx", "gpt-6-astra")))
        .toBeCloseTo((100 * 10 + 80 * 50) / 1e6, 12);
    }
    const gemini = canonicalizeUsage(extractUsage({ usageMetadata: {
      promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 60,
    } }));
    expect(calculateCostFromTokens(gemini, getPricingForModel(null, "gemini-3.8-flash")))
      .toBeCloseTo((100 * 0.75 + 80 * 3.75) / 1e6, 12);
  });

  it("keeps reseller and user prices ahead of canonical rates", async () => {
    for (const [model, price] of Object.entries(PROVIDER_PRICING.tokenrouter)) {
      expect(getPricingForModel("tokenrouter", model)).toBe(price);
    }
    const { getPricingForModel: getDbPricing } = await import("@/lib/db/repos/pricingRepo.js");
    const custom = await getDbPricing("openai", "gpt-6-astra");
    expect(custom).toEqual({ input: 7, output: 17, cached: 0 });
    expect(calculateCostFromTokens({ prompt_tokens: 300000, cached_tokens: 300000 }, custom)).toBe(0);
    expect(await getDbPricing("cx", "gpt-6-astra")).toBe(MODEL_PRICING["gpt-6-astra"]);
    expect(calculateCostFromTokens({ prompt_tokens: 100, completion_tokens: 100 }, getPricingForModel(null, "glm-4.7-flash"))).toBe(0);
  });
});
