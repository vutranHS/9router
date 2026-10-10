import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError request-level errors", () => {
  it("does not lock accounts for a broken image in the request", () => {
    const err = '{"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"}}';
    expect(checkFallbackError(400, err)).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });
  it("still falls back on rate limits", () => {
    expect(checkFallbackError(429, "rate limit").shouldFallback).toBe(true);
  });
});
