#!/bin/bash

set -euo pipefail

LOG="/tmp/opencode-telegram-startup.log"
UID_TOKEN="$(id -u)"
OPENCODE_PLIST="/Users/uiye2048/Library/LaunchAgents/com.uiye2048.opencode-serve.plist"
CLASH_PLIST="/Users/uiye2048/Library/LaunchAgents/com.metacubex.ClashX.meta.plist"
OPENCODE_LABEL="com.uiye2048.opencode-serve"
CLASH_LABEL="com.metacubex.ClashX.meta"
OPENCODE_BIN="/opt/homebrew/bin/opencode"
TELEGRAM_BIN="/Users/uiye2048/.npm-global/bin/opencode-telegram"

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"
}

wait_for_port() {
    local host="$1"
    local port="$2"
    local timeout_seconds="${3:-90}"
    local i=0

    while [ "$i" -lt "$timeout_seconds" ]; do
        if nc -z "$host" "$port" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        i=$((i + 1))
    done

    return 1
}

ensure_launchagent_running() {
    local label="$1"
    local plist="$2"

    if launchctl print "gui/$UID_TOKEN/$label" >/dev/null 2>&1; then
        return 0
    fi

    launchctl bootstrap "gui/$UID_TOKEN" "$plist" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/$UID_TOKEN/$label" >/dev/null 2>&1 || true
    launchctl print "gui/$UID_TOKEN/$label" >/dev/null 2>&1
}

log "startup sequence begin"

log "checking clash meta launchagent"
ensure_launchagent_running "$CLASH_LABEL" "$CLASH_PLIST" || true
if wait_for_port 127.0.0.1 7890 30 || wait_for_port 127.0.0.1 7891 30; then
    log "clash meta proxy is ready"
else
    log "clash meta proxy not ready after wait; trying to nudge app"
    open -g -a "ClashX Meta" >/dev/null 2>&1 || true
    if wait_for_port 127.0.0.1 7890 60 || wait_for_port 127.0.0.1 7891 60; then
        log "clash meta proxy became ready"
    else
        log "clash meta proxy still not ready; continuing without proxy confirmation"
    fi
fi

log "checking opencode serve launchagent"
ensure_launchagent_running "$OPENCODE_LABEL" "$OPENCODE_PLIST" || true
if wait_for_port 127.0.0.1 4096 90; then
    log "opencode server is ready on 4096"
else
    log "opencode server not ready on 4096; retrying launchctl kickstart"
    launchctl kickstart -k "gui/$UID_TOKEN/$OPENCODE_LABEL" >/dev/null 2>&1 || true
    if wait_for_port 127.0.0.1 4096 60; then
        log "opencode server became ready on 4096"
    else
        log "opencode server still not ready; aborting"
        exit 1
    fi
fi

log "starting opencode telegram"
exec "$TELEGRAM_BIN" start
