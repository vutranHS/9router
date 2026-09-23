import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const REGISTRY = [
  { id: 'claude', alias: 'cc' }, { id: 'codex', alias: 'cx' },
  { id: 'anthropic', alias: 'anthropic' }, { id: 'openai', alias: 'openai' },
];
const coreSource = (await readFile(new URL('../../open-sse/services/model.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gm, '').replaceAll('export ', '');
const core = new Function('REGISTRY', coreSource + '\nreturn {parseModel, getModelInfoCore, resolveModelAliasFromMap};')(REGISTRY);

test('bare Claude and GPT names use subscription connections; explicit API prefixes still work', async () => {
  for (const [input, provider, model] of [
    ['claude-opus-5-5', 'claude', 'claude-opus-5-5'],
    ['claude-sonnet-5', 'claude', 'claude-sonnet-5'],
    ['gpt-5', 'codex', 'gpt-5'],
    ['cc/claude-opus-5-5', 'claude', 'claude-opus-5-5'],
    ['cx/gpt-5', 'codex', 'gpt-5'],
    ['anthropic/claude-opus-5-5', 'anthropic', 'claude-opus-5-5'],
    ['openai/gpt-5', 'openai', 'gpt-5'],
    ['o3', 'openai', 'o3'],
    ['gemini-test', 'gemini', 'gemini-test'],
  ]) assert.deepEqual(await core.getModelInfoCore(input, {}), { provider, model });
  assert.deepEqual(await core.getModelInfoCore('gpt-5', { 'gpt-5': 'openai/gpt-5' }), { provider: 'openai', model: 'gpt-5' });
});
test('actual remap service overrides new defaults once, and preserves combo expansion', async () => {
  const source = (await readFile(new URL('../../src/sse/services/model.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replaceAll('export ', '');
  const deps = {
    REGISTRY, parseModelCore: core.parseModel, getModelInfoCore: core.getModelInfoCore,
    resolveModelAliasFromMap: core.resolveModelAliasFromMap,
    getModelAliases: async () => ({ opus: 'cc/claude-opus-5-5' }),
    getComboByName: async name => name === 'my-combo' ? { models: ['cx/gpt-5'] } : null,
    getProviderNodes: async () => [],
    getRemapForKey: async key => key === 'remap-key' ? { 'claude-opus-5-5': 'cx/gpt-5', 'gpt-5': 'anthropic/claude-opus-5-5', 'my-combo': 'cx/gpt-5' } : {},
    log: { info() {}, debug() {}, maskKey: () => 'masked' },
  };
  const getModelInfo = new Function(...Object.keys(deps), source + '\nreturn getModelInfo;')(...Object.values(deps));
  for (const input of ['claude-opus-5-5', 'cc/claude-opus-5-5', 'opus']) {
    assert.deepEqual(await getModelInfo(input, 'remap-key'), { provider: 'codex', model: 'gpt-5' });
  }
  assert.deepEqual(await getModelInfo('gpt-5', 'remap-key'), { provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.deepEqual(await getModelInfo('my-combo', 'remap-key'), { provider: null, model: 'my-combo' });
  assert.deepEqual(await getModelInfo('gpt-5', 'other-key'), { provider: 'codex', model: 'gpt-5' });
});
