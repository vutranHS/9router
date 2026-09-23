# 9router HUD

Installable companion for Claude Code and Codex CLI. Shows context used, account email/name, remaining 5-hour/7-day quota and reset countdowns, and recent tool calls. **No selected or remapped model is displayed.**

Claude uses its native status line. Codex uses a HUD pane alongside its TUI: Windows Terminal on native Windows, tmux on macOS/Linux. The Codex binary is not patched. This package is a CLI integration, not a native Codex marketplace status-line extension.

## Install

Requires Node.js 20+, the server changes in this PR, and an existing Claude Code and/or Codex CLI installation. Primary targets are **native Windows and macOS**. Linux/WSL also remain supported.

| Platform | Shell setup | Claude HUD | Codex HUD requirement |
| --- | --- | --- | --- |
| Windows 10/11 | PowerShell or CMD | Native status line | Windows Terminal (`wt.exe`) |
| macOS | zsh or bash | Native status line | tmux (`brew install tmux`) |
| Linux / WSL | bash or zsh | Native status line | tmux |

Windows does not require WSL, Git Bash, or tmux for the HUD. Install the official Claude/Codex native binaries or npm packages. Arbitrary third-party `.cmd`/`.bat` launchers are not supported.

Open **9router → CLI Tools → Download HUD**, then run from the download folder:

```bash
npm install -g ./9router-hud.tgz
9router-hud setup --url https://your-router.example
```

Setup prompts for the key with hidden input, saves configuration and installs wrappers once. Open a new terminal; ordinary `claude` and `codex` commands now open the HUD. The endpoint is the router used by your CLI, which can differ from the dashboard address. Nothing is installed on the server by downloading the package.

From a repository checkout, use `npm install -g ./packages/9router-hud` instead. For automated setup, provide the key on stdin with `9router-hud setup --url URL --key-stdin`.

On macOS/Linux, automatic wrappers support bash and zsh. They live in the HUD configuration directory's `bin` folder, prepended to PATH using a marked shell configuration block. Bash updates `.bashrc` plus the active login profile; zsh respects `ZDOTDIR`. Original CLI files are never replaced. CLI upgrades at the same PATH location continue to work. Install any missing CLI, then rerun `9router-hud install` to wrap it too. Existing aliases/functions take precedence; remove those yourself if they shadow the wrappers.

Noninteractive calls, `claude -p`, `codex exec`, help/version and common authentication/maintenance commands bypass HUD and retain their original CLI configuration. Set `NINE_ROUTER_HUD_DISABLE=1` to bypass explicitly. Explicit `9router-hud claude` / `9router-hud codex` launchers remain available.

On Windows, use `npm.cmd install -g .\9router-hud.tgz` then `9router-hud.cmd setup --url https://your-router.example` if PowerShell blocks npm's `.ps1` shims. After setup, close and reopen your terminal app; `claude` and `codex` work normally. Codex opens a dedicated Windows Terminal window containing both the CLI and HUD pane. Claude stays in the current terminal. Windows Terminal's `wt.exe` app execution alias must be enabled.

Windows setup adds `.cmd` wrappers, prepends the wrapper directory to user PATH, adds marked blocks to the Windows PowerShell and PowerShell 7 all-hosts profiles, and appends its own CMD AutoRun hook. Existing profile contents and AutoRun commands are retained; uninstall removes only HUD's entries. No machine PATH, admin rights, or execution-policy change is required. Shell aliases/functions, disabled profiles, or enterprise startup restrictions can override automatic setup. Custom install paths containing `%` or `!` are rejected before shell edits.

Config is saved to `%LOCALAPPDATA%/9router-hud/config.json` on Windows (user-only inherited directory ACL) or `~/.config/9router-hud/config.json` on macOS/Linux (mode 0600). `NINE_ROUTER_URL` and `NINE_ROUTER_API_KEY` override it. `NINE_ROUTER_HUD_HOME` relocates configuration and session files. Use HTTPS for remote routers.

## Run

