import { mkdir, mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'public', 'downloads');
await mkdir(destination, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), '9router-hud-pack-'));
try {
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', temp];
  const npmCli = process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync);
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: path.join(root, 'packages', '9router-hud'), encoding: 'utf8' })
    : spawnSync('npm', args, { cwd: path.join(root, 'packages', '9router-hud'), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'HUD packaging failed');
  const [{ filename }] = JSON.parse(result.stdout);
  const file = path.join(temp, path.basename(filename));
  // Validate successful output before publishing the stable download URL.
  if (!(await readFile(file)).length) throw new Error('Empty HUD package');
  await copyFile(file, path.join(destination, '9router-hud.tgz'));
  console.log('[hud] Bundled /downloads/9router-hud.tgz');
} finally { await rm(temp, { recursive: true, force: true }); }
