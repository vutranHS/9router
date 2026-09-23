import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('real chat handler records only successful post-remap/fallback account', async () => {
  let source = await readFile(new URL('../../src/sse/handlers/chat.js', import.meta.url), 'utf8');
  source = source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export async function handleChat', 'async function handleChat');
  const records = [], attempts = [];
  let failuresOnly = false;
  const noop = () => {};
  const deps = {
    getSettings: async () => ({ requireApiKey: true }),
    extractApiKey: () => 'client-key', isValidApiKey: async () => true,
    stripModelContextMarker: s => ({ model: s, contextMarker: null }),
    handleBypassRequest: () => null, detectRequiredCapabilities: () => new Set(),
    getComboModels: async () => null, augmentModelsWithCapacityAdapter: a => a,
    getModelInfo: async () => ({ provider: 'codex', model: 'secret-remapped-model' }),
    getProviderCredentials: async (provider, excluded) => excluded.size >= (failuresOnly ? 1 : 2) ? null : ({ connectionId: excluded.size ? 'account-b' : 'account-a' }),
    checkAndRefreshToken: async (p, c) => c,
    handleChatCore: async ({ connectionId }) => {
      attempts.push(connectionId);
      return connectionId === 'account-a' ? { success: false, status: 429, error: 'quota' } : { success: true, response: new Response('ok') };
    },
    markAccountUnavailable: async () => ({ shouldFallback: true }),
    recordHudSession: async (...args) => records.push(args.slice(1)),
    detectFormatByEndpoint: () => 'claude', DEFAULT_HEADROOM_URL: '', appendPxpipeEvent: noop,
    log: { warn: noop, info: noop, debug: noop, maskKey: () => 'masked' },
    errorResponse: (s, m) => new Response(m, { status: s }),
    HTTP_STATUS: { SERVICE_UNAVAILABLE: 503, BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404 },
  };
  const handler = new Function(...Object.keys(deps), source + '\nreturn handleChat;')(...Object.values(deps));
  const request = () => new Request('http://router/v1/messages', { method: 'POST', headers: { authorization: 'Bearer client-key', 'x-9router-session': 'session-1234567890' }, body: JSON.stringify({ model: 'requested-alias', messages: [] }) });
  const result = await handler(request());
  assert.equal(await result.text(), 'ok');
  assert.deepEqual(attempts, ['account-a', 'account-b']);
  assert.deepEqual(records, [['client-key', 'account-b', 'secret-remapped-model']]);
  records.length = 0; failuresOnly = true;
  await handler(request());
  assert.equal(records.length, 0);
});
