import { access, readFile, writeFile, mkdir, rm, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installWindows, uninstallWindows } from './windows.mjs';

const marker = '# 9router-hud managed wrapper';
const begin = '# >>> 9router-hud >>>';
const end = '# <<< 9router-hud <<<';
export const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
async function read(file) { try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
export async function findBinary(kind, home, env = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path;
  const wrapperDir = paths.resolve(home, 'bin');
  const normalize = value => windows ? value.toLowerCase() : value;
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const extensions = windows ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const dir of pathValue.split(windows ? ';' : path.delimiter)) {
    if (normalize(paths.resolve(dir || '.')) === normalize(wrapperDir)) continue;
    for (const extension of extensions) {
      const file = paths.resolve(dir || '.', kind + extension);
      try {
        await access(file, windows ? constants.F_OK : constants.X_OK);
        const target = await realpath(file);
        if (normalize(target).startsWith(normalize(wrapperDir + paths.sep))) continue;
        const handle = await open(file, 'r');
        let prefix;
        try { const buffer = Buffer.alloc(256); const { bytesRead } = await handle.read(buffer, 0, 256, 0); prefix = buffer.subarray(0, bytesRead).toString(); } finally { await handle.close(); }
        if (prefix.includes(marker.slice(2))) continue;
        return file;
      } catch (e) { if (!['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR'].includes(e.code)) throw e; }
    }
  }
  throw new Error('Cannot find original ' + kind + ' on PATH. Install the CLI first.');
}
export function shouldBypass(kind, args, interactive, env = process.env) {
  if (env.NINE_ROUTER_HUD_DISABLE === '1' || !interactive) return true;
  if (args.some(a => ['--version', '-v', '-V', '--help', '-h'].includes(a))) return true;
  if (kind === 'claude') return args.some(a => ['-p', '--print'].includes(a)) || ['auth', 'update', 'install', 'doctor', 'mcp', 'plugin', 'setup-token'].includes(args[0]);
  return ['exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'features'].includes(args[0]);
}
function stripBlock(text) {
  const start = text.indexOf(begin);
  if (start < 0) return text;
  const finish = text.indexOf(end, start);
  if (finish < 0) throw new Error('Incomplete 9router-hud shell block; repair it before installing.');
  return text.slice(0, start) + text.slice(finish + end.length).replace(/^\n/, '');
}
export async function install({ home, entry, shell = process.env.SHELL, userHome = os.homedir(), zdotdir = process.env.ZDOTDIR, env = process.env }) {
  if (process.platform === 'win32') {
    const kinds = [];
    for (const kind of ['claude', 'codex']) {
      try { await findBinary(kind, home, env); kinds.push(kind); } catch (e) { if (!e.message.startsWith('Cannot find original')) throw e; }
    }
    if (!kinds.length) throw new Error('Install Claude Code or Codex CLI first.');
    return installWindows({ home, entry, kinds });
  }
  const name = path.basename(shell || 'bash');
  if (!['bash', 'zsh'].includes(name)) throw new Error('Automatic installation supports bash and zsh. Use the explicit HUD launcher for other shells.');
  const bin = path.join(home, 'bin');
  const rc = name === 'zsh' ? path.join(zdotdir || userHome, '.zshrc') : path.join(userHome, '.bashrc');
  const rcs = [rc];
  if (name === 'bash') {
    let login = path.join(userHome, '.profile');
    for (const file of ['.bash_profile', '.bash_login', '.profile']) {
      try { await access(path.join(userHome, file)); login = path.join(userHome, file); break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    rcs.push(login);
  }
  const originals = await Promise.all(rcs.map(async file => stripBlock(await read(file))));
  const kinds = [];
  for (const kind of ['claude', 'codex']) {
    try { await findBinary(kind, home, env); kinds.push(kind); } catch (e) { if (!e.message.startsWith('Cannot find original')) throw e; }
  }
  if (!kinds.length) throw new Error('Install Claude Code or Codex CLI first.');
  for (const kind of kinds) {
    const current = await read(path.join(bin, kind));
    if (current && !current.includes(marker)) throw new Error('Refusing to replace unrelated file: ' + path.join(bin, kind));
  }
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const kind of kinds) {
    const body = '#!/bin/sh\n' + marker + '\nexport NINE_ROUTER_HUD_HOME=' + quote(home) + '\nexec ' + quote(process.execPath) + ' ' + quote(entry) + ' auto ' + kind + ' "$@"\n';
    await writeFile(path.join(bin, kind), body, { mode: 0o755 });
  }
  const block = begin + '\nexport PATH=' + quote(bin) + ':"$PATH"\n' + end + '\n';
  for (const [i, file] of rcs.entries()) {
    const cleaned = originals[i];
    await writeFile(file, cleaned + (cleaned.endsWith('\n') || !cleaned ? '' : '\n') + block);
  }
  const previous = JSON.parse(await read(path.join(home, 'wrapper-install.json')) || '{}');
  await writeFile(path.join(home, 'wrapper-install.json'), JSON.stringify({ rcs: [...new Set([...(previous.rcs || []), ...rcs])] }), { mode: 0o600 });
  return { kinds, rc, bin };
}
export async function uninstall(home) {
  if (process.platform === 'win32') return uninstallWindows(home);
  const metadata = await read(path.join(home, 'wrapper-install.json'));
  if (metadata) {
    const { rcs } = JSON.parse(metadata);
    for (const rc of rcs) await writeFile(rc, stripBlock(await read(rc)));
  }
  for (const kind of ['claude', 'codex']) {
    const file = path.join(home, 'bin', kind);
    if ((await read(file)).includes(marker)) await rm(file);
  }
  await rm(path.join(home, 'wrapper-install.json'), { force: true });
}
