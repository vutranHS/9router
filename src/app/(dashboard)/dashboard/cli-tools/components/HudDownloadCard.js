"use client";

import { useState } from "react";

const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";

export default function HudDownloadCard() {
  const [endpoint, setEndpoint] = useState("");
  const [platform, setPlatform] = useState("mac");
  const isWindows = platform === "windows";
  const install = isWindows ? "npm.cmd install -g .\\9router-hud.tgz" : "npm install -g ./9router-hud.tgz";
  const cmd = isWindows ? "9router-hud.cmd" : "9router-hud";
  const trimmed = endpoint.trim();
  const quoted = trimmed && (isWindows ? "'" + trimmed.replace(/'/g, "''") + "'" : shellQuote(trimmed));
  // Endpoint + key are auto-detected from the CLI's own config; --url is an
  // optional override only when detection can't find them (e.g. a fresh CLI).
  const setup = install + "\n" + cmd + " setup" + (quoted ? " --url " + quoted : "");
  return (
    <section className="rounded-xl border border-border p-5 flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-text-main">9Router HUD</h2>
      <p className="text-sm text-text-muted">
        Context, tool calls, and 5-hour / 7-day quota with the active account. Claude Code uses its status line; Codex uses a Windows Terminal pane on Windows or tmux on macOS.
      </p>
      <a href="/downloads/9router-hud.tgz" download="9router-hud.tgz" className="text-primary font-medium underline w-fit">Download HUD</a>
      <label className="text-sm flex flex-col gap-1">
        Your computer
        <select value={platform} onChange={event => setPlatform(event.target.value)} className="rounded border border-border bg-transparent px-3 py-2">
          <option value="mac">macOS / Linux</option>
          <option value="windows">Windows (PowerShell)</option>
        </select>
      </label>
      <label className="text-sm flex flex-col gap-1">
        Router endpoint (optional — auto-detected from your CLI config)
        <input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} className="rounded border border-border bg-transparent px-3 py-2" placeholder="leave blank to auto-detect" />
      </label>
      <p className="text-sm text-text-muted">Run once from the download folder. Setup auto-detects the router endpoint and API key from your existing Claude (settings.json) and Codex (config.toml) config, then installs wrappers — no key prompt. Fill the endpoint above only if detection can&apos;t find it.</p>
      <pre className="text-sm overflow-x-auto rounded bg-black/10 p-3 whitespace-pre-wrap">{setup}</pre>
      <p className="text-sm text-text-muted">
        Restart your terminal app, then type <code>claude</code> or <code>codex</code> as usual. Requires Node.js 20+. Windows supports PowerShell/CMD and requires Windows Terminal for Codex; macOS supports zsh/bash and requires tmux for Codex. Install the original CLIs first.
      </p>
      <p className="text-sm text-text-muted">
        Quota appears after the first successful request and follows the account used by this session. Unsupported quota sources show unavailable. Remove wrappers with <code>9router-hud uninstall</code>.
      </p>
    </section>
  );
}
