import { describe, expect, it } from "vitest";
import { normalizedQuotaWindows } from "@/sse/services/quotaSharing.js";

const resetAt = new Date(Date.now() + 3600000).toISOString();

describe("quota sharing normalized windows", () => {
  it("keeps Claude Fable scoped quota separate from the general weekly pool", () => {
    const usage = { quotas: {
      "weekly (7d)": { remainingPercentage: 60, resetAt },
      "weekly fable (7d)": { remainingPercentage: 30, resetAt },
      "session (5h)": { remainingPercentage: 80, resetAt },
    } };

    expect(normalizedQuotaWindows(usage, "claude-fable-5-1").map((window) => window.type))
      .toEqual(["weekly", "fable", "session"]);
    expect(normalizedQuotaWindows(usage, "claude-sonnet-5").map((window) => window.type))
      .toEqual(["weekly", "session"]);
  });

  it("rejects missing and expired percentage windows instead of inventing capacity", () => {
    expect(normalizedQuotaWindows({ quotas: { weekly: { remainingPercentage: 50 } } }, "claude-sonnet-5")).toEqual([]);
    expect(normalizedQuotaWindows({ quotas: { weekly: { remainingPercentage: 50, resetAt: new Date(Date.now() - 1).toISOString() } } }, "claude-sonnet-5")).toEqual([]);
    expect(normalizedQuotaWindows({ quotas: { weekly: { remainingPercentage: -1, resetAt } } }, "claude-sonnet-5")).toEqual([]);
    expect(normalizedQuotaWindows({ quotas: { weekly: { remainingPercentage: null, resetAt } } }, "claude-sonnet-5")).toEqual([]);
  });
});
