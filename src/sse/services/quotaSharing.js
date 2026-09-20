import { randomUUID } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { stringifyJson, parseJson } from "@/lib/db/helpers/jsonCol.js";
import { calculateCostFromTokens, getPricingForModel } from "open-sse/providers/pricing.js";
import { canonicalizeUsage, estimateInputTokens } from "open-sse/utils/usageTracking.js";

const SCOPE = "quotaSharing";
const DAY = 86400000;
const WEEK = 7 * DAY;
const PROBE_INTERVAL = 60000;
const LEASE_TTL = 15 * 60000;
// Estimated liabilities, not a promise that a bootstrap request cannot consume more quota.
const BOOTSTRAP_POINTS = 0.25;
const MAX_UNOBSERVED_POINTS = 1;
// Reservation estimate only when the client omits an output limit, not a request cap.
const DEFAULT_OUTPUT_ESTIMATE = 64000;

const finite = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value)) ? Number(value) : null;
const isFable = (model) => /fable/i.test(String(model || ""));
const denied = (error, retryAfter = 60) => ({ ok: false, status: 429, error, retryAfter: Math.max(1, Math.ceil(retryAfter)) });

export function normalizedQuotaWindows(usage, model = null) {
  const windows = [];
  for (const [id, quota] of Object.entries(usage?.quotas || {})) {
    const remaining = finite(quota?.remainingPercentage)
      ?? (finite(quota?.total) === 100 ? finite(quota?.remaining) : null);
    const resetAt = quota?.resetAt ? new Date(quota.resetAt).getTime() : NaN;
    if (remaining === null || remaining < 0 || remaining > 100 || !Number.isFinite(resetAt) || resetAt <= Date.now() || quota.unlimited) continue;
    const lower = id.toLowerCase().replace(/^(spark|review)_/, "$1 ");
    const scope = lower.match(/(?:weekly|session)\s+(fable|sonnet|opus|haiku|spark|review)\b/)?.[1]
      || lower.match(/^(spark|review)\b/)?.[1] || null;
    if (scope && model && !String(model).toLowerCase().includes(scope)) continue;
    const seconds = finite(quota.windowSeconds);
    const name = lower.replace(/^(spark|review) /, "");
    const weekly = seconds === WEEK / 1000 || /^weekly(?: (?:fable|sonnet|opus|haiku|spark|review))?(?:\s*\(7d\))?$/.test(name);
    const session = !weekly && (seconds === 18000 || /^session(?: (?:spark|review))?(?:\s*\(5h\))?$/.test(name));
    if (!weekly && !session) continue;
    windows.push({ id, type: weekly ? (scope === "fable" ? "fable" : "weekly") : "session", scope, remaining, resetAt });
  }
  const family = model && /spark|review/i.exec(model)?.[0]?.toLowerCase();
  return family && windows.some((window) => window.scope === family)
    ? windows.filter((window) => window.scope === family) : windows;
}

function bucketFor(window, provider, model) {
  return provider === "claude" && window.type === "weekly" && !window.scope ? (isFable(model) ? "fable" : "other") : "all";
}

function limitsFor(window, provider, model, count, now) {
  const splitClaude = provider === "claude" && window.type === "weekly" && !window.scope;
  // 90% of Fable's separate 50%-weekly cap is 45% of the overall week.
  const pool = splitClaude ? 45 : 90;
  const daily = window.type === "weekly" && !(provider === "claude" && isFable(model));
  const days = Math.max(1, Math.min(7, Math.floor((now - (window.resetAt - WEEK)) / DAY) + 1));
  return { pool, own: pool / count * (daily ? days / 7 : 1), retryAt: daily ? Math.min(window.resetAt, window.resetAt - WEEK + days * DAY) : window.resetAt };
}

function readState(db, connectionId) {
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, `connection:${connectionId}`]);
  if (!row) return {};
  const state = parseJson(row.value, null);
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid quota ledger; restore its persisted data before using this account");
  return state;
}
function writeState(db, connectionId, state) {
  db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [SCOPE, `connection:${connectionId}`, stringifyJson(state)]);
}

function recover(state, now) {
  state.windows ||= {};
  state.reservations ||= {};
  state.pending ||= {};
  for (const [id, reservation] of Object.entries(state.reservations)) {
    if (now - reservation.createdAt >= LEASE_TTL) {
      // Crash/abandonment cannot refund work already sent upstream.
      state.pending[id] = { ...reservation, weight: null };
      delete state.reservations[id];
    }
  }
  for (const [id, entry] of Object.entries(state.pending)) {
    for (const [windowId, liability] of Object.entries(entry.windows)) {
      if (liability.resetAt <= now) delete entry.windows[windowId];
    }
    if (!Object.keys(entry.windows).length) delete state.pending[id];
  }
}

