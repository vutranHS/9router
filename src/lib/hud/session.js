import path from 'node:path';
import { DATA_DIR } from '../dataDir.js';
import { createSessionStore } from './store.mjs';
export const hudSessions = createSessionStore(path.join(DATA_DIR, 'hud-sessions'));
export async function recordHudSession(request, apiKey, connectionId, model) {
  if (!apiKey) return;
  // The HUD wrapper's proxy sends x-9router-session; Claude Code itself sends its own
  // session id, which the HUD mod reads. Bind both so either can query quota.
  const sessions = new Set(['x-9router-session', 'x-claude-code-session-id'].map(h => request?.headers?.get(h)).filter(Boolean));
  for (const session of sessions) {
    try { await hudSessions.record(apiKey, session, connectionId, model); }
    catch { console.warn('[HUD] Could not record session'); }
  }
}
