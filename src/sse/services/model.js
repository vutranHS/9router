// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { getRemapForKey } from "@/lib/keyModelRemapDb";
import * as log from "../utils/logger.js";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Resolve a model string to { provider, model }. A null provider means the
 * string is a combo name, which the caller handles separately.
 */
async function resolveModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Get full model info, applying the caller's per-API-key model remap.
 *
 * Remap runs AFTER resolution, so one rule keyed on the bare model name catches
 * every spelling that resolves to it — `cc/x`, `claude/x`, an alias pointing at
 * it, and combo members (combo.js re-enters this path per member).
 *
 * Applied once, never chained — same convention as alias resolution, which also
 * resolves a single hop. That makes A→B→A cycles structurally impossible.
 *
 * Fail-open: any lookup error leaves the original model untouched.
 */
export async function getModelInfo(modelStr, apiKey = null) {
  const info = await resolveModelInfo(modelStr);
  // No key (local/preview path) or a combo name (provider === null): leave alone.
  if (!apiKey || !info?.provider) return info;

  try {
    const target = (await getRemapForKey(apiKey))?.[info.model];
    if (!target) return info;
    const remapped = parseModel(target);
    // A rule must name a full provider/model; anything else is ignored rather
    // than routed somewhere unintended.
    if (!remapped?.provider || !remapped?.model) return info;
    log.info("REMAP", `${info.provider}/${info.model} \u2192 ${remapped.provider}/${remapped.model} (key ${log.maskKey(apiKey)})`);
    return { provider: remapped.provider, model: remapped.model };
  } catch (e) {
    log.debug("REMAP", `skipped: ${e.message}`);
    return info;
  }
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
