# 9router HUD (Claude Code mod)

Context · account · 5h/7d quota · tools, drawn above the Claude Code prompt. Replaces the `9router-hud` npm wrapper for Claude (Codex still needs it).

```
/plugin install 9router-hud --marketplace vutranHS/9router
```

Subscription login (no custom endpoint): shows the logged-in email and Claude's own 5h/7d rate limits, no router needed.

With 9router: reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` from Claude's env (`~/.claude/settings.json`). No proxy: the router binds Claude Code's own `X-Claude-Code-Session-Id` header, so the router must include that change. Remove the old wrapper first (`9router-hud uninstall`) or `claude` keeps launching through it.

Test: `claude plugin test packages/9router-hud-mod`
