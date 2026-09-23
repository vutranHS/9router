import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ saveRequestUsage: vi.fn(async () => {}) }));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(),
}));
vi.mock("../../open-sse/utils/stream.js", () => ({ COLORS: {} }));

import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";
import claudeProvider from "../../open-sse/providers/registry/claude.js";

it("registers Claude Opus 5.5", () => {
  expect(claudeProvider.models).toContainEqual({ id: "claude-opus-5-5", name: "Claude Opus 5.5" });
  expect(claudeProvider.transport.headers["Anthropic-Beta"]).toContain("fast-mode-2026-02-01");
});

it("uses the official Claude Opus 5.5 rates", () => {
  expect(getPricingForModel("claude", "claude-opus-5-5")).toEqual({
    input: 4,
    output: 20,
    cached: 0.2,
    reasoning: 20,
    cache_creation: 5,
  });
});

it.each([
  ["claude-opus-5-5-fast", 8, 40, 0.4, 10],
  ["claude-opus-5-fast", 10, 50, 1, 12.5],
  ["claude-opus-4-8-fast", 10, 50, 1, 12.5],
])("uses the official fast-mode rates for %s", (model, input, output, cached, cacheCreation) => {
  expect(getPricingForModel("claude", model)).toEqual({
    input,
    output,
    cached,
    reasoning: output,
    cache_creation: cacheCreation,
  });
});

it("selects fast pricing only for speed: fast requests", () => {
  mocks.saveRequestUsage.mockClear();
  saveUsageStats({
    provider: "claude",
    model: "claude-opus-5-5",
    tokens: { input_tokens: 10, output_tokens: 5 },
    requestBody: { speed: "fast" },
    silent: true,
  });

  expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
    model: "claude-opus-5-5",
    pricingModel: "claude-opus-5-5-fast",
  }));
});
