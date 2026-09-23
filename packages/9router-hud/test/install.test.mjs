import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { install, uninstall, findBinary, shouldBypass } from '../src/install.mjs';

const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('one-time wrappers preserve args, find updated CLI, install idempotently and uninstall cleanly', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-install-'));
  try {
    const userHome = path.join(root, 'user');
    const home = path.join(userHome, 'HUD with spaces');
    const original = path.join(root, 'original');
    await mkdir(userHome); await mkdir(original);
    const rc = path.join(userHome, '.bashrc');
    await writeFile(rc, '# custom settings\nexport MY_SETTING=keep\n');
    for (const kind of ['claude', 'codex']) await writeFile(path.join(original, kind), '#!' + process.execPath + '\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    const env = { ...process.env, PATH: original + path.delimiter + process.env.PATH };
    const options = { home, entry, userHome, shell: '/bin/bash', env };
    const first = await install(options);
    const wrappedEnv = { ...env, PATH: first.bin + path.delimiter + env.PATH };
    await install({ ...options, env: wrappedEnv });
    assert.equal((await readFile(rc, 'utf8')).split('# >>> 9router-hud >>>').length, 2);
    assert.equal(await findBinary('claude', home, wrappedEnv), path.join(original, 'claude'));
    const aliasDir = path.join(root, 'bin-alias');
    await symlink(first.bin, aliasDir);
    assert.equal(await findBinary('claude', home, { PATH: aliasDir + path.delimiter + env.PATH }), path.join(original, 'claude'));
    for (const kind of ['claude', 'codex']) {
      const result = spawnSync(path.join(first.bin, kind), ['--version', 'space arg', "quote'arg", '$(literal)'], { env: wrappedEnv, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ['--version', 'space arg', "quote'arg", '$(literal)']);
    }
    await writeFile(path.join(original, 'claude'), '#!' + process.execPath + '\nconsole.log("updated");\n');
    const updated = spawnSync(path.join(first.bin, 'claude'), ['--version'], { env: wrappedEnv, encoding: 'utf8' });
    assert.equal(updated.stdout.trim(), 'updated');
    await uninstall(home);
    assert.equal(await readFile(rc, 'utf8'), '# custom settings\nexport MY_SETTING=keep\n');
    await assert.rejects(readFile(path.join(first.bin, 'claude')), { code: 'ENOENT' });
    await uninstall(home);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('zsh setup respects ZDOTDIR and refuses unrelated wrappers', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-zsh-'));
  try {
    const home = path.join(root, 'hud'), original = path.join(root, 'original'), zdotdir = path.join(root, 'zsh');
    await mkdir(original); await mkdir(zdotdir);
    await writeFile(path.join(original, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = await install({ home, entry, userHome: root, zdotdir, shell: '/bin/zsh', env: { PATH: original } });
    assert.deepEqual(result.kinds, ['claude']);
    assert.equal(result.rc, path.join(zdotdir, '.zshrc'));
    await writeFile(path.join(home, 'bin', 'claude'), '#!/bin/sh\necho custom\n');
    await assert.rejects(install({ home, entry, userHome: root, zdotdir, shell: '/bin/zsh', env: { PATH: original } }), /unrelated/);
    await uninstall(home);
    assert.match(await readFile(path.join(home, 'bin', 'claude'), 'utf8'), /custom/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interactive launches use HUD while automation and maintenance bypass it', () => {
  for (const kind of ['claude', 'codex']) {
    assert.equal(shouldBypass(kind, [], true, {}), false);
    assert.equal(shouldBypass(kind, ['--model', 'test'], true, {}), false);
    assert.equal(shouldBypass(kind, [], false, {}), true);
    assert.equal(shouldBypass(kind, [], true, { NINE_ROUTER_HUD_DISABLE: '1' }), true);
    assert.equal(shouldBypass(kind, ['--version'], true, {}), true);
  }
  for (const args of [['exec', 'prompt'], ['login'], ['mcp', 'list']]) assert.equal(shouldBypass('codex', args, true, {}), true);
  for (const args of [['-p', 'prompt'], ['auth', 'login'], ['update']]) assert.equal(shouldBypass('claude', args, true, {}), true);
});
