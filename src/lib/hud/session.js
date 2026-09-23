import path from 'node:path';
import { DATA_DIR } from '../dataDir.js';
import { createSessionStore } from './store.mjs';
export const hudSessions = createSessionStore(path.join(DATA_DIR, 'hud-sessions'));
export async function recordHudSession(request, apiKey, connectionId, model) {
  const session = request?.headers?.get('x-9router-session');
  if (!session || !apiKey) return;
  try { await hudSessions.record(apiKey, session, connectionId, model); }
  catch { console.warn('[HUD] Could not record session'); }
}
