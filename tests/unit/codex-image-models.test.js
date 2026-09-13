import { afterEach, describe, expect, it, vi } from "vitest";
import { getModelsByProviderId, getModelType, isValidModel } from "../../open-sse/config/providerModels.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

const models = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"];

afterEach(() => vi.unstubAllGlobals());

describe("Codex GPT-5.6 image models", () => {
  it.each(models)("exposes %s-image as an image model while retaining its chat entry", (model) => {
    const catalog = getModelsByProviderId("codex");
    expect(catalog.filter((entry) => entry.id === `${model}-image`)).toHaveLength(1);
    expect(catalog.find((entry) => entry.id === `${model}-image`)).toMatchObject({
      kind: "image",
      capabilities: ["text2img", "edit"],
      params: ["size", "quality", "background", "image_detail", "output_format"],
    });
    expect(isValidModel("cx", `${model}-image`)).toBe(true);
    expect(getModelType("cx", `${model}-image`)).toBe("image");
    expect(catalog.find((entry) => entry.id === model)).toBeDefined();
    expect(getModelType("cx", model)).not.toBe("image");
  });

  it.each(models)("routes %s-image edits and streams image events", async (model) => {
    const events = [
      ["response.image_generation_call.partial_image", { partial_image_b64: "cGFydGlhbA==", partial_image_index: 0 }],
      ["response.output_item.done", { item: { type: "image_generation_call", result: "ZmluYWw=" } }],
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const onRequestSuccess = vi.fn();
    const log = { warn: vi.fn() };
    const modelInfo = await getModelInfoCore(`cx/${model}-image`);
    expect(modelInfo).toEqual({ provider: "codex", model: `${model}-image` });
    expect(await getModelInfoCore(`codex/${model}-image`)).toEqual(modelInfo);

    const result = await handleImageGenerationCore({
      modelInfo,
      body: {
        prompt: "Make the square blue",
        image: "data:image/png;base64,cmVmZXJlbmNl",
        image_detail: "low",
        size: "1024x1024",
        quality: "high",
        background: "transparent",
        output_format: "WEBP",
      },
      credentials: { accessToken: "test-token" },
      streamToClient: true,
      onRequestSuccess,
      log,
    });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe("text/event-stream");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const upstreamBody = JSON.parse(options.body);
    expect(upstreamBody.model).toBe(model);
    expect(upstreamBody.tools).toEqual([{
      type: "image_generation", output_format: "webp", size: "1024x1024",
      quality: "high", background: "transparent",
    }]);
    expect(upstreamBody.input[0].content).toContainEqual({
      type: "input_image", image_url: "data:image/png;base64,cmVmZXJlbmNl", detail: "low",
    });
    const stream = await result.response.text();
    expect(stream).toContain('event: partial_image\ndata: {"b64_json":"cGFydGlhbA==","index":0}');
    expect(stream).toContain("event: done\n");
    expect(stream).toContain('"data":[{"b64_json":"ZmluYWw="}]');
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["response.failed", { response: { status: "failed", error: { code: "image_error", message: "Image tool failed" } } }],
    ["response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }],
    ["response.completed", { response: { status: "completed", output: [{ type: "message", content: [{ text: "PRIVATE_OUTPUT" }] }] } }],
    ["error", { code: "server_error", message: "Upstream error" }],
  ])("logs safe diagnostics for %s with JSON and SSE clients", async (event, data) => {
    for (const streamToClient of [false, true]) {
      const log = { warn: vi.fn() };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        `data: ${JSON.stringify({ type: event, ...data, input: "PRIVATE_PROMPT", result: "PRIVATE_IMAGE", authorization: "PRIVATE_TOKEN" })}\n\n`,
        { headers: { "Content-Type": "text/event-stream", "x-request-id": "req-test" } },
      )));
      const result = await handleImageGenerationCore({
        modelInfo: { provider: "codex", model: "gpt-image-2.5-sunburst" },
        body: { prompt: "PRIVATE_PROMPT" },
        credentials: { accessToken: "PRIVATE_TOKEN", connectionId: "conn-test", connectionName: "Test Account" },
        streamToClient, log,
      });
      if (streamToClient) expect(await result.response.text()).toContain("event: error");
      else expect(result.status).toBe(502);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const [tag, message, diagnostic] = log.warn.mock.calls[0];
      expect(tag).toBe("IMAGE");
      expect(message).toBe("Codex image stream failed");
      expect(diagnostic).toMatchObject({
        connectionId: "conn-test", account: "Test Account", model: "gpt-image-2.5-sunburst",
        requestId: "req-test", terminalEvent: event, lastEvent: event, malformedEvents: 0,
      });
      if (event === "response.failed") expect(diagnostic).toMatchObject({ errorCode: "image_error", errorMessage: "Image tool failed" });
      if (event === "response.incomplete") expect(diagnostic.incompleteReason).toBe("max_output_tokens");
      if (event === "response.completed") expect(diagnostic.outputTypes).toEqual(["message"]);
      if (event === "error") expect(diagnostic).toMatchObject({ errorCode: "server_error", errorMessage: "Upstream error" });
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain("PRIVATE_");
    }
  });

  it("reports images present only in the terminal output without logging their contents", async () => {
    const log = { warn: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", output: [{ type: "image_generation_call", result: "PRIVATE_IMAGE" }] } })}\n\n`,
    )));
    await handleImageGenerationCore({
      modelInfo: { provider: "codex", model: "gpt-image-2.5-sunburst" },
      body: { prompt: "test" }, credentials: { accessToken: "test" }, log,
    });
    expect(log.warn.mock.calls[0][2]).toMatchObject({ completedImagePresent: true, outputTypes: ["image_generation_call"] });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("PRIVATE_IMAGE");
  });

  it.each(["malformed", "terminated"])("logs %s streams without dumping raw data", async (failure) => {
    const log = { warn: vi.fn() };
    const stream = failure === "terminated"
      ? new ReadableStream({ start(controller) { controller.error(new Error("terminated")); } })
      : "event: response.failed\ndata: PRIVATE_INVALID_JSON\n\nunparsed PRIVATE_BODY";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const result = await handleImageGenerationCore({
      modelInfo: { provider: "codex", model: "gpt-image-2.5-sunburst" },
      body: { prompt: "test" }, credentials: { accessToken: "test" }, log,
    });
    expect(result.status).toBe(502);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const diagnostic = log.warn.mock.calls[0][2];
    if (failure === "terminated") expect(diagnostic.streamError).toBe("terminated");
    else {
      expect(diagnostic.malformedEvents).toBe(1);
      expect(diagnostic.unparsedBytes).toBeGreaterThan(0);
    }
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("PRIVATE_");
  });
});
