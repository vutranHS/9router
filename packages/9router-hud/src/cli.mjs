#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { collect, contextFromClaude, tailLines, findRollout, render } from './data.mjs';
import { routerBase, startProxy } from './proxy.mjs';
import { Writable } from 'node:stream';
import { protectWindowsHome, windowsInvocation, windowsStatusCommand, windowsTerminalArgs } from './windows.mjs';
import { findBinary, shouldBypass, install, uninstall } from './install.mjs';
import { detectClaude, detectCodex, claudeDir, codexHome } from './detect.mjs';

const entry = fileURLToPath(import.meta.url);
const home = process.env.NINE_ROUTER_HUD_HOME || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), '9router-hud') : path.join(os.homedir(), '.config', '9router-hud'));
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const valid = s => /^[a-f0-9-]{36}$/i.test(s || '');
const dirFor = id => { if (!valid(id)) throw new Error('Invalid session'); return path.join(home, 'sessions', id); };
async function json(file, fallback = {}) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } }
async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
// Per-CLI endpoint + key. Resolve base and key independently down the chain:
// explicit env → auto-detect from the CLI's own config → HUD config.json.
async function detectFor(kind) {
  if (kind === 'claude') return detectClaude(claudeDir());
  if (kind === 'codex') return detectCodex(codexHome());
  return {};
}
async function config(kind) {
  const c = await json(path.join(home, 'config.json'));
  const detected = await detectFor(kind);
  const base = process.env.NINE_ROUTER_URL || detected.url || c.url;
  const key = process.env.NINE_ROUTER_API_KEY || detected.key || c.apiKey;
  if (!base || !key) throw new Error('Cannot resolve router endpoint/key for ' + (kind || 'CLI') + '. Configure ' + (kind === 'codex' ? 'Codex (config.toml)' : 'Claude (settings.json)') + ', run 9router-hud setup, or set NINE_ROUTER_URL and NINE_ROUTER_API_KEY.');
  return { base: routerBase(base), key };
}
// install/setup validation: at least one CLI must be resolvable.
async function ensureConfigured() {
  const kinds = ['claude', 'codex'];
  const results = await Promise.all(kinds.map(k => config(k).then(c => ({ k, c })).catch(() => null)));
  const ok = results.filter(Boolean);
  if (!ok.length) throw new Error('No router endpoint/key detected from Claude settings.json or Codex config.toml. Run 9router-hud configure --url URL --key-stdin, or set NINE_ROUTER_URL and NINE_ROUTER_API_KEY.');
  return ok;
}
async function configure(args) {
  if (process.platform === 'win32') await protectWindowsHome(home);
  const old = await json(path.join(home, 'config.json'));
  const at = args.indexOf('--url');
  let url = at >= 0 ? args[at + 1] : process.env.NINE_ROUTER_URL || old.url;
  if (!url) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    url = await rl.question('9router URL: ');
    rl.close();
  }
  const next = { ...old, url: routerBase(url) };
  if (args.includes('--key-stdin')) {
    let key = '';
    for await (const chunk of process.stdin) key += chunk;
    next.apiKey = key.trim();
    if (!next.apiKey) throw new Error('Empty key');
  }
  await save(path.join(home, 'config.json'), next);
  console.log('Saved router URL. API key: use NINE_ROUTER_API_KEY or configure --key-stdin.');
}
async function showClaude(id) {
  let raw = '';
  for await (const c of process.stdin) { raw += c; if (raw.length > 2 * 1024 * 1024) return; }
  const stdin = JSON.parse(raw || '{}');
  const state = await json(path.join(dirFor(id), 'state.json'));
  const activity = collect(await tailLines(stdin.transcript_path), 'claude');
  console.log(render({ ...state, context: contextFromClaude(stdin), tools: activity.tools }));
}
async function watch(id) {
  const print = async () => {
    try { await access(dirFor(id)); } catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
    const state = await json(path.join(dirFor(id), 'state.json'));
    if (state.pid) { try { process.kill(state.pid, 0); } catch (error) { if (error.code === 'ESRCH') process.exit(0); } }
    const output = render(state).split('\n').map(l => l.slice(0, process.stdout.columns || 160) + '\x1b[0m').join('\n');
    process.stdout.write('\x1b[2J\x1b[H' + output);
  };
  await print();
  setInterval(() => { void print(); }, 1000);
}
async function run(kind, id, args, c, tmuxName = null) {
  const binary = await findBinary(kind, home);
  const baseInvocation = process.platform === 'win32' ? await windowsInvocation(binary, kind, []) : { command: binary, args: [] };
  const rest = [...args];
  let settings = {};
  if (kind === 'claude') {
    const at = rest.indexOf('--settings');
    if (at >= 0) {
      const supplied = rest[at + 1];
      if (!supplied) throw new Error('--settings requires a JSON object or file');
      settings = supplied.trim().startsWith('{') ? JSON.parse(supplied) : JSON.parse(await readFile(supplied, 'utf8'));
      rest.splice(at, 2);
    }
  }
  const dir = dirFor(id);
  const state = { pid: process.pid, quota: { status: 'waiting' }, tools: { count: 0, running: [] } };
  let cliSession = null, rollout = null, busy = false, closed = false, lastQuota = 0;
  const statePath = path.join(dir, 'state.json');
  await save(statePath, state);
  const refresh = async (force = false) => {
    if (busy || closed) return;
    busy = true;
    try {
      if (force || Date.now() - lastQuota >= 15000) {
        lastQuota = Date.now();
        try {
          const response = await fetch(c.base + '/v1/hud/quota?session=' + encodeURIComponent(id), {
            headers: { Authorization: 'Bearer ' + c.key }, redirect: 'error', signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error('Quota unavailable');
          state.quota = await response.json();
          state.offline = false;
        } catch { state.offline = true; }
      }
      if (kind === 'codex' && cliSession) {
        rollout ||= await findRollout(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), cliSession);
        Object.assign(state, collect(await tailLines(rollout), 'codex'));
      }
      if (!closed) await save(statePath, state);
    } finally { busy = false; }
  };
  const proxy = await startProxy({
    ...c, session: id,
    onRequest: request => {
      const candidate = request.headers.session_id || request.headers['x-client-request-id'];
      if (kind === 'codex' && valid(candidate) && candidate !== cliSession) {
        cliSession = candidate;
        rollout = null;
      }
    },
    onResponse: () => { void refresh(true).catch(() => {}); },
  });
  const env = { ...process.env, NINE_ROUTER_API_KEY: c.key };
  let launchArgs;
  if (kind === 'claude') {
    env.ANTHROPIC_BASE_URL = proxy.base;
    env.ANTHROPIC_AUTH_TOKEN = c.key;
    delete env.ANTHROPIC_API_KEY;
    const command = process.platform === 'win32' ? windowsStatusCommand(process.execPath, entry, id, home) : [process.execPath, entry, 'status', id].map(quote).join(' ');
    // Force the proxy at highest precedence: settings supplied via --settings beat
    // ~/.claude/settings.json env and OS env vars, so a stale ANTHROPIC_BASE_URL left
    // in settings.json can no longer bypass the HUD proxy. Written to a 0600 file in
    // the session dir (removed on exit) so the token never appears in child argv.
    const merged = {
      ...settings,
      env: { ...(settings.env || {}), ANTHROPIC_BASE_URL: proxy.base, ANTHROPIC_AUTH_TOKEN: c.key, ANTHROPIC_API_KEY: '' },
      statusLine: { type: 'command', command },
    };
    const settingsPath = path.join(dir, 'claude-settings.json');
    await save(settingsPath, merged);
    launchArgs = [...rest, '--settings', settingsPath];
  } else {
    const settings = [
      'model_provider="nine-router-hud"',
      'model_providers.nine-router-hud.name="9Router HUD"',
      'model_providers.nine-router-hud.base_url=' + JSON.stringify(proxy.base + '/v1'),
      'model_providers.nine-router-hud.wire_api="responses"',
      'model_providers.nine-router-hud.env_key="NINE_ROUTER_API_KEY"',
    ];
    launchArgs = [...args, ...settings.flatMap(s => ['-c', s])];
  }
  const interval = setInterval(() => { void refresh().catch(() => {}); }, 2000);
  const invocation = { command: baseInvocation.command, args: [...baseInvocation.args, ...launchArgs] };
  const child = spawn(invocation.command, invocation.args, { stdio: 'inherit', env });
  const forward = signal => { if (!child.killed) child.kill(signal); };
  const term = () => forward('SIGTERM');
  process.on('SIGTERM', term);
  const interrupt = () => {}; // Foreground CLI receives terminal SIGINT itself.
  process.on('SIGINT', interrupt);
  const code = await new Promise(resolve => {
    child.once('error', error => { console.error('Cannot launch ' + kind + ': ' + error.message); resolve(1); });
    child.once('exit', code => resolve(code ?? 1));
  });
  closed = true;
  clearInterval(interval);
  proxy.close();
  process.off('SIGTERM', term);
  process.off('SIGINT', interrupt);
  await rm(dir, { recursive: true, force: true });
  if (tmuxName) spawnSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' });
  process.exitCode = code;
}
async function launchCodex(args, c) {
  await findBinary('codex', home);
  if (process.platform === 'win32') {
    await protectWindowsHome(home);
    const id = randomUUID();
    const dir = dirFor(id);
    await save(path.join(dir, 'launch.json'), { c, args, codexHome: process.env.CODEX_HOME, path: process.env.PATH, cwd: process.cwd() });
    // Do NOT pass windowsHide here: wt.exe is a GUI launcher and windowsHide
    // (CREATE_NO_WINDOW) suppresses the Terminal window entirely — it reports
    // success but no window ever appears.
    const started = spawnSync('wt.exe', windowsTerminalArgs({ node: process.execPath, entry, home, id, cwd: process.cwd() }), { encoding: 'utf8' });
    if (started.status !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error('Cannot launch Windows Terminal. Install Windows Terminal and enable its wt.exe app execution alias. ' + (started.stderr || started.error?.message || ''));
    }
    console.log('Codex + HUD opened in Windows Terminal.');
    return;
  }
  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) throw new Error('Install tmux first (brew install tmux / apt install tmux).');
  const id = randomUUID();
  const name = '9router-hud-' + id.slice(0, 8);
  const dir = dirFor(id);
  // Private handoff avoids exposing the API key in tmux command arguments.
  await save(path.join(dir, 'launch.json'), { c, args, tmuxName: name, codexHome: process.env.CODEX_HOME });
  const command = [process.execPath, entry, 'runner', id].map(quote).join(' ');
  const start = spawnSync('tmux', ['new-session', '-d', '-s', name, '-e', 'NINE_ROUTER_HUD_HOME=' + home, '-e', 'PATH=' + process.env.PATH, '-c', process.cwd(), command], { encoding: 'utf8' });
  if (start.status !== 0) { await rm(dir, { recursive: true, force: true }); throw new Error(start.stderr || 'tmux failed'); }
  const pane = [process.execPath, entry, 'watch', id].map(quote).join(' ');
  const split = spawnSync('tmux', ['split-window', '-t', name + ':0', '-v', '-l', '3', pane], { encoding: 'utf8' });
  if (split.status !== 0) {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
    await rm(dir, { recursive: true, force: true });
    throw new Error(split.stderr || 'Cannot create HUD pane; enlarge terminal.');
  }
  spawnSync('tmux', ['select-pane', '-t', name + ':0.0'], { stdio: 'ignore' });
  spawnSync('tmux', [process.env.TMUX ? 'switch-client' : 'attach-session', '-t', name], { stdio: 'inherit' });
}
async function main() {
  const [command, ...raw] = process.argv.slice(2);
  const args = raw[0] === '--' ? raw.slice(1) : raw;
  if (command === 'install') {
    await ensureConfigured();
    const result = await install({ home, entry });
    console.log('Installed wrappers: ' + result.kinds.join(', ') + '. Open a new terminal, then type claude or codex.');
    console.log('Shell configuration: ' + result.rc + '. Existing shell aliases/functions must be removed manually if they shadow these commands.');
    return;
  }
  if (command === 'uninstall') {
    await uninstall(home);
    console.log('Wrappers removed. Open a new terminal. Endpoint and API key configuration retained.');
    return;
  }
  if (command === 'setup') {
    if (process.platform === 'win32') await protectWindowsHome(home);
    // Auto-detect first from the CLIs' own config. Only fall back to the manual
    // URL/key prompt when neither Claude nor Codex resolves.
    let detected = await ensureConfigured().catch(() => null);
    if (!detected) {
      await configure(args);
      const saved = await json(path.join(home, 'config.json'));
      if (!saved.apiKey) {
        if (process.env.NINE_ROUTER_API_KEY) saved.apiKey = process.env.NINE_ROUTER_API_KEY;
        else {
          if (!process.stdin.isTTY) throw new Error('No config detected. Use setup --url URL --key-stdin for noninteractive setup.');
          process.stdout.write('9router API key (hidden): ');
          const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
          const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
          try { saved.apiKey = (await rl.question('')).trim(); } finally { rl.close(); process.stdout.write('\n'); }
        }
        if (!saved.apiKey) throw new Error('Empty key');
        await save(path.join(home, 'config.json'), saved);
      }
      detected = await ensureConfigured();
    }
    for (const { k, c } of detected) console.log('Detected ' + k + ' endpoint: ' + c.base);
    const result = await install({ home, entry });
    console.log('Setup complete: ' + result.kinds.join(', ') + '. Open a new terminal, then type claude or codex.');
    console.log('Codex HUD requires Windows Terminal on Windows, or tmux on macOS/Linux. Restart your terminal app; remove existing claude/codex aliases if they shadow the wrappers.');
    return;
  }
  if (command === 'auto') {
    const [kind, ...rest] = args;
    if (!['claude', 'codex'].includes(kind)) throw new Error('Unknown CLI');
    if (shouldBypass(kind, rest, process.stdin.isTTY && process.stdout.isTTY)) {
      const binary = await findBinary(kind, home);
      const invocation = process.platform === 'win32' ? await windowsInvocation(binary, kind, rest) : { command: binary, args: rest };
      const child = spawn(invocation.command, invocation.args, { stdio: 'inherit' });
      const term = () => child.kill('SIGTERM');
      process.on('SIGTERM', term);
      const interrupt = () => {};
      process.on('SIGINT', interrupt);
      process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
      process.off('SIGTERM', term);
      process.off('SIGINT', interrupt);
      return;
    }
    const c = await config(kind);
    return kind === 'claude' ? run(kind, randomUUID(), rest, c) : launchCodex(rest, c);
  }
  if (command === 'configure') return configure(args);
  if (command === 'status') return showClaude(args[0]);
  if (command === 'watch') return watch(args[0]);
  if (command === 'runner') {
    const file = path.join(dirFor(args[0]), 'launch.json');
    const launch = await json(file);
    await rm(file, { force: true });
    if (!launch.c) throw new Error('Missing launch configuration');
    if (launch.codexHome) process.env.CODEX_HOME = launch.codexHome;
    if (launch.path) process.env.PATH = launch.path;
    if (launch.cwd) process.chdir(launch.cwd);
    try { return await run('codex', args[0], launch.args, launch.c, launch.tmuxName); }
    catch (error) { await rm(dirFor(args[0]), { recursive: true, force: true }); throw error; }
  }
  if (command === 'claude') {
    if (process.platform === 'win32') await protectWindowsHome(home);
    return run('claude', randomUUID(), args, await config('claude'));
  }
  if (command === 'codex') return launchCodex(args, await config('codex'));
  console.log('9router-hud setup   # auto-detects endpoint/key from Claude settings.json and Codex config.toml\n9router-hud install | uninstall\n9router-hud configure --url https://router.example [--key-stdin]   # optional manual fallback\n9router-hud claude -- [Claude arguments]\n9router-hud codex -- [Codex arguments]\nRequires Node 20+; Codex needs Windows Terminal (Windows) or tmux (macOS/Linux). No model names are displayed.');
}
main().catch(error => { console.error('9router-hud: ' + error.message); process.exitCode = 1; });
