import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getModelAliases: vi.fn(async () => ({})),
  getComboByName: vi.fn(async () => null),
  getProviderNodes: vi.fn(async () => []),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";
import { getProviderCredentials, markAccountUnavailable } from "../../src/sse/services/auth.js";
import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";
import * as log from "@/sse/utils/logger.js";

const now = new Date("2026-09-14T03:00:00.000Z");
const model = "gpt-5.4";
let account;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, "error").mockImplementation(() => {});
  account = { id: "codex-1", provider: "codex", isActive: true, accessToken: "token" };
  db.getProviderConnections.mockImplementation(async () => [account]);
  db.updateProviderConnection.mockImplementation(async (_id, update) => Object.assign(account, update));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Codex usage cooldown", () => {
  it("connects image SSE diagnostics to the server logger with account context", async () => {
    account.name = "Test Account";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'event: response.failed\ndata: {"response":{"status":"failed","error":{"code":"image_error","message":"Image tool failed"}}}\n\n',
    )));
    const response = await handleImageGeneration(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cx/gpt-image-2.5-sunburst", prompt: "test" }),
    }));
    expect(response.status).toBe(502);
    expect(log.warn).toHaveBeenCalledWith("IMAGE", "Codex image stream failed", expect.objectContaining({
      connectionId: account.id, account: "Test Account", model: "gpt-image-2.5-sunburst", errorCode: "image_error",
    }));
  });

  it.each([
    ["resets_at", 5 * 3600],
    ["resets_in_seconds", 6 * 24 * 3600],
    ["missing reset", null],
  ])("keeps image usage cooldown through the full request flow (%s)", async (field, seconds) => {
    const resetAt = now.getTime() + (seconds ?? 2) * 1000;
    const imageModel = "gpt-image-2.5-sunburst";
    const lockKey = `modelLock_${imageModel}`;
    const fetchMock = vi.fn(async () => Response.json({ error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      ...(seconds ? { [field]: field === "resets_at" ? resetAt / 1000 : seconds } : {}),
    } }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = () => handleImageGeneration(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: `cx/${imageModel}`, prompt: "A green square" }),
    }));

    expect((await request()).status).toBe(429);
    expect(account[lockKey]).toBe(new Date(resetAt).toISOString());
    if (seconds) {
      expect(account.codexQuotaLocks[lockKey]).toBe(account[lockKey]);
      vi.setSystemTime(now.getTime() + 31 * 60 * 1000);
      expect((await request()).status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    vi.setSystemTime(resetAt);
    expect(await getProviderCredentials("codex", null, imageModel)).toMatchObject({ connectionId: account.id });
  });

  it.each([
    ["5-hour", 5 * 3600, "resets_at"],
    ["weekly with session quota available", 6 * 24 * 3600, "resets_at"],
    ["weekly relative reset", 6 * 24 * 3600, "resets_in_seconds"],
  ])("keeps the upstream %s reset until expiry", async (_name, seconds, field) => {
    const resetAt = now.getTime() + seconds * 1000;
    const response = new Response(JSON.stringify({ error: {
      type: "usage_limit_reached",
      message: "You have hit your ChatGPT usage limit.",
      [field]: field === "resets_at" ? resetAt / 1000 : seconds,
    } }), { status: 429 });
    const parsed = await parseUpstreamError(response, new CodexExecutor());
    await markAccountUnavailable(account.id, parsed.statusCode, parsed.message, "codex", model, parsed.resetsAtMs);

    expect(account[`modelLock_${model}`]).toBe(new Date(resetAt).toISOString());
    vi.setSystemTime(now.getTime() + 31 * 60 * 1000);
    expect(await getProviderCredentials("codex", null, model)).toMatchObject({
      allRateLimited: true,
      retryAfter: new Date(resetAt).toISOString(),
    });
    vi.setSystemTime(resetAt);
    expect(await getProviderCredentials("codex", null, model)).toMatchObject({ connectionId: account.id });
  });

  it("keeps short backoff for 429 without a valid usage reset", async () => {
    await markAccountUnavailable(account.id, 429, "Too many requests", "codex", model);
    expect(account[`modelLock_${model}`]).toBe(new Date(now.getTime() + 2000).toISOString());
  });

  it("preserves the cooldown cap for other providers", async () => {
    await markAccountUnavailable(account.id, 429, "Rate limit", "openai", model, now.getTime() + 5 * 3600 * 1000);
    expect(account[`modelLock_${model}`]).toBe(new Date(now.getTime() + 30 * 60 * 1000).toISOString());
  });
});
