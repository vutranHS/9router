import { validSession } from './store.mjs';

function windowData(q) {
  if (!q || !Number.isFinite(q.used) || !Number.isFinite(q.total) || q.total <= 0) return null;
  const reset = q.resetAt ? new Date(q.resetAt).getTime() : NaN;
  return { used_percentage: Math.max(0, Math.min(100, q.used / q.total * 100)),
    resets_at: Number.isFinite(reset) ? new Date(reset).toISOString() : null };
}
export function normalizeQuota(usage, family = 'normal') {
  const q = usage?.quotas || {};
  const prefix = family === 'normal' ? '' : family + '_';
  const primary = q[prefix + 'session'];
  const secondary = q[prefix + 'weekly'];
  const weeklyPrimary = primary?.windowSeconds === 604800;
  // Codex reports a primary (short) window and an optional secondary (weekly) one.
  // Map by role: a non-weekly primary is the 5h window, the secondary is the 7d
  // window. Accept an explicit 18000/604800 duration OR an absent one — some codex
  // usage responses omit limit_window_seconds, which previously dropped both windows
  // and showed "--". A *defined* non-standard duration is still rejected (not mislabeled).
  const isFive = w => w && (w.windowSeconds === 18000 || w.windowSeconds == null);
  const isSeven = w => w && (w.windowSeconds === 604800 || w.windowSeconds == null);
  const five = q['session (5h)'] || (!weeklyPrimary && isFive(primary) ? primary : null);
  const seven = q['weekly (7d)'] || (weeklyPrimary ? primary : isSeven(secondary) ? secondary : null);
  return { five_hour: windowData(five), seven_day: windowData(seven) };
}
export function createQuotaHandler({ validateKey, store, getConnection, getUsage, quotaFamily = () => 'normal', now = Date.now }) {
  const cache = new Map();
  const ttl = 300000;
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  return async request => {
    try {
      const auth = request.headers.get('authorization');
      const key = auth?.startsWith('Bearer ') ? auth.slice(7) : request.headers.get('x-api-key');
      if (!key || !await validateKey(key)) return reply({ error: 'Unauthorized' }, 401);
      const session = new URL(request.url).searchParams.get('session');
      if (!validSession(session)) return reply({ error: 'Invalid session' }, 400);
      const binding = await store.read(key, session);
      if (!binding) return reply({ status: 'waiting', account: null, five_hour: null, seven_day: null });
      const conn = await getConnection(binding.connectionId);
      if (!conn || conn.isActive === false) return reply({ status: 'unavailable', account: null });
      const account = { label: conn.email || conn.displayName || conn.name || 'Account' };
      const base = { account, last_used_at: new Date(binding.lastUsedAt).toISOString() };
      if (!['claude', 'codex'].includes(conn.provider) || conn.authType !== 'oauth') {
        return reply({ ...base, status: 'unsupported', five_hour: null, seven_day: null });
      }
      let entry = cache.get(conn.id);
      if (!entry) {
        if (cache.size >= 500) cache.delete(cache.keys().next().value);
        entry = {};
        cache.set(conn.id, entry);
      }
      if (!entry.pending && (!entry.at || now() - entry.at >= ttl) && (!entry.retryAt || now() >= entry.retryAt)) {
        entry.pending = (async () => {
          try {
            const usage = await getUsage(conn);
            if (!usage?.quotas || !Object.keys(usage.quotas).length) throw new Error('No quota');
            entry.usage = usage;
            entry.at = now();
            entry.failed = false;
          } catch {
            entry.failed = true;
            entry.retryAt = now() + 60000;
          } finally { entry.pending = null; }
        })();
      }
      if (entry.pending) {
        let timer;
        await Promise.race([entry.pending, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]);
        clearTimeout(timer);
      }
      const windows = normalizeQuota(entry.usage, quotaFamily(conn.provider, binding.model));
      return reply({ ...base, ...windows,
        status: !entry.usage ? 'unavailable' : entry.failed || now() - entry.at >= ttl ? 'stale' : 'ok',
        updated_at: entry.at ? new Date(entry.at).toISOString() : null });
    } catch { return reply({ error: 'Quota temporarily unavailable' }, 503); }
  };
}
