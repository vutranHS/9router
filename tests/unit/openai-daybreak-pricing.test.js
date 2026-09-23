import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saveRequestUsage: vi.fn(async () => {}) }));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(),
}));
vi.mock("../../open-sse/utils/stream.js", () => ({ COLORS: {} }));

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import openaiProvider from "../../open-sse/providers/registry/openai.js";
import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";

const models = [
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
];

it("registers the current OpenAI models with their API limits", () => {
  expect(openaiProvider.models).toEqual(expect.arrayContaining([
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
  ]));
  for (const model of models) {
    expect(getCapabilitiesForModel("openai", model)).toMatchObject({
      vision: true,
      reasoning: true,
      search: true,
      thinkingFormat: "openai",
      contextWindow: 1050000,
      maxOutput: 128000,
    });
  }
});

it.each([
  ["gpt-5.5", [5, 0.5, null, 30], [10, 1, null, 45]],
  ["gpt-5.6-sol", [4, 0.4, 5, 20], [8, 0.8, 10, 30]],
  ["gpt-5.6-sol-fast", [8, 0.8, 10, 40], [16, 1.6, 20, 60]],
  ["gpt-5.6-terra", [2, 0.2, 2.5, 12], [4, 0.4, 5, 18]],
  ["gpt-5.6-terra-fast", [4, 0.4, 5, 24], [8, 0.8, 10, 36]],
  ["gpt-5.6-luna", [0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]],
  ["gpt-5.6-luna-fast", [0.4, 0.04, 0.5, 2.4], [0.8, 0.08, 1, 3.6]],
  ["gpt-6-astra", [10, 1, 12.5, 50], [20, 2, 25, 75]],
  ["gpt-6-astra-fast", [20, 2, 25, 100], [40, 4, 50, 150]],
  ["gpt-6-sol", [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]],
  ["gpt-6-sol-fast", [4, 0.4, 5, 20], [8, 0.8, 10, 30]],
  ["gpt-6-luna", [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]],
  ["gpt-6-luna-fast", [0.2, 0.02, 0.25, 1], [0.4, 0.04, 0.5, 1.5]],
])("switches all %s rates only above 272K input tokens", (model, short, long) => {
  const pricing = getPricingForModel("openai", model);
  const rateVector = (rates) => [rates.input, rates.cached, rates.cache_creation ?? null, rates.output];
  expect(rateVector(pricing)).toEqual(short);
  expect(rateVector(pricing.long_context)).toEqual(long);
  expect(calculateCostFromTokens({ prompt_tokens: 272000, completion_tokens: 1000 }, pricing))
    .toBeCloseTo((272000 * short[0] + 1000 * short[3]) / 1e6, 12);
  expect(calculateCostFromTokens({ prompt_tokens: 272001, completion_tokens: 1000 }, pricing))
    .toBeCloseTo((272001 * long[0] + 1000 * long[3]) / 1e6, 12);
});

it("uses the published GPT-5.5 Fast short-context price", () => {
  const pricing = getPricingForModel("openai", "gpt-5.5-fast");
  expect(pricing).toMatchObject({ input: 12.5, cached: 1.25, output: 75, reasoning: 75 });
  expect(pricing.long_context).toBeUndefined();
});

it("uses long-context rates for cached input, cache writes, and output too", () => {
  const pricing = getPricingForModel("openai", "gpt-6-sol");
  const tokens = {
    prompt_tokens: 272001,
    cached_tokens: 1000,
    cache_creation_input_tokens: 2000,
    completion_tokens: 1000,
  };
  expect(calculateCostFromTokens(tokens, pricing)).toBeCloseTo(
    (269001 * 4 + 1000 * 0.4 + 2000 * 5 + 1000 * 15) / 1e6,
    12,
  );
});

it.each(["fast", "priority"])("selects fast pricing for OpenAI service_tier: %s", (serviceTier) => {
  mocks.saveRequestUsage.mockClear();
  saveUsageStats({
    provider: "openai",
    model: "gpt-6-sol",
    tokens: { input_tokens: 10, output_tokens: 5 },
    requestBody: { service_tier: serviceTier },
    silent: true,
  });
  expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
    model: "gpt-6-sol",
    pricingModel: "gpt-6-sol-fast",
  }));
});
