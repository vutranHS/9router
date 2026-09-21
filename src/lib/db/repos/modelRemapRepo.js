import { makeKv } from "../helpers/kvStore.js";

// Per-API-key model remapping: silently route one model to another for one key.
// key   = raw API key string
// value = { "<bare source model name>": "<provider>/<model>" }
// Source is the bare model name (post-resolution), so one rule catches every
// spelling that resolves to it — `cc/x`, `claude/x`, an alias pointing at it,
// and combo members.
const remapKv = makeKv("apiKeyModelRemap");

export async function getRemapForKey(apiKey) {
  if (!apiKey) return {};
  return (await remapKv.get(apiKey, {})) || {};
}

// Whole scope in one query — the table holds at most one row per API key, and
// this mirrors getDisabledModels()'s shape for the dashboard.
export async function getAllRemaps() {
  return (await remapKv.getAll()) || {};
}

export async function setRemapForKey(apiKey, map) {
  if (!apiKey) return;
  const clean = {};
  for (const [src, target] of Object.entries(map || {})) {
    const s = typeof src === "string" ? src.trim() : "";
    const t = typeof target === "string" ? target.trim() : "";
    if (s && t) clean[s] = t;
  }
  // Drop the row rather than storing {} — matches disabledModelsRepo.
  if (Object.keys(clean).length === 0) await remapKv.remove(apiKey);
  else await remapKv.set(apiKey, clean);
}
