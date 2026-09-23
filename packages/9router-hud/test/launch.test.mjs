import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function execute(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    child.once('error', reject);
    child.once('exit', code => resolve({ code, out, err }));
  });
}
for (const kind of ['claude', 'codex']) test(kind + ' launcher: proxy → router → quota → HUD, without real credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hud-launch-'));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  const sessions = new Set();
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401).end(); return; }
    if (req.url.startsWith('/v1/hud/quota')) {
      const id = new URL(req.url, 'http://router').searchParams.get('session');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(sessions.has(id) ? {
        status: 'ok', account: { label: 'account@example.com' }, updated_at: new Date().toISOString(),
        five_hour: { used_percentage: 20 }, seven_day: { used_percentage: 30 },
      } : { status: 'waiting' }));
    } else {
      sessions.add(req.headers['x-9router-session']);
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"type":"response.completed"}\n\n');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const code = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const path = require("node:path"); const cp = require("node:child_process");',
    '(async () => {',
    'const kind = ' + JSON.stringify(kind) + ';',
    'let url;',
    'if (kind === "claude") url = process.env.ANTHROPIC_BASE_URL + "/v1/messages";',
    'else { const a=process.argv.find(x=>x.startsWith("model_providers.nine-router-hud.base_url=")); url=JSON.parse(a.slice(a.indexOf("=")+1))+"/responses"; }',
    'const thread="12345678-1234-1234-1234-123456789012";',
    'if(kind==="codex"){const d=path.join(process.env.CODEX_HOME,"sessions","2026","09","23");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,"rollout-time-"+thread+".jsonl"),JSON.stringify({type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{total_tokens:50000},model_context_window:200000}}})+"\\n");}',
    'const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","session_id":thread},body:"{}"});await response.text();',
    'await new Promise(r=>setTimeout(r,2400));',
    'if(kind==="claude"){const at=process.argv.indexOf("--settings");const settings=JSON.parse(process.argv[at+1]); const result=cp.spawnSync(settings.statusLine.command,{shell:true,encoding:"utf8",input:JSON.stringify({context_window:{used_percentage:25,context_window_size:200000,current_usage:{input_tokens:50000}}})});process.stdout.write(result.stdout);if(result.status)throw Error(result.stderr);}',
    'else {const root=path.join(process.env.NINE_ROUTER_HUD_HOME,"sessions");const id=fs.readdirSync(root)[0];const s=JSON.parse(fs.readFileSync(path.join(root,id,"state.json")));console.log(JSON.stringify(s));}',
    '})().catch(e=>{console.error(e.message);process.exitCode=1;});',
  ].join('\n');
  if (process.platform === 'win32') {
    const relative = kind === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
    const fixture = path.join(bin, 'node_modules', ...relative);
    await mkdir(path.dirname(fixture), { recursive: true });
    await writeFile(fixture, code);
    await writeFile(path.join(bin, kind + '.cmd'), '@echo off\r\n');
  } else await writeFile(path.join(bin, kind), code, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, NINE_ROUTER_HUD_HOME: home, NINE_ROUTER_URL: base, NINE_ROUTER_API_KEY: 'test-key', CODEX_HOME: path.join(dir, 'codex') };
  try {
    let args = ['claude'];
    if (kind === 'codex') {
      const id = '22345678-1234-1234-1234-123456789012';
      const d = path.join(home, 'sessions', id);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, 'launch.json'), JSON.stringify({ c: { base, key: 'test-key' }, args: [], codexHome: env.CODEX_HOME }));
      args = ['runner', id];
    }
    const result = await execute(args, env);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /account@example.com/);
    assert.match(result.out, kind === 'claude' ? /5h 80% left/ : /"used_percentage":20/);
    assert.match(result.out, kind === 'claude' ? /Context 25%/ : /"percent":25/);
    assert.ok(!result.out.includes('test-key'));
    assert.equal(sessions.size, 1);
    assert.deepEqual(await readdir(path.join(home, 'sessions')), []);
  } finally {
    server.close(); server.closeAllConnections();
    await rm(dir, { recursive: true, force: true });
  }
});
