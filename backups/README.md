# Local Restore Backups

This folder tracks the non-secret parts of the local OpenCode / Telegram / ClashX Meta restore setup.

Excluded on purpose:

- `~/Library/Application Support/opencode-telegram-bot/.env`
- `~/.config/clash.meta/config.yaml`
- `~/.config/clash.meta/Nexitally_Clash.yaml`
- `~/tools/lockNontification/tencent-bark-relay/config.env`

Those files contain secrets or provider-specific data and should stay local.

The watchdog script reads the Bark relay config locally if it exists, so the relay stays outside the repo.
It also evaluates bot health from the latest startup marker, which avoids false alarms from older startup failures after a clean restart.
Telegram API probing is soft now; the watchdog only treats proxy and OpenCode readiness as hard prerequisites for recovery.