function actualWeight(provider, model, usage) {
  if (!usage || usage.estimated) return null;
  const normalized = canonicalizeUsage({
    ...usage,
    // Responses input is cache-inclusive, unlike Claude's native input count.
    ...(usage.input_tokens_details ? { cached_tokens: usage.input_tokens_details.cached_tokens || 0 } : {}),
  });
  if (!normalized) return null;
  delete normalized.reasoning_tokens;
  const price = getPricingForModel(provider, model);
  const weight = price && calculateCostFromTokens(normalized, price);
  return Number.isFinite(weight) && weight > 0 ? weight : null;
}

function estimateWeight(provider, model, body) {
  let price = getPricingForModel(provider, model);
  if (!price) return null;
  const input = estimateInputTokens(body);
  const requestedOutput = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens;
  const output = requestedOutput === undefined ? DEFAULT_OUTPUT_ESTIMATE : finite(requestedOutput);
  if (!Number.isSafeInteger(input) || input <= 0 || !Number.isSafeInteger(output) || output <= 0) return null;
  if (price.long_context && input > price.long_context.above) {
    price = { ...price, ...price.long_context };
  }
  const inputPrice = Math.max(price.input, price.cache_creation || 0, price.cache_creation_1h || price.input * 2);
  const weight = (input * inputPrice + output * price.output) / 1e6;
  return Number.isFinite(weight) && weight > 0 ? weight : null;
}

function reconcile(state, windows, now) {
  for (const window of windows) {
    const previous = state.windows[window.id];
    if (previous && previous.resetAt !== window.resetAt && previous.resetAt > now) continue;
    const current = previous?.resetAt === window.resetAt ? previous : {
      resetAt: window.resetAt, remaining: window.remaining, used: {}, pointsPerWeight: previous?.pointsPerWeight || 0,
    };
    const delta = Math.max(0, current.remaining - window.remaining);
    const entries = Object.values(state.pending).filter((entry) => entry.windows[window.id]?.resetAt === window.resetAt);
    const weights = entries.map((entry) => entry.weight ?? entry.estimatedWeight);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    if (delta > 0 && totalWeight > 0) {
      // External usage during a batch is indistinguishable: this is conservative
      // allocation, not exact attribution. Idle deltas only affect the live guard.
      if (entries.every((entry) => entry.weight !== null)) {
        current.pointsPerWeight = Math.max(current.pointsPerWeight, delta / totalWeight);
      }
      entries.forEach((entry, index) => {
        const liability = entry.windows[window.id];
        const charged = Math.max(liability.rate ? liability.points : 0, delta * weights[index] / totalWeight);
        const keyUsed = current.used[entry.apiKeyId] ||= {};
        keyUsed[liability.bucket] = (keyUsed[liability.bucket] || 0) + charged;
        delete entry.windows[window.id];
      });
    }
    current.remaining = Math.min(current.remaining, window.remaining);
    state.windows[window.id] = current;
  }
  for (const [id, entry] of Object.entries(state.pending)) {
    if (!Object.keys(entry.windows).length) delete state.pending[id];
  }
}

async function snapshotFor(db, connection) {
  const now = Date.now();
  const owner = randomUUID();
  let result;
  let probe = false;
  db.transaction(() => {
    const state = readState(db, connection.id);
    recover(state, now);
    if (Object.keys(state.reservations).length) {
      result = denied("A request is still using this shared account; retry shortly", 5);
    } else if (state.probeUntil > now) {
      result = denied("Account quota is being refreshed; retry shortly", 5);
    } else if (state.lastProbeAt && now - state.lastProbeAt < PROBE_INTERVAL) {
      result = state.snapshot && !state.probeError ? { ok: true } : denied("Quota sharing needs a fresh provider measurement", (state.lastProbeAt + PROBE_INTERVAL - now) / 1000);
    } else {
      state.probeOwner = owner;
      state.probeUntil = now + PROBE_INTERVAL;
      state.lastProbeAt = now;
      probe = true;
    }
    writeState(db, connection.id, state);
  });
  if (!probe) return result;
  let usage;
  try {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    usage = await getUsageForProvider(connection, proxy, { force: true });
  } catch { /* Unknown quota fails closed below. */ }
  db.transaction(() => {
    const state = readState(db, connection.id);
    if (state.probeOwner !== owner) {
      result = denied("Quota refresh expired; retry shortly", 5);
      return;
    }
    delete state.probeOwner;
    delete state.probeUntil;
    const windows = normalizedQuotaWindows(usage);
    state.probeError = windows.length === 0;
    if (windows.length) {
      reconcile(state, windows, Date.now());
      state.snapshot = usage;
      state.snapshotAt = Date.now();
    }
    writeState(db, connection.id, state);
    result = state.probeError ? denied("Quota sharing is waiting for measurable provider quota data") : { ok: true };
  });
  return result;
}

