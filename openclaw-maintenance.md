# OpenClaw Maintenance Guide

## Install type
Global npm on macOS. Homebrew node. Binary at `/opt/homebrew/lib/node_modules/openclaw/`.

## Updating

```bash
openclaw update          # tries npm update; works fine for this install
openclaw doctor          # migrates config, checks health
openclaw gateway restart
openclaw health
```

If `openclaw update` fails to detect the install, fall back to:
```bash
npm i -g openclaw@latest
```

After any update, always run doctor + restart. Don't skip it.

## Key file locations

| What | Path |
|------|------|
| Main config | `~/.openclaw/openclaw.json` |
| Auth tokens (profiles) | `~/.openclaw/agents/main/agent/auth-profiles.json` |
| Auth tokens (used by memory/embeddings) | `~/.openclaw/agents/main/agent/auth.json` |
| Edna's workspace | `~/.openclaw/workspace/` |
| Edna's long-term memory | `~/.openclaw/workspace/MEMORY.md` |
| Edna's daily notes | `~/.openclaw/workspace/memory/YYYY-MM-DD.md` |
| Gateway logs | `~/.openclaw/logs/gateway.log` |
| Plugins dir | `/opt/homebrew/lib/node_modules/openclaw/extensions/` |

**Important:** `auth.json` and `auth-profiles.json` are separate files.
The memory/embeddings system reads from **`auth.json`**, not `auth-profiles.json`.
If you update a key, update it in **both**.

## Auth structure

`auth-profiles.json` — profile-based store, used by the LLM routing layer.
`auth.json` — flat provider map, used by tools/memory (embeddings, etc).

When a key goes bad, update both. Also clear `usageStats` error counts and set `lastGood` for the provider in `auth-profiles.json`.

## Checking health after update/restart

```bash
openclaw logs --limit 100 --plain | grep -iE "error|warn|fail|401|429"
```

Common things to check:
- **Embeddings 401** → check `auth.json` openai key (not just auth-profiles.json)
- **Brave Search 422** → Edna is sending wrong locale. Valid: `"en"`, `"en-gb"`. Not `"en-US"`. Fix in `~/.openclaw/workspace/MEMORY.md`
- **`database is not open`** at startup → transient race condition, self-resolving, ignore
- **Telegram getUpdates timeout (500s)** → normal long-polling behavior, auto-retries, ignore
- **Anthropic auth cooldown** → tokens expired. Run `claude auth login` + `claude setup-token`, update both auth files

## Gateway restart

Preferred:
```bash
openclaw gateway restart
```

If it gets stuck (old PID still holding port 18789):
```bash
kill <PID>
launchctl bootout gui/$UID/ai.openclaw.gateway
openclaw gateway install   # reinstalls LaunchAgent
# then launchd auto-starts it
```

## Doctor deep check

```bash
openclaw doctor --deep    # full check
openclaw doctor --fix     # auto-fix what it can
openclaw gateway install --force   # if PATH or service entrypoint is wrong
```

## Models config (openclaw.json)

Current setup:
- Primary: `anthropic/claude-sonnet-4-6`
- Fallbacks: `openai-codex/gpt-5.3-codex`, `openai-codex/gpt-5.2-codex`
- Embeddings: OpenAI `text-embedding-3-small` (via `auth.json`)

## Plugins

Installed: `openai-codex-auth` (enables ChatGPT Plus/Pro OAuth for Codex models).
Location: `/opt/homebrew/lib/node_modules/openclaw/extensions/openai-codex-auth/`
This was manually installed from GitHub PR #18009 — not in the published npm package yet.
**After `openclaw update`, check if this plugin survived** — npm install may wipe it.
If missing, reinstall from PR head commit.

## Docs location

Full official docs: `/opt/homebrew/lib/node_modules/openclaw/docs/`
- Updating: `docs/install/updating.md`
- Gateway config: `docs/gateway/configuration-reference.md`
- Doctor: `docs/gateway/doctor.md`
- Troubleshooting: `docs/gateway/troubleshooting.md`
