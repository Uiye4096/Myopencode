#!/bin/bash

set -euo pipefail

UID_TOKEN="$(id -u)"
APP_ENV_FILE="/Users/uiye2048/Library/Application Support/opencode-telegram-bot/.env"
BARK_ENV_FILE="/Users/uiye2048/tools/lockNontification/tencent-bark-relay/config.env"
BOT_LABEL="com.uiye2048.opencode-telegram-bot"
BOT_PLIST="/Users/uiye2048/Library/LaunchAgents/com.uiye2048.opencode-telegram-bot.plist"
OPENCODE_PLIST="/Users/uiye2048/Library/LaunchAgents/com.uiye2048.opencode-serve.plist"
BOT_LOG_DIR="/Users/uiye2048/Library/Application Support/opencode-telegram-bot/logs"
LSOF_BIN="/usr/sbin/lsof"
LOG="/tmp/opencode-telegram-watchdog.log"
BOT_RESTART_DELAY_SECONDS=8
BOT_RECOVERY_TIMEOUT_SECONDS=60
BOT_RECOVERY_POLL_SECONDS=2

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"
}

load_env_file() {
    local env_file="$1"
    if [ -f "$env_file" ]; then
        set -a
        # shellcheck disable=SC1090
        . "$env_file"
        set +a
    fi
}

urlencode() {
    python3 -c 'from urllib.parse import quote; import sys; print(quote(sys.argv[1], safe=""))' "$1"
}

notify_bark() {
    local title="$1"
    local body="$2"

    if [ -z "${BARK_URL:-}" ]; then
        log "Bark notification skipped: BARK_URL is not configured"
        return 1
    fi

    local bark_base="${BARK_URL%/}"
    local request_url="${bark_base}/$(urlencode "$title")/$(urlencode "$body")?group=opencode-telegram"
    if ! curl -fsS --max-time 10 "$request_url" >/dev/null 2>&1; then
        log "Bark notification failed for: $title"
    fi
}

launchagent_pid() {
    launchctl print "gui/$UID_TOKEN/$BOT_LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = / { print $3; exit }'
}

launchagent_running() {
    launchctl print "gui/$UID_TOKEN/$BOT_LABEL" >/dev/null 2>&1
}

process_alive() {
    local pid="$1"
    [ -n "$pid" ] && launchctl print "gui/$UID_TOKEN/$BOT_LABEL" 2>/dev/null | grep -q "pid = $pid"
}

latest_bot_log() {
    ls -1t "$BOT_LOG_DIR"/bot-*.log 2>/dev/null | head -n 1
}

telegram_proxy_url() {
    if [ -n "${TELEGRAM_PROXY_URL:-}" ]; then
        printf '%s\n' "$TELEGRAM_PROXY_URL"
        return 0
    fi
    printf '%s\n' "http://127.0.0.1:7890"
}

probe_opencode() {
    "$LSOF_BIN" -nP -iTCP:4096 -sTCP:LISTEN >/dev/null 2>&1
}

probe_proxy() {
    "$LSOF_BIN" -nP -iTCP:7890 -sTCP:LISTEN >/dev/null 2>&1 || "$LSOF_BIN" -nP -iTCP:7891 -sTCP:LISTEN >/dev/null 2>&1
}

probe_telegram() {
    if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
        return 1
    fi

    local proxy_url
    proxy_url="$(telegram_proxy_url)"
    local response
    response="$(curl -fsS --max-time 10 --proxy "$proxy_url" "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe")"
    printf '%s' "$response" | grep -q '"ok":true'
}

probe_telegram_soft() {
    if probe_telegram >/dev/null 2>&1; then
        return 0
    fi

    log "telegram API probe failed; treating as soft signal"
    return 1
}

bot_has_recent_failure() {
    local log_file
    log_file="$(latest_bot_log)"
    if [ -z "$log_file" ]; then
        return 1
    fi

    local last_start_line
    last_start_line="$(grep -n "Bot @.* started!" "$log_file" 2>/dev/null | tail -n 1 | cut -d: -f1 || true)"
    if [ -n "$last_start_line" ]; then
        if tail -n +"$last_start_line" "$log_file" | grep -q "CRITICAL: Stopping event processing due to error"; then
            return 0
        fi
        return 1
    fi

    if tail -n 120 "$log_file" | grep -Eq "CRITICAL: Stopping event processing due to error"; then
        return 0
    fi

    return 1
}

restart_bot() {
    log "restarting LaunchAgent $BOT_LABEL"
    launchctl kickstart -k "gui/$UID_TOKEN/$BOT_LABEL" >/dev/null 2>&1 || true
}

wait_for_bot_recovery() {
    local elapsed=0
    while [ "$elapsed" -lt "$BOT_RECOVERY_TIMEOUT_SECONDS" ]; do
        local pid
        pid="$(launchagent_pid || true)"
        if [ -n "$pid" ] && process_alive "$pid"; then
            return 0
        fi
        sleep "$BOT_RECOVERY_POLL_SECONDS"
        elapsed=$((elapsed + BOT_RECOVERY_POLL_SECONDS))
    done
    return 1
}

ensure_watchdog_launchagent() {
    if launchctl print "gui/$UID_TOKEN/$BOT_LABEL" >/dev/null 2>&1; then
        return 0
    fi

    if [ -f "$BOT_PLIST" ]; then
        launchctl bootstrap "gui/$UID_TOKEN" "$BOT_PLIST" >/dev/null 2>&1 || true
    fi
    launchctl kickstart -k "gui/$UID_TOKEN/$BOT_LABEL" >/dev/null 2>&1 || true
}

main() {
    load_env_file "$APP_ENV_FILE"
    load_env_file "$BARK_ENV_FILE"

    log "watchdog run begin"

    local pid
    pid="$(launchagent_pid || true)"
    if [ -n "$pid" ] && process_alive "$pid"; then
        if bot_has_recent_failure; then
            log "bot process is alive but recent critical failure was found; restarting"
        else
            log "bot is alive and no recent failure was found; nothing to do"
            if ! probe_proxy; then
                log "proxy probe failed while bot is alive; treating as soft signal"
            fi
            probe_telegram_soft || true
            exit 0
        fi
    else
        log "bot process is not alive"
    fi

    if ! probe_opencode; then
        log "opencode probe failed"
        notify_bark \
            "OpenCode Telegram 需要人工处理" \
            "OpenCode 本地服务 4096 未就绪，脚本没有自动重启 bot。请先检查 com.uiye2048.opencode-serve 和 /tmp/opencode-serve.log。"
        exit 1
    fi

    if probe_proxy; then
        log "proxy probe ok"
    else
        log "proxy probe failed; continuing because proxy and Telegram checks are soft"
    fi
    probe_telegram_soft || true

    log "bot needs restart"
    ensure_watchdog_launchagent
    restart_bot
    sleep "$BOT_RESTART_DELAY_SECONDS"

    if wait_for_bot_recovery; then
        log "bot recovered after restart"
        exit 0
    fi

    log "bot did not recover after restart"
    notify_bark \
        "OpenCode Telegram 重启失败" \
        "OpenCode 本地服务就绪，但 bot 重启后仍未恢复。请查看 /Users/uiye2048/Library/Application Support/opencode-telegram-bot/logs/ 和 /tmp/opencode-telegram-watchdog.log。"
    exit 1
}

main "$@"
