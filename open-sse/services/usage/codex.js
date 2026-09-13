/**
 * Codex (OpenAI) usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: U("codex").url,
  resetCreditsUrl: U("codex").resetCreditsUrl,
  resetCreditsConsumeUrl: U("codex").resetCreditsConsumeUrl,
  weeklyOnlyPlans: U("codex").weeklyOnlyPlans,
  weeklyWindowSeconds: U("codex").weeklyWindowSeconds,
};

function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function errorMessage(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  return JSON.stringify(value);
}

function getCodexAccountId(providerSpecificData) {
  return providerSpecificData?.workspaceId || providerSpecificData?.accountId || providerSpecificData?.chatgptAccountId || null;
}

function getCodexRateLimitBody(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return snapshot.rate_limit && typeof snapshot.rate_limit === "object"
    ? snapshot.rate_limit
    : snapshot;
}

function formatCodexWindow(window, fallbackWindowSeconds = null) {
  const used = Math.max(0, Math.min(100, toFiniteNumber(window?.used_percent ?? window?.percent_used, 0)));
  return {
    used,
    total: 100,
    remaining: Math.max(0, 100 - used),
    resetAt: parseResetTime(window?.reset_at ?? window?.resets_at ?? window?.resetAt ?? null),
    windowSeconds: window?.limit_window_seconds ?? fallbackWindowSeconds,
    unlimited: false,
  };
}

function appendCodexQuotaWindows(quotas, prefix, snapshot, weeklyOnly = false) {
  const rateLimit = getCodexRateLimitBody(snapshot);
  if (!rateLimit) return false;

  const primary = rateLimit.primary_window || rateLimit.primary || snapshot.primary_window || snapshot.primary;
  const secondary = rateLimit.secondary_window || rateLimit.secondary || snapshot.secondary_window || snapshot.secondary;
  // Some plans have only a weekly primary window. Explicit upstream duration wins.
  const singleWeekly = !secondary && (primary?.limit_window_seconds === CODEX_CONFIG.weeklyWindowSeconds ||
    (weeklyOnly && primary?.limit_window_seconds == null));
  if (primary) {
    quotas[prefix ? `${prefix}_session` : "session"] = formatCodexWindow(primary, singleWeekly ? CODEX_CONFIG.weeklyWindowSeconds : null);
  }
  if (secondary) {
    quotas[prefix ? `${prefix}_weekly` : "weekly"] = formatCodexWindow(secondary);
  }

  // Display defaults are optimistic; routing needs every applicable window to be usable.
  return rateLimit.limit_reached !== true && rateLimit.allowed !== false &&
    (singleWeekly ? [primary] : [primary, secondary]).every((window) => {
      const used = window?.used_percent ?? window?.percent_used;
      return Number.isFinite(used) && used >= 0 && used < 100;
    });
}

function getCodexReviewRateLimit(data) {
  if (data.code_review_rate_limit || data.review_rate_limit) {
    return data.code_review_rate_limit || data.review_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId.code_review || byLimitId.codex_review || byLimitId.review || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id === "code_review" || id === "codex_review" || id === "review" || id.includes("review");
  }) || null;
}

function getCodexSparkRateLimit(data) {
  if (data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit) {
    return data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId["gpt-5.3-codex-spark"] || byLimitId.gpt_5_3_codex_spark || byLimitId.spark || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id.includes("spark") || id.includes("5.3-codex-spark");
  }) || null;
}

export async function getCodexUsage(accessToken, proxyOptions = null, providerSpecificData = null) {
  try {
    const accountId = getCodexAccountId(providerSpecificData);
    const response = await proxyAwareFetch(CODEX_CONFIG.usageUrl, {
      method: "GET",
      cache: "no-store",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
      },
    }, proxyOptions);

    if (!response.ok) {
      return { message: `Codex connected. Usage API temporarily unavailable (${response.status}).` };
    }

    const data = await response.json();
    const plan = data.plan_type || data.summary?.plan || "unknown";
    const normalRateLimit = data.rate_limit || data.rate_limits || data.rate_limits_by_limit_id?.codex || {};
    const reviewRateLimit = getCodexReviewRateLimit(data);
    const sparkRateLimit = getCodexSparkRateLimit(data);
    const availableResetCredits = Math.max(0, toFiniteNumber(data.rate_limit_reset_credits?.available_count, 0));
    const quotas = {};

    const quotaAvailable = {
      normal: appendCodexQuotaWindows(quotas, "", normalRateLimit, CODEX_CONFIG.weeklyOnlyPlans.includes(String(plan).toLowerCase())),
      review: appendCodexQuotaWindows(quotas, "review", reviewRateLimit),
      spark: appendCodexQuotaWindows(quotas, "spark", sparkRateLimit),
    };

    return {
      plan,
      limitReached: getCodexRateLimitBody(normalRateLimit)?.limit_reached || false,
      reviewLimitReached: getCodexRateLimitBody(reviewRateLimit)?.limit_reached || false,
      sparkLimitReached: getCodexRateLimitBody(sparkRateLimit)?.limit_reached || false,
      resetCredits: { availableCount: availableResetCredits },
      quotaAvailable,
      quotas,
    };
  } catch (error) {
    throw new Error(`Failed to fetch Codex usage: ${error.message}`);
  }
}

export async function getCodexRateLimitResetCredits(accessToken, proxyOptions = null, providerSpecificData = null) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }

  const accountId = getCodexAccountId(providerSpecificData);
  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json",
    "OpenAI-Beta": "codex-1",
    "originator": "codex_cli_rs",
  };
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;

  const response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsUrl, {
    method: "GET",
    headers,
  }, proxyOptions);

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = errorMessage(data?.message || data?.error || data?.detail, `Codex reset credits API unavailable (${response.status}).`);
    throw new Error(message);
  }

  const credits = Array.isArray(data?.credits) ? data.credits : [];
  return {
    availableCount: Math.max(0, toFiniteNumber(data?.available_count ?? data?.availableCount, 0)),
    credits: credits.map((credit) => ({
      status: String(credit?.status || "unknown"),
      grantedAt: toIsoDate(credit?.granted_at ?? credit?.grantedAt),
      expiresAt: toIsoDate(credit?.expires_at ?? credit?.expiresAt),
    })),
  };
}

// Consume one Codex rate-limit reset credit (irreversible, spends 1 credit)
export async function consumeCodexRateLimitResetCredit(accessToken, redeemRequestId, proxyOptions = null) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }
  if (!redeemRequestId || typeof redeemRequestId !== "string") {
    throw new Error("A redeem request id is required to consume a Codex reset credit.");
  }

  let response;
  let data = null;
  try {
    response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsConsumeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ redeem_request_id: redeemRequestId }),
    }, proxyOptions);

    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Failed to consume Codex reset credit: ${error.message}`);
  }

  const code = data?.code || null;
  const windowsReset = toFiniteNumber(data?.windows_reset, 0);
  const success = response.ok && (code === "reset" || windowsReset > 0);

  return {
    ok: success,
    noCredit: response.ok && code === "no_credit",
    status: response.status,
    code,
    windowsReset,
    message: data?.message || null,
    raw: data,
  };
}
