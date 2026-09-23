import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collect, contextFromClaude, render, findRollout } from '../src/data.mjs';
import { startProxy, routerBase } from '../src/proxy.mjs';

test('Claude context uses cache tokens and transcript tools, without model names', () => {
  const context = contextFromClaude({ model: { id: 'hidden' }, context_window: { context_window_size: 200000, current_usage: { input_tokens: 20000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 10000 } } });
  assert.equal(context.percent, 30);
  const { tools } = collect([
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: '1', name: 'Read' }, { type: 'tool_use', id: '2', name: 'Bash' }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: '1' }] } }),
  ], 'claude');
  assert.deepEqual(tools, { count: 2, running: ['Bash'] });
  const output = render({ context, tools, quota: { account: { label: 'a@example.com\n\x1b]0;pwn\x07' }, status: 'ok', five_hour: { used_percentage: 25 } } });
  const shown = output.replace(/\x1b\[[0-9;]*m/g, '');       // drop the HUD's own SGR colors
  assert.match(shown, /Context 30% 60.0k\/200.0k/);
  assert.match(shown, /75% left/);
  assert.match(shown, /Account a@example.com/);
  // user-supplied label is clean()'d: its newline and OSC injection never survive
  assert.equal(output.split('\n').length, 3);
  assert.ok(!output.includes('\x1b]'));
  assert.ok(!output.includes('pwn'));
  assert.ok(!output.includes('hidden'));
});
test('Codex uses last context usage, ignores cumulative tokens, tracks custom calls', () => {
  const state = collect([
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 9999999 }, last_token_usage: { total_tokens: 50000 }, model_context_window: 100000 } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'a', name: 'apply_patch' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'a' } }),
  ], 'codex');
  assert.equal(state.context.percent, 50);
  assert.deepEqual(state.tools, { count: 1, running: [] });
});
test('rollout lookup never substitutes another terminal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hud-rollout-'));
  try {
    await mkdir(path.join(dir, '2026', '09', '23'), { recursive: true });
    const id = '12345678-1234-1234-1234-123456789012';
    const file = path.join(dir, '2026', '09', '23', 'rollout-time-' + id + '.jsonl');
    await writeFile(file, '');
    assert.equal(await findRollout(dir, id), file);
    assert.equal(await findRollout(dir, '22345678-1234-1234-1234-123456789012'), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('proxy streams SSE and binds every request to the configured key/session', async () => {
  let captured;
  const upstream = http.createServer((req, res) => {
    captured = { headers: req.headers, url: req.url };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '40' });
    res.write('data: {"type":"response.created"}\n\n');
    res.end('data: {"type":"response.completed"}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const proxy = await startProxy({ base: base + '/v1', key: 'router-key', session: 'session-1234567890' });
  try {
    const r = await fetch(proxy.base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer other', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.headers.get('x-codex-primary-used-percent'), '40');
    assert.match(await r.text(), /response.completed/);
    assert.equal(captured.headers.authorization, 'Bearer router-key');
    assert.equal(captured.headers['x-9router-session'], 'session-1234567890');
    assert.equal(captured.url, '/v1/responses');
    assert.equal((await fetch(proxy.base + '/v1/messages', { headers: { origin: 'http://evil.test' } })).status, 403);
    assert.equal(routerBase(base + '/v1/'), base);
  } finally { proxy.close(); upstream.close(); upstream.closeAllConnections(); }
});
