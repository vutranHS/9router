import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

export const clean = (s, max = 100) => String(s ?? '').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);
export function contextFromClaude(data) {
  const w = data?.context_window;
  if (!w) return null;
  const u = w.current_usage;
  const used = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null;
  const total = w.context_window_size;
  const percent = Number.isFinite(w.used_percentage) ? w.used_percentage : used != null && total > 0 ? used / total * 100 : null;
  return { used, total, percent };
}
export function collect(lines, kind) {
  let context = null;
  const calls = new Map();
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (kind === 'codex') {
      const p = e.payload || {};
      if (e.type === 'event_msg' && p.type === 'token_count' && p.info) {
        const used = p.info.last_token_usage?.total_tokens;
        const total = p.info.model_context_window;
        context = { used, total, percent: Number.isFinite(used) && total > 0 ? used / total * 100 : null };
      }
      if (e.type === 'response_item') {
        if (['function_call', 'custom_tool_call'].includes(p.type)) calls.set(p.call_id || p.id, { name: clean(p.name), done: false });
        if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && calls.has(p.call_id)) calls.get(p.call_id).done = true;
      }
    } else {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === 'tool_use') calls.set(b.id, { name: clean(b.name), done: false });
        if (b.type === 'tool_result' && calls.has(b.tool_use_id)) calls.get(b.tool_use_id).done = true;
      }
    }
  }
  const list = [...calls.values()];
  return { context, tools: { count: list.length, running: list.filter(c => !c.done).map(c => c.name).slice(-3) } };
}
export async function tailLines(file, limit = 8 * 1024 * 1024) {
  if (!file) return [];
  let fd;
  try {
    fd = await open(file, 'r');
    const size = (await fd.stat()).size;
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines;
  } catch { return []; }
  finally { await fd?.close(); }
}
export async function findRollout(root, session, depth = 0) {
  if (!/^[a-f0-9-]{36}$/i.test(session || '') || depth > 4) return null;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('-' + session + '.jsonl')) return path.join(root, e.name);
  }
  for (const e of entries.reverse()) {
    if (!e.isDirectory()) continue;
    const match = await findRollout(path.join(root, e.name), session, depth + 1);
    if (match) return match;
  }
  return null;
}
function remaining(window, now) {
  if (!window || !Number.isFinite(window.used_percentage)) return '--';
  const reset = window.resets_at ? new Date(window.resets_at).getTime() : NaN;
  if (Number.isFinite(reset) && reset <= now) return 'awaiting refresh';
  const mins = Number.isFinite(reset) ? Math.ceil((reset - now) / 60000) : null;
  const time = mins == null ? '' : mins >= 1440 ? Math.floor(mins / 1440) + 'd ' + Math.floor(mins % 1440 / 60) + 'h' : Math.floor(mins / 60) + 'h ' + mins % 60 + 'm';
  return Math.round(100 - window.used_percentage) + '% left' + (time ? ' (' + time + ')' : '');
}
export function render(state, now = Date.now()) {
  const c = state.context;
  const number = n => Number.isFinite(n) ? (n / 1000).toFixed(1) + 'k' : '?';
  const ctx = Number.isFinite(c?.percent) ? Math.round(c.percent) + '% ' + number(c.used) + '/' + number(c.total) : '--';
  const q = state.quota || {};
  const label = clean(q.account?.label || 'waiting for first response');
  const age = q.updated_at ? Math.max(0, Math.floor((now - Date.parse(q.updated_at)) / 60000)) : null;
  const stale = q.status === 'stale' || (age != null && age >= 5);
  const status = state.offline ? ' | router offline' : q.status && !['ok', 'waiting'].includes(q.status) ? ' | ' + clean(q.status) : '';
  const tools = state.tools || { count: 0, running: [] };
  return [
    'Context ' + ctx + ' | Account ' + label + status,
    '5h ' + remaining(q.five_hour, now) + ' | 7d ' + remaining(q.seven_day, now) + (age != null ? ' | updated ' + age + 'm ago' : '') + (stale ? ' [stale]' : ''),
    'Tools (recent) ' + tools.count + (tools.running.length ? ' | running: ' + tools.running.map(n => clean(n)).join(', ') : ''),
  ].join('\n');
}
