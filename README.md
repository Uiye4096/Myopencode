# Myopencode

This repository is the backup point for my local OpenCode setup.

## What is included

- OpenCode prompts and skills
- Local OpenCode config files
- Restore scripts for OpenCode, Telegram bot, and related launch agents
- Telegram bot addon scripts and dist patcher under `bot-addons/`
- Non-secret bootstrap files under `backups/`

## What is intentionally excluded

- `~/Library/Application Support/opencode-telegram-bot/.env`
- `~/.config/clash.meta/config.yaml`
- `~/.config/clash.meta/Nexitally_Clash.yaml`

Those files can contain tokens, subscription data, or provider-specific secrets, so they stay local.

## Restore layout

- `backups/launchagents/` contains the launchd jobs I use for startup ordering
- `backups/scripts/` contains the wrapper used to start ClashX Meta, OpenCode, then the Telegram bot
- `backups/README.md` explains the local-only pieces that are not committed

## Notes

- The active local setup uses ClashX Meta with the Nexitally profile
- OpenCode listens on `127.0.0.1:4096`
- The Telegram bot uses the local HTTP proxy on `127.0.0.1:7890`
- Current recovery work should continue on a separate branch in a fresh Desktop clone
- `opencode-telegram` now has a lightweight `/health` command and a periodic watchdog wrapper for local recovery and Bark alerts
- The watchdog judges health from the latest bot start marker, so it will not treat stale startup failures as a fresh outage after a successful restart
- Telegram API reachability is now treated as a soft signal; local proxy and OpenCode readiness are the hard gates for automatic recovery

## Telegram bot addons

The `bot-addons/` directory contains local patches for the installed `@grinev/opencode-telegram-bot` package.
The patcher targets the installed dist files under:

`~/.npm-global/lib/node_modules/@grinev/opencode-telegram-bot/dist`

Current addon behavior:

- Rolling summary state is stored in `~/Library/Application Support/opencode-telegram-bot/rolling-summary-state.json`
- Long-term memory is stored in `~/Library/Application Support/opencode-telegram-bot/long-term-memory.json`
- Telegram prompts inject long-term memory plus the active session rolling summary into `promptOptions.system` once per session segment
- Long-term memory extraction avoids re-prepending old memory when the model already returned old plus new memory
- The Reply Keyboard context button is labeled as `Compact`, for example `Compact 42K / 1.0M (4%)`
- After OpenCode compaction, context display ignores token peaks before the latest user compaction marker and shows post-compact usage instead

Important distinction:

- Long-term memory and rolling summary preserve useful information for future prompts
- OpenCode `Compact` reduces the active session history; it does not clear the session or replace it with only long-term memory
- After a compact, the next Telegram prompt starts a new segment and refreshes addon system context once
- For roleplay or other style-sensitive sessions, compact at scene boundaries rather than in the middle of high-context dialogue

Operational notes:

- Apply patches with `node "bot-addons/patches/apply.js"` from this repo, or with the synced addon copy in the Telegram bot app support directory
- Restart the bot after patching: `launchctl kickstart -k gui/$(id -u)/com.uiye2048.opencode-telegram-bot`
- Verify startup with `/tmp/opencode-telegram-bot.log`; a healthy post-compact reload should log the reduced `Loaded context from history` value

## Troubleshooting

### Symptom

- OpenCode Telegram would start, but then fail during startup with `getWebhookInfo`
- ClashX Meta was running as a LaunchAgent, but local proxy ports were not reliably available
- In the bad startup window on `2026-05-05 17:46` and `17:49`, the bot exited before `bot.start()` completed

### Root cause

- The active ClashX Meta launch path was not consistently using the Nexitally profile
- The default `~/.config/clash.meta/config.yaml` had been overwritten by another tool and was not the intended local profile
- `opencode-telegram` depended on the local proxy being available at `127.0.0.1:7890`
- The startup path calls `bot.api.getWebhookInfo()` before entering the polling loop, and that request failed with `Network request for 'getWebhookInfo' failed!`
- The failure was transport-level, not a Telegram business error: `setMyCommands` also failed first, and Clash logs showed Telegram-bound traffic hitting DNS resolution failures in the proxy chain
- This points to a temporary Telegram/proxy connectivity problem during startup, not an account change or a broken `/status` handler

### Fix

- Restored `~/.config/clash.meta/config.yaml` to the Nexitally profile locally
- Updated the ClashX Meta LaunchAgent to start the bundled Mihomo helper against that config
- Kept `opencode serve` on `127.0.0.1:4096`
- Set `TELEGRAM_PROXY_URL=http://127.0.0.1:7890`
- Kept the startup order as:
  - ClashX Meta
  - OpenCode
  - OpenCode Telegram bot

### Recovery notes

- Manual reopening of ClashX Meta is fine as long as it stays on the Nexitally profile and keeps `7890/7891/9090` available
- If Telegram fails again, first check that ClashX Meta is actually exposing `7890` before touching the bot
- Later restarts succeeded once ClashX Meta was healthy again:
  - `2026-05-05 17:59:59` bot started successfully
  - `2026-05-06 01:43:07` bot started successfully again after a later reboot
- For future incidents, check these in order:
  - ClashX Meta log for Telegram DNS / connect errors
  - `opencode-telegram` startup log for `setMyCommands` and `getWebhookInfo`
  - `launchctl print` to confirm the bot job is really alive, not just marked running
