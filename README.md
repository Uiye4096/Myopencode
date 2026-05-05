# Myopencode

This repository is the backup point for my local OpenCode setup.

## What is included

- OpenCode prompts and skills
- Local OpenCode config files
- Restore scripts for OpenCode, Telegram bot, and related launch agents
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

## Troubleshooting

### Symptom

- OpenCode Telegram would start, but then fail during startup with `getWebhookInfo`
- ClashX Meta was running as a LaunchAgent, but local proxy ports were not reliably available

### Root cause

- The active ClashX Meta launch path was not consistently using the Nexitally profile
- The default `~/.config/clash.meta/config.yaml` had been overwritten by another tool and was not the intended local profile
- `opencode-telegram` depended on the local proxy being available at `127.0.0.1:7890`

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
