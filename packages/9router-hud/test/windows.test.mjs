import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsInvocation, windowsStatusCommand, windowsTerminalArgs, installWindows, uninstallWindows, powershellArgs, psQuote } from '../src/windows.mjs';

function validateScript(script) {
  if (process.platform !== 'win32') return;
  const check = '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput(' + psQuote(script) + ',[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | Out-String | Write-Error; exit 1}';
  const result = spawnSync('powershell.exe', powershellArgs(check), { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('Windows launches use isolated Terminal windows and encoded paths without secrets', () => {
  const input = { node: 'C:\\Program Files\\nodejs\\node.exe', entry: "C:\\Users\\O'Brien\\HUD\\cli.mjs", home: "C:\\Users\\O'Brien\\HUD", id: '12345678-1234-1234-1234-123456789012', cwd: 'C:\\Projects\\日本語 project' };
  const args = windowsTerminalArgs(input);
  assert.equal(args[1], '9router-hud-' + input.id);
  assert.ok(args.includes('split-pane'));
  assert.ok(args.includes(input.cwd));
  for (const [i, arg] of args.entries()) if (arg === '-EncodedCommand') {
    const script = Buffer.from(args[i + 1], 'base64').toString('utf16le');
    validateScript(script);
    assert.ok(script.includes("O''Brien"));
    assert.ok(!script.includes('API_KEY'));
  }
  const status = windowsStatusCommand(input.node, input.entry, input.id, input.home);
  validateScript(Buffer.from(status.split(' ').at(-1), 'base64').toString('utf16le'));
  assert.ok(!status.includes(input.home));
});

test('official Windows npm shims launch Node directly and preserve JSON/prompt arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-win-shim-'));
  try {
    for (const kind of ['claude', 'codex']) {
      const relative = kind === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
      const entry = path.join(root, 'node_modules', ...relative);
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
      const args = ['--settings', '{"quoted":"日本語 & %PATH% \\"quoted\\""}', 'line one\nline two', '$(literal)'];
      const invocation = await windowsInvocation(path.join(root, kind + '.cmd'), kind, args);
      const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), args);
    }
    await assert.rejects(windowsInvocation(path.join(root, 'unknown', 'codex.cmd'), 'codex', []), /Unsupported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows installer records reversible edits and preserves unrelated wrappers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hud-win-install-'));
  const home = path.join(root, 'HUD space');
  const entry = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const profiles = [path.join(root, 'WindowsPowerShell', 'profile.ps1'), path.join(root, 'PowerShell', 'profile.ps1')];
  const scripts = [];
  const shell = script => {
    validateScript(script);
    scripts.push(script);
    return script.includes('ConvertTo-Json') ? JSON.stringify(profiles) : '';
  };
  try {
    const options = { home, entry, kinds: ['claude', 'codex'], shell, protect: async () => { await mkdir(home, { recursive: true }); } };
    await installWindows(options);
    await installWindows(options);
    const metadata = JSON.parse(await readFile(path.join(home, 'windows-install.json'), 'utf8'));
    assert.deepEqual(metadata.profiles, profiles);
    assert.match(await readFile(path.join(home, 'bin', 'codex.cmd'), 'utf8'), /DisableDelayedExpansion/);
    if (process.platform === 'win32') {
      const original = path.join(root, 'original');
      const npmEntry = path.join(original, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      await mkdir(path.dirname(npmEntry), { recursive: true });
      await writeFile(npmEntry, 'console.log("native-wrapper-ok")');
      await writeFile(path.join(original, 'codex.cmd'), '@echo off\r\n');
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
      env.PATH = path.join(home, 'bin') + ';' + original + ';' + process.env.PATH;
      const wrapped = spawnSync('cmd.exe', ['/d', '/c', 'codex --version'], { env, encoding: 'utf8' });
      assert.equal(wrapped.status, 0, wrapped.stderr);
      assert.match(wrapped.stdout, /native-wrapper-ok/);
    }
    await writeFile(path.join(home, 'bin', 'claude.cmd'), '@echo custom\r\n');
    await assert.rejects(installWindows(options), /unrelated/);
    await uninstallWindows(home, shell);
    await assert.rejects(readFile(path.join(home, 'bin', 'codex.cmd')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(home, 'bin', 'claude.cmd'), 'utf8'), '@echo custom\r\n');
    await uninstallWindows(home, shell);
    assert.ok(scripts.some(script => script.includes('Remove-ItemProperty')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
