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
