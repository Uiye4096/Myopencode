# OpenCode Telegram Status Dashboard

Local-only backend for the OpenCode Telegram dashboard.

## Run

```sh
node status-dashboard/server.js
```

Open:

```text
http://127.0.0.1:8787
```

The server binds only to `127.0.0.1`. To change the port:

```sh
DASHBOARD_PORT=8788 node status-dashboard/server.js
```

## APIs

- `GET /api/status`
- `GET /api/logs?name=bot&lines=200`
- `GET /api/logs?name=dailyBot&lines=200`
- `GET /api/logs?name=watchdog&lines=200`
- `GET /api/logs?name=startup&lines=200`
- `GET /api/logs?name=opencode&lines=200`
- `GET /api/logs?name=clash&lines=200`
- `GET /api/diagnostics`
- `POST /api/actions/bot/restart`
- `POST /api/actions/opencode/restart`
- `POST /api/actions/watchdog/run`

`GET /api/status` includes frontend-facing top-level status cards:

- `telegramBot`
- `opencode`
- `watchdog`
- `clash`
- `telegramApi`
- `rollingSummary`

Each card includes a concise `status` and `message` for health rendering.

The `startup` log name reads `/tmp/opencode-telegram-startup.log`.

## Safety Boundaries

- Uses Node built-ins only; no npm dependencies.
- Serves static files from `status-dashboard/public` if present.
- Mutating endpoints run hardcoded local commands only.
- `launchctl kickstart` is executed with `child_process.execFile`, not a shell.
- ClashX Meta is status-only; there is no Clash action endpoint.
- Action endpoints use an in-memory running guard and cooldown to prevent stacked restarts.
- Command output and log responses redact obvious tokens, API keys, secrets, and URL credentials.
- `.env` parsing returns only configured booleans and rolling-summary settings, never secret values.
- Long-term memory and rolling-summary state responses include counts, timestamps, flags, and previews only, not full memory content.
