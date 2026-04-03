# TG Claude — Handoff (2026-03-31)

## What was done this session

### 1. Kwork monitor — copy-friendly links
- Changed project notification format: URL now wrapped in `<code>` tag instead of `<a href>` link
- Tapping the URL in Telegram copies it to clipboard instantly
- File: `~/develop/kwork-monitor/monitor.mjs`, line ~299

### 2. awesome-claude-code submission
- Cooldown from rejected first submission (wrong format) expired 2026-03-27
- Prepared submission via web form: https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml
- Category: Alternative Clients → General
- Title format: `[Recommendation]: TG Claude`
- Status: user was filling out the form — check if submission went through

## Current state

### tg-claude
- **Branch**: main, up to date with origin
- **Bot running**: via launchd (`com.tg-claude.worker`)
- **Architecture**: `--print --resume` per message (each msg = new CLI process)
- **Token consumption**: same as terminal (prompt caching works, cache_read tokens are cheap)
- **Key files**:
  - `worker/index.mjs` — bot core, polling, commands, streaming
  - `worker/executor.mjs` — spawns Claude CLI with --print --stream-json
  - `bot-system-prompt.md` — appended to every Claude call
  - `worker/mcp-telegram.mjs` — MCP server for Claude → Telegram

### kwork-monitor
- **Not a git repo** — standalone script at `~/develop/kwork-monitor/`
- **Runs via launchd** every 10 min (`com.kwork.monitor`)
- **Checks**: Kwork projects (category 11, IT), filters by keywords/budget
- **Notifications**: sends to Telegram via bot token, URLs in `<code>` for easy copy
- **DB**: SQLite (`seen.db`) for dedup

### Mac setup
- MacBook Air M4, 24GB, macOS
- "Prevent automatic sleep when display is off on power adapter" — ENABLED
- `sleep 0` on AC — mac doesn't auto-sleep with lid open
- Lid close = normal sleep
- Launchd agents: `com.tg-claude.worker`, `com.kwork.monitor`

## Known issues / TODO
- **SDK V2 migration**: V2 Session API would give warm process (2-3s vs 12s per turn) but currently unstable — missing systemPrompt, cwd, mcpServers, permissionMode options. Revisit when stable.
- **mdToTgHtml edge cases**: complex nested markdown may not convert perfectly — monitor for issues
- **Kwork monitor**: inbox check code exists but not called. Selectors were outdated. Could be re-enabled with correct selectors.
- **Context limit**: hardcoded to 1M — should ideally detect model and set accordingly (200k for Sonnet/Haiku, 1M for Opus)
- **awesome-claude-code**: verify submission was accepted, check for bot validation feedback

## Prompt for new session

```
Working on tg-claude (~/develop/tg-claude) — Telegram bot that wraps Claude Code CLI.
Read HANDOFF.md for full context of recent changes.
Also manages kwork-monitor (~/develop/kwork-monitor) — Kwork project scraper.
```
