#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const PORT = Number.parseInt(process.env.DASHBOARD_PORT || String(DEFAULT_PORT), 10);
const USER_ID = typeof process.getuid === 'function' ? process.getuid() : 501;
const APP_SUPPORT_DIR = '/Users/uiye2048/Library/Application Support/opencode-telegram-bot';
const LOG_DIR = path.join(APP_SUPPORT_DIR, 'logs');
const STATIC_DIR = path.join(__dirname, 'public');
const MAX_LOG_LINES = 1000;
const DEFAULT_LOG_LINES = 200;
const ACTION_COOLDOWN_MS = 15_000;
const ACTION_TIMEOUT_MS = 60_000;

const LABELS = {
  opencode: 'com.uiye2048.opencode-serve',
  bot: 'com.uiye2048.opencode-telegram-bot',
  watchdog: 'com.uiye2048.opencode-telegram-watchdog',
  clash: 'com.metacubex.ClashX.meta',
};

const PORTS = [4096, 7890, 7891, 9090];

const LOG_SOURCES = {
  bot: ['/tmp/opencode-telegram-bot.log'],
  dailyBot: [],
  watchdog: ['/tmp/opencode-telegram-watchdog.log'],
  startup: ['/tmp/opencode-telegram-startup.log'],
  opencode: ['/tmp/opencode-serve.log'],
  clash: ['/tmp/clashx-meta.log'],
};

const ACTIONS = {
  '/api/actions/bot/restart': {
    key: 'botRestart',
    command: '/bin/launchctl',
    args: ['kickstart', '-k', `gui/${USER_ID}/${LABELS.bot}`],
  },
  '/api/actions/opencode/restart': {
    key: 'opencodeRestart',
    command: '/bin/launchctl',
    args: ['kickstart', '-k', `gui/${USER_ID}/${LABELS.opencode}`],
  },
  '/api/actions/watchdog/run': {
    key: 'watchdogRun',
    command: '/Users/uiye2048/scripts/opencode-telegram-watchdog.sh',
    args: [],
  },
};

const actionState = new Map();

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(bot\d{6,}:[A-Za-z0-9_-]{20,})/g, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(/((?:sk|rk|pk|sess|org|proj)-[A-Za-z0-9_-]{16,})/gi, '[REDACTED_TOKEN]')
    .replace(/([A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_-]*\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9_-]*token[A-Za-z0-9_-]*\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9_-]*secret[A-Za-z0-9_-]*\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/g, '$1[REDACTED]:[REDACTED]@');
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeout || 10_000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: redact(result.stdout || ''),
      stderr: redact(result.stderr || ''),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: typeof error.code === 'number' ? error.code : null,
      signal: error.signal || null,
      stdout: redact(error.stdout || ''),
      stderr: redact(error.stderr || error.message || ''),
    };
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSummary(filePath, summarizer) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { exists: true, ...summarizer(JSON.parse(raw)) };
  } catch (error) {
    return { exists: false, error: error.code || error.name };
  }
}

