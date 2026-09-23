import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const validSession = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(s);
const digest = s => createHash('sha256').update(s).digest('hex');
export function createSessionStore(directory, ttl = 86400000) {
  let sweptAt = 0;
  const filename = (key, session) => path.join(directory, digest(key + '\0' + session) + '.json');
  return {
    async record(key, session, connectionId, model, now = Date.now()) {
      if (!key || !validSession(session) || !connectionId) return;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = filename(key, session);
      const temp = target + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, JSON.stringify({ connectionId, model, lastUsedAt: now }), { mode: 0o600 });
        await rename(temp, target);
      } finally { await unlink(temp).catch(() => {}); }
      if (now - sweptAt > 3600000) {
        sweptAt = now;
        for (const name of await readdir(directory)) {
          const file = path.join(directory, name);
          const info = await stat(file).catch(() => null);
          if (info && now - info.mtimeMs > ttl) await unlink(file).catch(() => {});
        }
      }
    },
    async read(key, session, now = Date.now()) {
      if (!key || !validSession(session)) return null;
      try {
        const data = JSON.parse(await readFile(filename(key, session), 'utf8'));
        return now - data.lastUsedAt < ttl ? data : null;
      } catch { return null; }
    },
  };
}
