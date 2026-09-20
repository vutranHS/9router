import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const rows = new Map();
  let usage = null;
  const db = {
    get(_sql, params) { return rows.get(`${params[0]}:${params[1]}`) || null; },
    run(_sql, params) { rows.set(`${params[0]}:${params[1]}`, { value: params[2] }); },
    transaction(fn) { fn(); },
  };
  return { rows, db, usageFetch: vi.fn(async () => usage), get usage() { return usage; }, set usage(value) { usage = value; } };
});

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => fixture.db) }));
vi.mock("@/lib/network/connectionProxy.js", () => ({ resolveConnectionProxyConfig: vi.fn(async (config) => config || {}) }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: (...args) => fixture.usageFetch(...args) }));

import { reserveQuota, settleQuota } from "@/sse/services/quotaSharing.js";

const resetAt = () => new Date(Date.now() + 3600000).toISOString();
const credentials = () => ({ _connection: {
  id: "shared-claude", provider: "claude", quotaSharing: { enabled: true, apiKeyIds: ["a", "b"] }, providerSpecificData: {},
} });
const body = { messages: [{ role: "user", content: "small request" }], max_tokens: 100 };
const state = () => JSON.parse(fixture.rows.get("quotaSharing:connection:shared-claude")?.value || "{}");
const seed = (value) => fixture.rows.set("quotaSharing:connection:shared-claude", { value: JSON.stringify(value) });

