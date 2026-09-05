import { NextResponse } from "next/server";
import { getProviderConnections, getCustomModels, getModelAliases } from "@/lib/localDb";
import { getModelKind, getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";

function inferKind(model) {
  const kind = getModelKind(model);
  if (kind) return kind;
  return /image|imagen|dall-?e|flux|sdxl|stable-diffusion/i.test(model.id) ? "image" : "llm";
}

export async function GET() {
  try {
    const connections = await getProviderConnections({ isActive: true });
    const customModels = await getCustomModels().catch(() => []);
    const modelAliases = await getModelAliases().catch(() => ({}));

    return NextResponse.json({
      connections: connections.map((connection) => {
        const catalog = getModelsByProviderId(connection.provider);
        const enabled = connection.providerSpecificData?.enabledModels;
        const rawModels = Array.isArray(enabled) && enabled.length > 0
          ? enabled.map((id) => catalog.find((model) => model.id === id) || { id })
          : catalog;
        const prefix = connection.providerSpecificData?.prefix;
        const alias = prefix || getProviderAlias(connection.provider);
        // Manually added models are stored under the provider's storage alias
        // (prefix, short alias, or raw id depending on where they were added),
        // so accept any of the three — otherwise a hand-added model is invisible
        // here while the provider page shows it.
        const aliases = new Set([prefix, getProviderAlias(connection.provider), connection.provider].filter(Boolean));
        const seen = new Set(rawModels.map((model) => model.id));
        const allModels = [...rawModels];
        const add = (rawId, kind) => {
          const id = String(rawId || "").trim();
          if (!id || seen.has(id)) return;
          seen.add(id);
          allModels.push({ id, kind });
        };
        for (const custom of customModels) {
          if (!custom?.id || !aliases.has(custom.providerAlias)) continue;
          add(custom.id, getModelKind(custom));
        }
        // Legacy path: models added before customModels existed live only as
        // `alias -> "<providerAlias>/<id>"` entries in modelAliases.
        for (const fullModel of Object.values(modelAliases || {})) {
          if (typeof fullModel !== "string") continue;
          const slash = fullModel.indexOf("/");
          if (slash < 1) continue;
          if (!aliases.has(fullModel.slice(0, slash))) continue;
          add(fullModel.slice(slash + 1), null);
        }
        const toOption = (model) => ({
          id: `${connection.provider}/${model.id}`,
          label: `${alias}/${model.id}`,
        });
        return {
          id: connection.id,
          provider: connection.provider,
          alias,
          name: connection.displayName || connection.name || connection.email || connection.id,
          quotaSupported: connection.provider === "codex" || connection.provider === "claude",
          models: allModels.filter((model) => ["llm", "imageToText"].includes(inferKind(model))).map(toOption),
          imageModels: allModels.filter((model) => inferKind(model) === "image").map(toOption),
        };
      }),
    });
  } catch (error) {
    console.log("Error fetching API key authorization options:", error);
    return NextResponse.json({ error: "Failed to fetch authorization options" }, { status: 500 });
  }
}
