import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Where each CLI keeps its config. Claude honors CLAUDE_CONFIG_DIR (first entry
// if comma-separated); Codex honors CODEX_HOME. Fall back to the standard homes.
export function claudeDir() {
  const configured = (process.env.CLAUDE_CONFIG_DIR || '').split(path.delimiter)[0].trim();
  return configured || path.join(os.homedir(), '.claude');
}
export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Claude Code: ~/.claude/settings.json → env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN.
export function detectClaude(dir = claudeDir()) {
  try {
    const settings = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const env = settings && typeof settings.env === 'object' ? settings.env : {};
    return { url: env.ANTHROPIC_BASE_URL, key: env.ANTHROPIC_AUTH_TOKEN };
  } catch { return {}; }
}

// Codex: ~/.codex/config.toml → base_url of the active model_provider, plus the
// value of the OS env var named by that provider's env_key.
export function detectCodex(dir = codexHome(), env = process.env) {
  try {
    const toml = readFileSync(path.join(dir, 'config.toml'), 'utf8');
    const provider = tomlTopLevel(toml, 'model_provider');
    if (!provider) return {};
    const section = 'model_providers.' + provider;
    const url = tomlSectionValue(toml, section, 'base_url');
    const envKey = tomlSectionValue(toml, section, 'env_key');
    return { url, key: envKey ? env[envKey] : undefined };
  } catch { return {}; }
}

// Minimal, targeted TOML reading — enough for the 9router-generated config.toml,
// not a general parser. Values are single- or double-quoted strings.
const unquote = raw => {
  const v = raw.trim();
  const m = /^(["'])(.*)\1/.exec(v);
  return m ? m[2] : undefined;
};

// A top-level key = value pair that appears before the first [table] header.
function tomlTopLevel(toml, key) {
  const re = new RegExp('^\\s*' + key + '\\s*=\\s*(.+?)\\s*(?:#.*)?$');
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;            // reached the first table
    const m = re.exec(line);
    if (m) return unquote(m[1]);
  }
  return undefined;
}

// A key = value pair inside [section]. Section headers may quote path segments;
// compare on the raw, unquoted header text (e.g. model_providers.9router).
function tomlSectionValue(toml, section, key) {
  const re = new RegExp('^\\s*' + key + '\\s*=\\s*(.+?)\\s*(?:#.*)?$');
  let inSection = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { inSection = header[1].trim().replace(/["']/g, '') === section; continue; }
    if (!inSection) continue;
    const m = re.exec(line);
    if (m) return unquote(m[1]);
  }
  return undefined;
}