describe("quota sharing durable bootstrap ledger", () => {
  beforeEach(() => {
    fixture.rows.clear();
    fixture.usageFetch.mockClear();
    const reset = resetAt();
    fixture.usage = { quotas: {
      "weekly (7d)": { remainingPercentage: 80, resetAt: reset },
      "weekly fable (7d)": { remainingPercentage: 80, resetAt: reset },
      "session (5h)": { remainingPercentage: 80, resetAt: reset },
    } };
  });

  it("keeps an unobserved completed request as debt across a stale percentage read", async () => {
    const first = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    expect(first.ok).toBe(true);
    await settleQuota("shared-claude", first.reservationId, { prompt_tokens: 20, completion_tokens: 5 });

    const second = await reserveQuota({ credentials: credentials(), apiKeyId: "b", provider: "claude", model: "claude-sonnet-5", body });
    expect(second.ok).toBe(true);
    const ledger = state();
    expect(Object.values(ledger.pending)).toEqual(expect.arrayContaining([expect.objectContaining({ apiKeyId: "a" })]));
  });

  it("does not let restart/stale snapshots refill bootstrap capacity", async () => {
    for (let index = 0; index < 4; index += 1) {
      const lease = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
      expect(lease.ok).toBe(true);
      await settleQuota("shared-claude", lease.reservationId, null);
    }
    const blocked = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    expect(blocked).toMatchObject({ ok: false, status: 429 });
  });

  it("preserves strict connection proxy policy for provider quota reads", async () => {
    const strictCredentials = () => ({ _connection: {
      ...credentials()._connection,
      providerSpecificData: { strictProxy: true },
    } });
    await reserveQuota({ credentials: strictCredentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    expect(fixture.usageFetch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ strictProxy: true }),
      { force: true },
    );
  });

  it("keeps Claude's Fable and other-model 45% pools independent", async () => {
    const reset = resetAt();
    fixture.usage = { quotas: {
      "weekly (7d)": { remainingPercentage: 80, resetAt: reset },
      "weekly fable (7d)": { remainingPercentage: 80, resetAt: reset },
      "session (5h)": { remainingPercentage: 80, resetAt: reset },
    } };
    seed({
      lastProbeAt: Date.now(), snapshot: fixture.usage, windows: {
        "weekly (7d)": { resetAt: new Date(reset).getTime(), remaining: 80, used: { a: { other: 45 } }, pointsPerWeight: 0 },
        "weekly fable (7d)": { resetAt: new Date(reset).getTime(), remaining: 80, used: { a: { all: 30 } }, pointsPerWeight: 0 },
        "session (5h)": { resetAt: new Date(reset).getTime(), remaining: 80, used: {}, pointsPerWeight: 0 },
      }, reservations: {}, pending: {},
    });

    const other = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    expect(other).toMatchObject({ ok: false, status: 429 });

    const fable = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-fable-5-1", body });
    expect(fable.ok).toBe(true);
  });

  it("settles a fresh percentage delta to the owning key instead of keeping dollar weights as points", async () => {
    const reset = resetAt();
    const initial = { quotas: {
      "weekly (7d)": { remainingPercentage: 80, resetAt: reset },
      "session (5h)": { remainingPercentage: 80, resetAt: reset },
    } };
    fixture.usage = initial;
    const lease = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    await settleQuota("shared-claude", lease.reservationId, { input_tokens: 100, output_tokens: 10 });

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61000);
    fixture.usage = { quotas: {
      "weekly (7d)": { remainingPercentage: 79, resetAt: reset },
      "session (5h)": { remainingPercentage: 79, resetAt: reset },
    } };
    const next = await reserveQuota({ credentials: credentials(), apiKeyId: "b", provider: "claude", model: "claude-sonnet-5", body });
    vi.useRealTimers();

    expect(next.ok).toBe(true);
    expect(state().windows["weekly (7d)"].used.a.other).toBeCloseTo(1);
    expect(state().windows["weekly (7d)"].pointsPerWeight).toBeGreaterThan(0);
  });

  it("serializes concurrent lease attempts to one account-wide reservation", async () => {
    const [first, second] = await Promise.all([
      reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body }),
      reserveQuota({ credentials: credentials(), apiKeyId: "b", provider: "claude", model: "claude-sonnet-5", body }),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({ status: 429 });
  });

  it("converts a crashed 15-minute lease to unknown pending debt without refunding it", async () => {
    const first = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60000);
    const next = await reserveQuota({ credentials: credentials(), apiKeyId: "b", provider: "claude", model: "claude-sonnet-5", body });
    vi.useRealTimers();

    expect(next.ok).toBe(true);
    const ledger = state();
    expect(ledger.reservations[first.reservationId]).toBeUndefined();
    expect(ledger.pending[first.reservationId]).toMatchObject({ apiKeyId: "a", weight: null });
  });

  it("learns separate percentage-per-dollar rates for weekly and session windows", async () => {
    const reset = resetAt();
    fixture.usage = { quotas: {
      "weekly (7d)": { remainingPercentage: 80, resetAt: reset },
      "session (5h)": { remainingPercentage: 80, resetAt: reset },
    } };
    const first = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    await settleQuota("shared-claude", first.reservationId, { input_tokens: 100, output_tokens: 10 });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61000);
    fixture.usage = { quotas: {
      "weekly (7d)": { remainingPercentage: 79, resetAt: reset },
      "session (5h)": { remainingPercentage: 78, resetAt: reset },
    } };
    const second = await reserveQuota({ credentials: credentials(), apiKeyId: "b", provider: "claude", model: "claude-sonnet-5", body });
    vi.useRealTimers();

    const windows = state().reservations[second.reservationId].windows;
    expect(windows["session (5h)"].rate).toBeCloseTo(windows["weekly (7d)"].rate * 2);
  });

  it("throttles repeated failed provider measurements instead of failing open", async () => {
    fixture.usage = { message: "temporary provider failure" };
    const first = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    const second = await reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    expect(first).toMatchObject({ ok: false, status: 429 });
    expect(second).toMatchObject({ ok: false, status: 429 });
    expect(fixture.usageFetch).toHaveBeenCalledTimes(1);
  });

  it("does not erase previously charged keys when sharing membership changes", async () => {
    const reset = resetAt();
    seed({
      lastProbeAt: Date.now(), snapshot: fixture.usage, windows: {
        "weekly (7d)": { resetAt: new Date(reset).getTime(), remaining: 80, used: { a: { other: 4 } }, pointsPerWeight: 0 },
        "weekly fable (7d)": { resetAt: new Date(reset).getTime(), remaining: 80, used: {}, pointsPerWeight: 0 },
        "session (5h)": { resetAt: new Date(reset).getTime(), remaining: 80, used: { a: { all: 2 } }, pointsPerWeight: 0 },
      }, reservations: {}, pending: {},
    });
    const changed = () => ({ _connection: { ...credentials()._connection, quotaSharing: { enabled: true, apiKeyIds: ["b"] } } });
    await reserveQuota({ credentials: changed(), apiKeyId: "b", provider: "claude", model: "claude-sonnet-5", body });
    expect(state().windows["weekly (7d)"].used.a.other).toBe(4);
    expect(state().windows["session (5h)"].used.a.all).toBe(2);
  });

  it("releases daily shares from the provider reset and clears spending only at the weekly reset", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-09-23T10:30:00Z");
    const week = 7 * 86400000;
    vi.setSystemTime(startedAt + 3600000);
    const reset = startedAt + week;
    fixture.usage = { quotas: { "weekly (7d)": { remainingPercentage: 80, resetAt: new Date(reset).toISOString() } } };
    const fourKeys = { _connection: { ...credentials()._connection, quotaSharing: { enabled: true, apiKeyIds: ["a", "b", "c", "d"] } } };
    seed({ lastProbeAt: Date.now(), snapshot: fixture.usage, windows: {
      "weekly (7d)": { resetAt: reset, remaining: 80, used: { a: { other: 1.5 } }, pointsPerWeight: 0 },
    }, pending: {}, reservations: {} });
    const reserve = () => reserveQuota({ credentials: fourKeys, apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    try {
      expect(await reserve()).toMatchObject({ ok: false, status: 429, retryAfter: 23 * 3600 });
      vi.setSystemTime(startedAt + 86400000);
      const nextDay = await reserve();
      expect(nextDay.ok).toBe(true);
      await settleQuota("shared-claude", nextDay.reservationId, null);
      expect(state().windows["weekly (7d)"].used.a.other).toBe(1.5);
      vi.setSystemTime(reset + 1);
      fixture.usage.quotas["weekly (7d)"] = { remainingPercentage: 100, resetAt: new Date(reset + week).toISOString() };
      expect((await reserve()).ok).toBe(true);
      expect(state().windows["weekly (7d)"].used).toEqual({});
    } finally { vi.useRealTimers(); }
  });

  it("counts pending usage against the owner's share before provider percentages update", async () => {
    const reset = resetAt();
    seed({ lastProbeAt: Date.now(), snapshot: fixture.usage, windows: {
      "weekly (7d)": { resetAt: Date.parse(reset), remaining: 80, used: { a: { other: 22.1 } }, pointsPerWeight: 0 },
      "weekly fable (7d)": { resetAt: Date.parse(reset), remaining: 80, used: {}, pointsPerWeight: 0 },
      "session (5h)": { resetAt: Date.parse(reset), remaining: 80, used: {}, pointsPerWeight: 0 },
    }, reservations: {}, pending: {} });
    const reserve = () => reserveQuota({ credentials: credentials(), apiKeyId: "a", provider: "claude", model: "claude-sonnet-5", body });
    const first = await reserve();
    expect(first.ok).toBe(true);
    await settleQuota("shared-claude", first.reservationId, null);
    expect(await reserve()).toMatchObject({ ok: false, status: 429 });
  });
});
