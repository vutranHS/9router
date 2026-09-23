import 'open-sse/index.js';
import { validateApiKey, getProviderConnectionById } from '@/lib/localDb';
import { hudSessions } from '@/lib/hud/session';
import { createQuotaHandler } from '@/lib/hud/service.mjs';
import { checkAndRefreshToken } from '@/sse/services/tokenRefresh';
import { resolveConnectionProxyConfig } from '@/lib/network/connectionProxy';
import { getUsageForProvider } from 'open-sse/services/usage.js';
import { getModelsByProviderId } from 'open-sse/config/providerModels.js';
import { modelQuotaFamily } from 'open-sse/providers/models/schema.js';

export const runtime = 'nodejs';
export const GET = createQuotaHandler({
  validateKey: validateApiKey,
  store: hudSessions,
  getConnection: getProviderConnectionById,
  quotaFamily: (provider, model) => modelQuotaFamily(getModelsByProviderId(provider).find(m => m.id === model)),
  getUsage: async connection => {
    const credentials = await checkAndRefreshToken(connection.provider, connection);
    const proxy = await resolveConnectionProxyConfig(credentials.providerSpecificData || {});
    return getUsageForProvider(credentials, proxy, { force: true });
  },
});
