import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectClaude, detectCodex } from '../src/detect.mjs';

async function tmp() { return mkdtemp(path.join(os.tmpdir(), 'hud-detect-')); }

test('detectClaude reads endpoint and token from settings.json env', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://sv3.9router.link/v1', ANTHROPIC_AUTH_TOKEN: 'sk-test', OTHER: 'x' },
      model: 'opus',
    }));
    assert.deepEqual(detectClaude(dir), { url: 'https://sv3.9router.link/v1', key: 'sk-test' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('detectClaude returns {} when file or env keys are missing', async () => {
  const dir = await tmp();
  try {
    assert.deepEqual(detectClaude(dir), {});                       // no file
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }));
    assert.deepEqual(detectClaude(dir), { url: undefined, key: undefined });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('detectCodex resolves base_url and the env var named by env_key', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'config.toml'), [
      'model = "gpt-6-astra"',
      'model_provider = "9router"   # active provider',
      '',
      '[model_providers.9router]',
      'name = "9Router"',
      "base_url = 'https://sv2.9router.link/v1'",
      'env_key = "NINEROUTER_API_KEY"',
      'wire_api = "responses"',
    ].join('\n'));
    const got = detectCodex(dir, { NINEROUTER_API_KEY: 'sk-codex' });
    assert.deepEqual(got, { url: 'https://sv2.9router.link/v1', key: 'sk-codex' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('detectCodex leaves key undefined when the env var is unset', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'config.toml'), [
      'model_provider = "9router"',
      '[model_providers.9router]',
      'base_url = "https://sv2.9router.link/v1"',
      'env_key = "NINEROUTER_API_KEY"',
    ].join('\n'));
    assert.deepEqual(detectCodex(dir, {}), { url: 'https://sv2.9router.link/v1', key: undefined });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('detectCodex returns {} without a config file or model_provider', async () => {
  const dir = await tmp();
  try {
    assert.deepEqual(detectCodex(dir, {}), {});                    // no file
    await writeFile(path.join(dir, 'config.toml'), '[model_providers.other]\nbase_url = "https://x/v1"\n');
    assert.deepEqual(detectCodex(dir, {}), {});                    // no top-level model_provider
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('detectCodex ignores base_url from a non-active provider section', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'config.toml'), [
      'model_provider = "9router"',
      '[model_providers.openai]',
      'base_url = "https://api.openai.com/v1"',
      'env_key = "OPENAI_API_KEY"',
      '[model_providers.9router]',
      'base_url = "https://sv2.9router.link/v1"',
      'env_key = "NINEROUTER_API_KEY"',
    ].join('\n'));
    const got = detectCodex(dir, { NINEROUTER_API_KEY: 'sk-codex', OPENAI_API_KEY: 'sk-openai' });
    assert.deepEqual(got, { url: 'https://sv2.9router.link/v1', key: 'sk-codex' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
