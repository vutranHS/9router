import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}), trackPendingRequest: vi.fn(),
}));
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const context = () => ({ provider: "claude", model: "claude-sonnet-5", connectionId: "shared",
  body: { messages: [] }, requestStartTime: Date.now(), stream: false,
  sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.CLAUDE,
  trackDone: vi.fn(), appendLog: vi.fn(), reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
});

describe("quota usage lifecycle", () => {
  it("settles actual JSON usage before client token buffers are added", async () => {
    const onQuotaSettled = vi.fn(async () => {});
    const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_1h_input_tokens: 30 } };
    const result = await handleNonStreamingResponse({ ...context(), onQuotaSettled,
      providerResponse: Response.json({ id: "test", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], usage }),
    });
    expect(result.success).toBe(true);
    expect(onQuotaSettled).toHaveBeenCalledWith(expect.objectContaining({ prompt_tokens: 100, completion_tokens: 20, cache_creation: usage.cache_creation }));
  });

  it("settles streamed final usage, not the upstream 200 status", async () => {
    const onQuotaSettled = vi.fn(async () => {});
    const { onStreamComplete } = buildOnStreamComplete({ ...context(), stream: true, onQuotaSettled });
    expect(onQuotaSettled).not.toHaveBeenCalled();
    const usage = { prompt_tokens: 100, completion_tokens: 20 };
    onStreamComplete({ content: "ok" }, usage, Date.now());
    await Promise.resolve();
    expect(onQuotaSettled).toHaveBeenCalledWith(usage);
  });

  it("preserves actual cached tokens when Responses SSE becomes JSON", async () => {
    const onQuotaSettled = vi.fn(async () => {});
    const usage = { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 900 } };
    const event = { type: "response.completed", response: { id: "test", status: "completed", usage } };
    const result = await handleForcedSSEToJson({ ...context(), provider: "codex", model: "gpt-5",
      sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES, onQuotaSettled,
      providerResponse: new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    });
    expect(result.success).toBe(true);
    expect(onQuotaSettled).toHaveBeenCalledWith(expect.objectContaining(usage));
  });

  it("runs cleanup on AbortError as well as other stream errors", () => {
    const onError = vi.fn();
    const controller = createStreamController({ onError, log: { line: vi.fn() } });
    controller.handleError(new DOMException("cancelled", "AbortError"));
    expect(onError).toHaveBeenCalledOnce();
    controller.handleError(new Error("duplicate"));
    expect(onError).toHaveBeenCalledOnce();
  });
});