function preview(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function summarizeRollingState(data) {
  const sessions = data && typeof data === 'object' ? Object.entries(data) : [];
  return {
    sessionCount: sessions.length,
    sessions: sessions.slice(0, 20).map(([id, state]) => ({
      sessionId: id,
      roundCount: numberOrNull(state?.roundCount),
      version: numberOrNull(state?.version),
      lastCompactedRound: numberOrNull(state?.lastCompactedRound),
      isSummarizing: Boolean(state?.isSummarizing),
      summaryDisabled: Boolean(state?.summaryDisabled),
      summaryFailures: numberOrZero(state?.summaryFailures),
      skippedCycles: numberOrZero(state?.skippedCycles),
      updatedAt: stringOrNull(state?.updatedAt),
      compactedAt: stringOrNull(state?.compactedAt),
      summaryChars: typeof state?.summary === 'string' ? state.summary.length : 0,
      summaryPreview: preview(state?.summary, 240),
      lockStale: typeof state?.lockStale === 'boolean' ? state.lockStale : false,
    })),
  };
}

function summarizeLongTermMemory(data) {
  const memories = data?.memories;
  const serialized = typeof memories === 'string'
    ? memories
    : Array.isArray(memories)
      ? JSON.stringify(memories)
      : '';
  return {
    memoriesType: Array.isArray(memories) ? 'array' : typeof memories,
    memoriesCount: Array.isArray(memories) ? memories.length : null,
    memoriesChars: serialized.length,
    updatedAt: stringOrNull(data?.updatedAt),
    preview: serialized.length > 180 ? preview(serialized, 180) : null,
  };
}

function formatMemoryContent(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

async function getMemoryDetail(url) {
  const type = url.searchParams.get('type') || '';
  if (type === 'session') {
    const sessionId = url.searchParams.get('sessionId') || '';
    if (!sessionId) return { status: 400, body: { error: 'sessionId is required' } };

    try {
      const raw = await fs.readFile(path.join(APP_SUPPORT_DIR, 'rolling-summary-state.json'), 'utf8');
      const state = JSON.parse(raw);
      const entry = state && typeof state === 'object' ? state[sessionId] : null;
      if (!entry) return { status: 404, body: { error: 'session memory not found' } };

      const content = formatMemoryContent(entry.summary);
      return {
        status: 200,
        body: {
          type,
          title: sessionId,
          sessionId,
          updatedAt: stringOrNull(entry.updatedAt),
          compactedAt: stringOrNull(entry.compactedAt),
          chars: content.length,
          content,
        },
      };
    } catch (error) {
      return { status: 500, body: { error: error.code || error.name } };
    }
  }

  if (type === 'longTerm') {
    try {
      const raw = await fs.readFile(path.join(APP_SUPPORT_DIR, 'long-term-memory.json'), 'utf8');
      const data = JSON.parse(raw);
      const content = formatMemoryContent(data?.memories);
      return {
        status: 200,
        body: {
          type,
          title: 'Long-term memory',
          updatedAt: stringOrNull(data?.updatedAt),
          chars: content.length,
          content,
        },
      };
    } catch (error) {
      return { status: error.code === 'ENOENT' ? 404 : 500, body: { error: error.code || error.name } };
    }
  }

  return { status: 400, body: { error: 'unknown memory type' } };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

async function parseEnvFlags() {
  const targetKeys = new Set([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_PROXY_URL',
    'DEEPSEEK_API_KEY',
    'ROLLING_SUMMARY_ENABLED',
    'ROLLING_SUMMARY_ROUNDS',
  ]);
  const result = {
    TELEGRAM_BOT_TOKEN_configured: false,
    TELEGRAM_PROXY_URL_configured: false,
    DEEPSEEK_API_KEY_configured: false,
    ROLLING_SUMMARY_ENABLED: null,
    ROLLING_SUMMARY_ROUNDS: null,
  };

  try {
    const raw = await fs.readFile(path.join(APP_SUPPORT_DIR, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || !targetKeys.has(match[1])) continue;
      const key = match[1];
      const value = match[2].replace(/^['"]|['"]$/g, '').trim();
      if (key.endsWith('_TOKEN') || key.endsWith('_URL') || key.endsWith('_KEY')) {
        result[`${key}_configured`] = value.length > 0;
      } else if (key === 'ROLLING_SUMMARY_ENABLED') {
        result[key] = /^(1|true|yes|on)$/i.test(value);
      } else if (key === 'ROLLING_SUMMARY_ROUNDS') {
        const parsed = Number.parseInt(value, 10);
        result[key] = Number.isFinite(parsed) ? parsed : null;
      }
    }
    return { exists: true, ...result };
  } catch (error) {
    return { exists: false, error: error.code || error.name, ...result };
  }
}

function parseLaunchctlPrint(label, stdout, stderr) {
  const text = stdout || stderr || '';
  const pidMatch = text.match(/\bpid\s*=\s*(\d+)/i) || text.match(/\bPID\s*:\s*(\d+)/);
  const stateMatch = text.match(/\bstate\s*=\s*([^\n]+)/i);
  const lastExitMatch = text.match(/\blast exit code\s*=\s*([^\n]+)/i);
  const runsMatch = text.match(/\bruns\s*=\s*(\d+)/i);
  return {
    label,
    loaded: Boolean(stdout),
    running: Boolean(pidMatch),
    pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
    state: stateMatch ? stateMatch[1].trim() : null,
    lastExitCode: lastExitMatch ? lastExitMatch[1].trim() : null,
    runs: runsMatch ? Number.parseInt(runsMatch[1], 10) : null,
    error: stdout ? null : redact(stderr || 'not loaded'),
  };
}

async function getLaunchctlStatuses() {
  const entries = await Promise.all(Object.entries(LABELS).map(async ([name, label]) => {
    const result = await runCommand('/bin/launchctl', ['print', `gui/${USER_ID}/${label}`]);
    return [name, parseLaunchctlPrint(label, result.stdout, result.stderr)];
  }));
  return Object.fromEntries(entries);
}

function parseLsof(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    return {
      command: parts[0] || null,
      pid: parts[1] ? Number.parseInt(parts[1], 10) : null,
      user: parts[2] || null,
      protocol: parts[7] || null,
      name: parts.slice(8).join(' ') || null,
    };
  });
}

async function getPortStatuses() {
  const entries = await Promise.all(PORTS.map(async (port) => {
    const result = await runCommand('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    const listeners = result.ok ? parseLsof(result.stdout) : [];
    return [String(port), {
      listening: listeners.length > 0,
      listeners,
      error: result.ok || result.exitCode === 1 ? null : result.stderr,
    }];
  }));
  return Object.fromEntries(entries);
}

async function listFilesSafe(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function latestMatchingFile(dirPath, matcher) {
  const entries = await listFilesSafe(dirPath);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !matcher(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore files that disappeared during scanning.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.path || null;
}

async function refreshDynamicLogSources() {
  const latestDaily = await latestMatchingFile(LOG_DIR, (name) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(name));
  LOG_SOURCES.dailyBot = latestDaily ? [latestDaily] : [];
  return latestDaily;
}

async function tailFile(filePath, lineCount) {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n');
}

async function getLogResponse(name, lines) {
  await refreshDynamicLogSources();
  const sources = LOG_SOURCES[name];
  if (!sources) return { status: 400, body: { error: 'unknown log name' } };
  for (const filePath of sources) {
    if (!(await pathExists(filePath))) continue;
    try {
      return {
        status: 200,
        body: {
          name,
          path: filePath,
          lines,
          content: redact(await tailFile(filePath, lines)),
        },
      };
    } catch (error) {
      return { status: 500, body: { error: error.code || error.name, path: filePath } };
    }
  }
  return { status: 404, body: { error: 'log not found', name } };
}

async function readRecentLines(filePath, lines = 500) {
  if (!filePath || !(await pathExists(filePath))) return [];
  try {
    return (await tailFile(filePath, lines)).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function latestLineMatching(lines, matcher) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (matcher(lines[i])) return redact(lines[i]);
  }
  return null;
}

async function getLogHints() {
  const latestDailyBotLogPath = await refreshDynamicLogSources();
  const botLines = await readRecentLines('/tmp/opencode-telegram-bot.log', 500);
  const dailyLines = await readRecentLines(latestDailyBotLogPath, 1000);
  const watchdogLines = await readRecentLines('/tmp/opencode-telegram-watchdog.log', 300);
  const warnCount = dailyLines.filter((line) => /\bWARN(?:ING)?\b/i.test(line)).length;
  const errorCount = dailyLines.filter((line) => /\bERROR\b/i.test(line)).length;

  return {
    latestBotStartedLine: latestLineMatching([...botLines, ...dailyLines], (line) => /bot started|started/i.test(line)),
    recentDailyBotWarnCount: warnCount,
    recentDailyBotErrorCount: errorCount,
    latestWatchdogStatusLine: latestLineMatching(watchdogLines, (line) => /watchdog|status|ok|error|warn/i.test(line)),
    latestDailyBotLogPath,
  };
}

function isListening(ports, port) {
  return Boolean(ports?.[String(port)]?.listening);
}

function statusMessage(status, message) {
  return { status, message };
}

function classifyWatchdog(watchdogLaunch, latestLine) {
  const line = latestLine || '';
  if (!watchdogLaunch.loaded) {
    return statusMessage('error', 'Watchdog LaunchAgent is not loaded.');
  }
  if (/restart failed|bot did not recover/i.test(line)) {
    return statusMessage('error', 'Watchdog reports the bot did not recover after restart.');
  }
  if (/dependency probe failed/i.test(line)) {
    return statusMessage('warn', 'Watchdog is loaded, but the last dependency probe failed.');
  }
  if (!line || /healthy|no recent failure|nothing to do|bot alive|alive|ok/i.test(line)) {
    return statusMessage('ok', 'Watchdog LaunchAgent is loaded; idle between interval runs is expected.');
  }
  return statusMessage('ok', 'Watchdog LaunchAgent is loaded.');
}

function buildStatusCards({ launchctl, ports, rollingSummary, longTermMemory, env, logHints }) {
  const botLaunch = launchctl.bot || {};
  const opencodeLaunch = launchctl.opencode || {};
  const watchdogLaunch = launchctl.watchdog || {};
  const clashLaunch = launchctl.clash || {};
  const botStatus = botLaunch.running
    ? statusMessage('ok', 'Telegram bot LaunchAgent is running.')
    : statusMessage('error', 'Telegram bot LaunchAgent is not running.');
  const opencodeListening = isListening(ports, 4096);
  const opencodeStatus = opencodeLaunch.running && opencodeListening
    ? statusMessage('ok', 'OpenCode serve is running and listening on 127.0.0.1:4096.')
    : statusMessage('error', 'OpenCode serve is not running or port 4096 is not listening.');
  const watchdogStatus = classifyWatchdog(watchdogLaunch, logHints.latestWatchdogStatusLine);
  const clashPorts = {
    7890: isListening(ports, 7890),
    7891: isListening(ports, 7891),
    9090: isListening(ports, 9090),
  };
  const clashListening = clashPorts[7890] || clashPorts[7891] || clashPorts[9090];
  const clashStatus = clashLaunch.running && clashListening
    ? statusMessage('ok', 'ClashX Meta is running; dashboard is status-only for Clash.')
    : statusMessage('warn', 'ClashX Meta is not fully running/listening; dashboard is status-only for Clash.');
  const proxyListening = clashPorts[7890] || clashPorts[7891];
  const telegramApiReady = Boolean(env.TELEGRAM_BOT_TOKEN_configured)
    && Boolean(env.TELEGRAM_PROXY_URL_configured)
    && proxyListening;
  const telegramApiStatus = telegramApiReady
    ? statusMessage('ok', 'Telegram API configuration is present and local proxy is listening; soft probe not run.')
    : statusMessage('warn', 'Telegram API token/proxy configuration or local proxy listener is missing; soft probe not run.');
  const rollingSummaryStatus = rollingSummary.exists
    ? statusMessage(env.ROLLING_SUMMARY_ENABLED ? 'ok' : 'warn', env.ROLLING_SUMMARY_ENABLED ? 'Rolling summary is enabled.' : 'Rolling summary state exists but is disabled.')
    : statusMessage('warn', 'Rolling summary state file was not found.');

  return {
    telegramBot: {
      ...botStatus,
      running: Boolean(botLaunch.running),
      pid: botLaunch.pid ?? null,
      state: botLaunch.state ?? null,
      lastExitCode: botLaunch.lastExitCode ?? null,
      latestBotStartedLine: logHints.latestBotStartedLine,
      recentDailyBotErrorCount: logHints.recentDailyBotErrorCount,
      recentDailyBotWarnCount: logHints.recentDailyBotWarnCount,
    },
    opencode: {
      ...opencodeStatus,
      running: Boolean(opencodeLaunch.running),
      listening: opencodeListening,
      pid: opencodeLaunch.pid ?? null,
      state: opencodeLaunch.state ?? null,
      lastExitCode: opencodeLaunch.lastExitCode ?? null,
      endpoint: 'http://127.0.0.1:4096',
      url: 'http://127.0.0.1:4096',
    },
    watchdog: {
      ...watchdogStatus,
      loaded: Boolean(watchdogLaunch.loaded),
      running: Boolean(watchdogLaunch.running),
      pid: watchdogLaunch.pid ?? null,
      state: watchdogLaunch.state ?? null,
      lastExitCode: watchdogLaunch.lastExitCode ?? null,
      latestWatchdogStatusLine: logHints.latestWatchdogStatusLine,
    },
    clash: {
      ...clashStatus,
      running: Boolean(clashLaunch.running),
      pid: clashLaunch.pid ?? null,
      state: clashLaunch.state ?? null,
      ports: clashPorts,
      listening: clashListening,
    },
    telegramApi: {
      ...telegramApiStatus,
      tokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN_configured),
      proxyUrlConfigured: Boolean(env.TELEGRAM_PROXY_URL_configured),
      proxyListening,
      apiProbe: 'not-run',
    },
    rollingSummary: {
      ...rollingSummaryStatus,
      exists: Boolean(rollingSummary.exists),
      sessionCount: rollingSummary.sessionCount || 0,
      enabled: env.ROLLING_SUMMARY_ENABLED,
      rounds: env.ROLLING_SUMMARY_ROUNDS,
      sessions: rollingSummary.sessions || [],
      longTermMemory,
    },
  };
}

async function getStatus() {
  const [
    launchctl,
    ports,
    rollingSummary,
    longTermMemory,
    env,
    logHints,
  ] = await Promise.all([
    getLaunchctlStatuses(),
    getPortStatuses(),
    readJsonSummary(path.join(APP_SUPPORT_DIR, 'rolling-summary-state.json'), summarizeRollingState),
    readJsonSummary(path.join(APP_SUPPORT_DIR, 'long-term-memory.json'), summarizeLongTermMemory),
    parseEnvFlags(),
    getLogHints(),
  ]);
  const cards = buildStatusCards({ launchctl, ports, rollingSummary, longTermMemory, env, logHints });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    host: HOST,
    port: PORT,
    telegramBot: cards.telegramBot,
    opencode: cards.opencode,
    watchdog: cards.watchdog,
    clash: cards.clash,
    telegramApi: cards.telegramApi,
    rollingSummary: cards.rollingSummary,
    launchctl,
    ports,
    botState: {
      rollingSummary,
      longTermMemory,
      env,
    },
    logHints,
  };
}

async function getDiagnostics() {
  const status = await getStatus();
  return {
    generatedAt: status.generatedAt,
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    cwd: process.cwd(),
    staticDirExists: await pathExists(STATIC_DIR),
    appSupportDirExists: await pathExists(APP_SUPPORT_DIR),
    status,
  };
}

async function runAction(route) {
  const action = ACTIONS[route];
  const now = Date.now();
  const state = actionState.get(action.key) || { running: false, lastStartedAt: 0 };
  const elapsed = now - state.lastStartedAt;
  if (state.running) {
    return { status: 409, body: { error: 'action already running' } };
  }
  if (elapsed < ACTION_COOLDOWN_MS) {
    return {
      status: 429,
      body: {
        error: 'action cooldown active',
        retryAfterMs: ACTION_COOLDOWN_MS - elapsed,
      },
    };
  }

  actionState.set(action.key, { running: true, lastStartedAt: now });
  const startedAt = new Date().toISOString();
  const result = await runCommand(action.command, action.args, { timeout: ACTION_TIMEOUT_MS });
  actionState.set(action.key, { running: false, lastStartedAt: now });
  return {
    status: 200,
    body: {
      action: action.key,
      startedAt,
      finishedAt: new Date().toISOString(),
      command: path.basename(action.command),
      args: action.args,
      exitCode: result.exitCode,
      signal: result.signal || null,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const targetPath = path.resolve(STATIC_DIR, `.${pathname}`);
  const staticRoot = path.resolve(STATIC_DIR);
  if (targetPath !== staticRoot && !targetPath.startsWith(`${staticRoot}${path.sep}`)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(targetPath);
    const finalPath = stat.isDirectory() ? path.join(targetPath, 'index.html') : targetPath;
    const stream = fss.createReadStream(finalPath);
    stream.on('error', () => sendText(res, 404, 'Not found'));
    res.writeHead(200, {
      'content-type': contentTypeFor(finalPath),
      'cache-control': 'no-store',
    });
    stream.pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, await getStatus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
    sendJson(res, 200, await getDiagnostics());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/memory') {
    const result = await getMemoryDetail(url);
    sendJson(res, result.status, result.body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const requestedLines = Number.parseInt(url.searchParams.get('lines') || String(DEFAULT_LOG_LINES), 10);
    const lines = Math.min(MAX_LOG_LINES, Math.max(1, Number.isFinite(requestedLines) ? requestedLines : DEFAULT_LOG_LINES));
    const name = url.searchParams.get('name') || '';
    const result = await getLogResponse(name, lines);
    sendJson(res, result.status, result.body);
    return;
  }

  if (req.method === 'POST' && ACTIONS[url.pathname]) {
    const result = await runAction(url.pathname);
    sendJson(res, result.status, result.body);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  await serveStatic(req, res, url);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid DASHBOARD_PORT: ${process.env.DASHBOARD_PORT}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: error.name, message: redact(error.message || 'internal error') });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`OpenCode Telegram dashboard listening on http://${HOST}:${PORT}`);
});