/** Atomic per-account leases survive retries, toggles and process restarts. */
export async function reserveQuota({ credentials, apiKeyId, provider, model, body }) {
  const original = credentials?._connection;
  if (!original?.quotaSharing?.enabled) return { ok: true, reservationId: null };
  const ids = original.quotaSharing.apiKeyIds;
  if (!apiKeyId || !Array.isArray(ids) || !ids.includes(apiKeyId)) {
    return { ok: false, status: 403, error: "This account is shared only with selected active API keys" };
  }
  const estimatedWeight = estimateWeight(provider, model, body);
  if (!estimatedWeight) return denied("Shared accounts require known model pricing and valid positive token estimates; check the request and output limit");
  const connection = { ...original, accessToken: credentials.accessToken ?? original.accessToken, providerSpecificData: credentials.providerSpecificData ?? original.providerSpecificData };
  const db = await getAdapter();
  const snapshot = await snapshotFor(db, connection);
  if (!snapshot.ok) return snapshot;
  let result;
  db.transaction(() => {
    const now = Date.now();
    const state = readState(db, connection.id);
    recover(state, now);
    // ponytail: one in-flight request per shared account; relax only with reliable batch calibration.
    if (Object.keys(state.reservations).length || state.probeUntil > now) {
      result = denied("A request is still using this shared account; retry shortly", 5);
      return;
    }
    const windows = normalizedQuotaWindows(state.snapshot, model);
    if (!windows.length || (provider === "claude" && !windows.some((window) => window.type === "weekly" && !window.scope))) {
      result = denied("Quota sharing needs the account's measurable weekly quota");
      return;
    }
    const family = /spark|review/i.exec(model)?.[0]?.toLowerCase() || "normal";
    if (state.snapshot.quotaAvailable?.[family] === false) {
      result = denied("Provider reports an unavailable or incomplete quota window");
      return;
    }
    const previousWindows = normalizedQuotaWindows({ quotas: Object.fromEntries(Object.entries(state.windows).map(([id, value]) => [id, { remainingPercentage: value.remaining, resetAt: new Date(value.resetAt).toISOString() }])) }, model);
    if (previousWindows.some((window) => !windows.some((fresh) => fresh.id === window.id))) {
      result = denied("Provider omitted a previously known quota window; waiting for a complete measurement");
      return;
    }
    const reservationWindows = {};
    for (const window of windows) {
      const current = state.windows[window.id];
      if (!current || current.resetAt !== window.resetAt) {
        result = denied("Provider quota reset changed unexpectedly; waiting for the recorded reset", ((current?.resetAt || now + PROBE_INTERVAL) - now) / 1000);
        return;
      }
      const bucket = bucketFor(window, provider, model);
      const rate = current.pointsPerWeight || 0;
      const points = rate ? Math.max(0.001, estimatedWeight * rate) : BOOTSTRAP_POINTS;
      const pending = Object.values(state.pending).filter((entry) => entry.windows[window.id]?.resetAt === window.resetAt);
      const debt = pending.reduce((sum, entry) => sum + entry.windows[window.id].points, 0);
      const ownDebt = pending.filter((entry) => entry.apiKeyId === apiKeyId && entry.windows[window.id].bucket === bucket).reduce((sum, entry) => sum + entry.windows[window.id].points, 0);
      const bucketDebt = pending.filter((entry) => entry.windows[window.id].bucket === bucket).reduce((sum, entry) => sum + entry.windows[window.id].points, 0);
      const limits = limitsFor(window, provider, model, new Set(ids).size, now);
      if ((current.used[apiKeyId]?.[bucket] || 0) + ownDebt + points > limits.own
        || Object.values(current.used).reduce((sum, used) => sum + (used[bucket] || 0), 0) + bucketDebt + points > limits.pool) {
        result = denied(`Selected API key has reached its ${bucket === "all" ? window.id : bucket} share; reduce max_tokens or wait for the next allocation`, (limits.retryAt - now) / 1000);
        return;
      }
      if (current.remaining - debt - points < 10) {
        result = denied(`Provider ${window.id} quota is reserved or exhausted`, (window.resetAt - now) / 1000);
        return;
      }
      if (debt > 0 && debt + points > MAX_UNOBSERVED_POINTS) {
        result = denied("Quota sharing needs a fresh provider usage change before more requests");
        return;
      }
      reservationWindows[window.id] = { resetAt: window.resetAt, bucket, points, rate };
    }
    const reservationId = randomUUID();
    state.reservations[reservationId] = { apiKeyId, provider, model, estimatedWeight, createdAt: now, windows: reservationWindows };
    writeState(db, connection.id, state);
    result = { ok: true, reservationId };
  });
  return result;
}

export async function settleQuota(connectionId, reservationId, usage = null) {
  if (!connectionId || !reservationId) return;
  const db = await getAdapter();
  db.transaction(() => {
    const state = readState(db, connectionId);
    const reservation = state.reservations?.[reservationId];
    if (!reservation) return;
    const weight = actualWeight(reservation.provider, reservation.model, usage);
    for (const liability of Object.values(reservation.windows)) {
      if (weight !== null && liability.rate) liability.points = Math.max(0.001, weight * liability.rate);
    }
    state.pending[reservationId] = { ...reservation, weight };
    delete state.reservations[reservationId];
    writeState(db, connectionId, state);
  });
}

export function cancelQuota(connectionId, reservationId) {
  return settleQuota(connectionId, reservationId, null);
}
