import { describe, expect, it } from "vitest";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { canonicalizeUsage, extractUsage, mergeUsage, normalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";
import { extractUsageFromResponse } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Claude list prices used for quota weights", () => {
  it.each([
    ["claude-fable-5-1", 10, 50, 0.25, 12.5],
    ["anthropic/claude-fable-5-1-thinking", 10, 50, 0.25, 12.5],
    ["claude-fable-5.1", 10, 50, 0.25, 12.5],
    ["claude-fable-5", 10, 50, 1, 12.5],
    ["claude-fable-5-thinking", 10, 50, 1, 12.5],
    ["claude-sonnet-5", 2, 10, 0.2, 2.5],
    ["claude-sonnet-5-thinking", 2, 10, 0.2, 2.5],
    ["claude-opus-5", 5, 25, 0.5, 6.25],
    ["claude-haiku-4-5-20251001", 1, 5, 0.1, 1.25],
    ["claude-haiku-4.5", 1, 5, 0.1, 1.25],
    ["claude-opus-4.1", 15, 75, 1.5, 18.75],
    ["claude-opus-4-1-20250805", 15, 75, 1.5, 18.75],
  ])("resolves %s without falling into another model's price", (model, input, output, cached, cache_creation) => {
    expect(getPricingForModel("claude", model)).toMatchObject({ input, output, cached, cache_creation });
  });

  it("charges mixed cache lifetimes once and keeps provider price overrides", () => {
    const tokens = {
      prompt_tokens: 1000, cached_tokens: 300, completion_tokens: 40,
      cache_creation_input_tokens: 600,
      cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 200 },
    };
    const price = getPricingForModel("claude", "claude-fable-5-1");
    expect(calculateCostFromTokens(tokens, price)).toBeCloseTo((100 * 10 + 300 * 0.25 + 400 * 12.5 + 200 * 20 + 40 * 50) / 1e6, 12);
    expect(calculateCostFromTokens(tokens, { ...price, cache_creation_1h: 15 })).toBeCloseTo((100 * 10 + 300 * 0.25 + 400 * 12.5 + 200 * 15 + 40 * 50) / 1e6, 12);
    expect(getPricingForModel("tokenrouter", "anthropic/claude-sonnet-5")).toBeDefined();
  });

  it("preserves cache lifetimes across stream, JSON, and OpenAI normalization", () => {
    const raw = {
      input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 300,
      cache_creation_input_tokens: 600,
      cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 200 },
    };
    const start = extractUsage({ type: "message_start", message: { usage: { ...raw, output_tokens: 1 } } });
    const delta = extractUsage({ type: "message_delta", usage: { output_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 400 } } });
    const bridged = toOpenAIUsage(raw, "claude");
    for (const usage of [
      mergeUsage(start, delta), extractUsageFromResponse({ usage: raw }),
      extractUsageFromResponse({ usage: bridged }), extractUsage({ usage: bridged }), normalizeUsage(bridged),
    ]) {
      const canonical = canonicalizeUsage(usage);
      expect(canonical).toMatchObject({ prompt_tokens: 1000, completion_tokens: 40, cache_creation: raw.cache_creation });
      expect(canonicalizeUsage(canonical)).toEqual(canonical);
      expect(calculateCostFromTokens(canonical, getPricingForModel("claude", "claude-fable-5-1")))
        .toBeCloseTo((100 * 10 + 300 * 0.25 + 400 * 12.5 + 200 * 20 + 40 * 50) / 1e6, 12);
    }
  });

  it.each([false, true])("keeps actual cache costs for Claude streams (passthrough=%s)", async (passthrough) => {
    let settled;
    const events = [
      { type: "message_start", message: { id: "test", model: "claude-fable-5-1", usage: {
        input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 600,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 200 },
      } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
      { type: "message_stop" },
    ];
    const onComplete = (_content, usage) => { settled = canonicalizeUsage(usage); };
    const transform = passthrough
      ? createPassthroughStreamWithLogger("claude", null, "claude-fable-5-1", null, {}, onComplete)
      : createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "claude", null, null,
        "claude-fable-5-1", null, {}, onComplete);
    const stream = new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")).body.pipeThrough(transform);
    await new Response(stream).text();
    expect(settled).toMatchObject({ prompt_tokens: 1000, completion_tokens: 40, cached_tokens: 300,
      cache_creation_input_tokens: 600, cache_creation: { ephemeral_1h_input_tokens: 200 } });
    expect(calculateCostFromTokens(settled, getPricingForModel("claude", "claude-fable-5-1")))
      .toBeCloseTo(0.012075, 12);
  });
});