```bash
9router-hud claude
9router-hud codex
# CLI options can follow --:
9router-hud claude -- --resume
9router-hud codex -- resume
```

Both launchers authenticate inference with your configured 9router key. Claude's status line is overridden only for this launch; existing settings files and HUD installations are untouched. A supplied `--settings <JSON-or-file>` is merged, replacing its statusLine. Codex uses a per-launch custom Responses provider. Use existing 9router aliases, provider-prefixed IDs or per-key remaps as needed; this server patch defaults bare claude-* names to Claude Code (cc), and gpt-* names to Codex (cx). Explicit anthropic/... and openai/... prefixes still use API-key providers. Configured aliases and per-key remaps remain higher priority.

For Codex on macOS/Linux, detach with tmux `Ctrl+B`, then `D`; reattach with `tmux attach -t <9router-hud-session-name>`. Exit Codex to remove its HUD session. The terminal must have space for the three-line pane.

## Display semantics

- Context is the last request's context usage/window, not cumulative billed tokens.
- Account is the email, or displayName/name, of the latest successful account in this launched session. It changes after account/combo fallback.
- 5h/7d show upstream account quota **remaining**, shared with other users of that account. These are not per-key budgets.
- Quota is fetched on responses and while idle. Server cache is five minutes per worker. Refresh errors retain the original timestamp and show stale data. Unsupported windows show `--`, not a fabricated zero.
- Tools count the recent transcript tail (up to 8 MiB), including running call names; not a lifetime total.

Before the first successful response, account/quota show waiting. If all attempts fail, the last successful account remains. A multi-account fusion displays the latest successful member, not an aggregate. If Codex's exact rollout cannot be found, context/tools remain unavailable instead of selecting another terminal.

## Session isolation and API

Each launch creates a random session ID and loopback streaming proxy. The proxy injects `x-9router-session` and the configured router key. Quota requests go directly to the configured router.

`GET /v1/hud/quota?session=<launch-id>` **always requires an active API key**, even on localhost or when anonymous chat is enabled. Bindings are scoped to key + session and recorded after successful routing/remap/fallback. Callers cannot supply an arbitrary connection ID. Responses expose account label, 5h/7d windows, status, last_used_at and updated_at; never model IDs, OAuth tokens or raw upstream errors. Account email/name is intentionally visible to that session's key holder.

Bindings are indexed by a SHA-256 digest of key + session in `DATA_DIR/hud-sessions`, expire after 24 hours without successful requests, and are pruned during writes. Next workers must share DATA_DIR. No API key is stored in these snapshots. Quota cache is per worker.

Codex's thread ID from `session_id`/`x-client-request-id` selects the exact local rollout. Claude provides transcript path and context via status-line stdin. Neither integration reads local OAuth credentials. Local snapshots contain account labels and quota, with private file permissions.

## Development

No runtime npm dependencies.

```bash
node --test tests/hud/*.test.mjs packages/9router-hud/test/*.test.mjs
npm --prefix packages/9router-hud test
```

The server build/dev commands package the HUD at `/downloads/9router-hud.tgz`; the existing Docker, standalone and CLI packaging paths copy that public asset. Rebuild the server after changing HUD code. The download contains no endpoint, key or user data.

Tests cover wrapper idempotency, uninstall, original CLI resolution, argument preservation, automation bypass, key/session isolation, actual chat-handler fallback/remap binding, stale quota cache, weekly-only/model-family windows, streaming proxy headers, collectors, and launcher-to-router-to-HUD flows with fixture CLIs. CI is configured for Windows, macOS and Linux, including native Windows shim invocation and PowerShell syntax checks. Live Claude/Codex, Windows Terminal/tmux, and upstream-provider validation is still required before production rollout. Windows-specific checks require the Windows CI runner and are not validated by the Linux-only local run.

Run `9router-hud uninstall` before `npm uninstall -g 9router-hud`, then open a new terminal; remove the HUD configuration directory to also delete saved configuration.

Implementation references: [Claude Windows status lines](https://code.claude.com/docs/en/statusline#windows-configuration) and [Windows Terminal pane commands](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments).
