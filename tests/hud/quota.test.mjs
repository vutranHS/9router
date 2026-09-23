import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from '../../src/lib/hud/store.mjs';
import { createQuotaHandler, normalizeQuota } from '../../src/lib/hud/service.mjs';

test('persistent bindings isolate keys/sessions and follow successful fallback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hud-'));
  try {
    const store = createSessionStore(dir);
    const s = 'session-1234567890';
    await store.record('key-a', s, 'account-a', 'private-model');
    assert.equal(await store.read('key-b', s), null);
    assert.equal(await store.read('key-a', s + 'other'), null);
    await store.record('key-a', s, 'account-b', 'remapped-model');
    assert.equal((await createSessionStore(dir).read('key-a', s)).connectionId, 'account-b');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.ok(!files[0].includes('key-a'));
    assert.ok(!(await readFile(path.join(dir, files[0]), 'utf8')).includes('key-a'));
    assert.equal(await store.read('key-a', '../escape'), null);
    assert.equal(await store.read('key-a', s, Date.now() + 86400001), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('quota requires an active key, hides models/tokens, caches and preserves stale timestamp', async () => {
  let clock = 1000000, requests = 0, fail = false;
  const handler = createQuotaHandler({
    validateKey: async k => k === 'valid',
    store: { read: async (k, s) => s.endsWith('waiting') ? null : { connectionId: 'c', model: 'secret-remap', lastUsedAt: clock } },
    getConnection: async () => ({ id: 'c', provider: 'claude', authType: 'oauth', email: 'test@example.com', accessToken: 'SECRET' }),
    getUsage: async () => { requests++; if (fail) throw Error('SECRET upstream error'); return { quotas: { 'session (5h)': { used: 40, total: 100, resetAt: '2030-01-01' }, 'weekly (7d)': { used: 80, total: 100 } } }; },
    now: () => clock,
  });
  const req = (key = 'valid', session = 'session-1234567890') => new Request('http://router/v1/hud/quota?session=' + session, { headers: { Authorization: 'Bearer ' + key } });
  assert.equal((await handler(req('invalid'))).status, 401);
  assert.equal((await handler(req('valid', 'short'))).status, 400);
  assert.equal((await (await handler(req('valid', 'session-123waiting'))).json()).status, 'waiting');
  const [a, b] = await Promise.all([handler(req()), handler(req())]);
  assert.equal(requests, 1);
  const body = await a.json();
  assert.equal(body.account.label, 'test@example.com');
  assert.equal(body.five_hour.used_percentage, 40);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(body).includes('SECRET'));
  assert.ok(!JSON.stringify(body).includes('secret-remap'));
  await b.json();
  clock += 300001; fail = true;
  const stale = await (await handler(req())).json();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.updated_at, body.updated_at);
  assert.equal(stale.five_hour.used_percentage, 40);
});
test('Codex windows respect upstream duration and model quota family', () => {
  const primary = { used: 25, total: 100, windowSeconds: 604800 };
  assert.equal(normalizeQuota({ quotas: { session: primary } }).five_hour, null);
  assert.equal(normalizeQuota({ quotas: { session: primary } }).seven_day.used_percentage, 25);
  assert.equal(normalizeQuota({ quotas: { session: { ...primary, windowSeconds: 3600 } } }).five_hour, null);
  assert.equal(normalizeQuota({ quotas: { spark_session: { ...primary, windowSeconds: 18000 }, session: primary } }, 'spark').five_hour.used_percentage, 25);
  assert.equal(normalizeQuota({ quotas: {} }).seven_day, null);
  // Codex may omit limit_window_seconds; map by role (primary=5h, secondary=7d)
  // instead of dropping both windows — otherwise the HUD shows "5h -- | 7d --".
  const noDuration = normalizeQuota({ quotas: {
    session: { used: 10, total: 100 }, weekly: { used: 30, total: 100 },
  } });
  assert.equal(noDuration.five_hour.used_percentage, 10);
  assert.equal(noDuration.seven_day.used_percentage, 30);
  // A lone primary with no duration is still the 5h window; no weekly means 7d stays null.
  const loneNoDuration = normalizeQuota({ quotas: { session: { used: 10, total: 100 } } });
  assert.equal(loneNoDuration.five_hour.used_percentage, 10);
  assert.equal(loneNoDuration.seven_day, null);
});
