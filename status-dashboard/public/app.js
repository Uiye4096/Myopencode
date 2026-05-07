const STATUS_REFRESH_MS = 15000;
const LOG_REFRESH_MS = 10000;
const LOG_LINES = 200;

const STATUS_CARDS = [
  {
    key: "telegramBot",
    title: "Telegram Bot",
    paths: ["telegramBot", "bot"],
    details: ["pid", "state", "lastExitCode", "recentDailyBotErrorCount", "recentDailyBotWarnCount"],
  },
  {
    key: "opencode",
    title: "OpenCode Server",
    paths: ["opencode", "openCode", "server"],
    details: ["pid", "state", "endpoint", "listening"],
  },
  {
    key: "watchdog",
    title: "Watchdog",
    paths: ["watchdog"],
    details: ["loaded", "state", "lastExitCode", "latestWatchdogStatusLine"],
  },
  {
    key: "clash",
    title: "ClashX Meta",
    paths: ["clash", "clashx", "clashMeta"],
    details: ["state", "pid", "listening", "ports"],
    statusOnly: true,
  },
  {
    key: "telegramApi",
    title: "Telegram API / Proxy",
    paths: ["telegramApi", "telegramProxy", "proxy"],
    details: ["tokenConfigured", "proxyUrlConfigured", "proxyListening", "apiProbe"],
  },
  {
    key: "rollingMemory",
    title: "Rolling Memory",
    paths: ["rollingSummary", "rollingMemory"],
    details: ["sessionCount", "enabled", "rounds"],
  },
];

const ACTIONS = {
  botRestart: {
    label: "Restart Telegram bot",
    endpoint: "/api/actions/bot/restart",
    confirm: "Restart the Telegram bot process now?",
  },
  opencodeRestart: {
    label: "Restart OpenCode serve",
    endpoint: "/api/actions/opencode/restart",
    confirm: "Restart the local OpenCode serve process now?",
  },
  watchdogRun: {
    label: "Run watchdog",
    endpoint: "/api/actions/watchdog/run",
    confirm: "Run the watchdog once now?",
  },
};

const LOG_LABELS = {
  bot: "Bot",
  dailyBot: "Daily Bot",
  watchdog: "Watchdog",
  startup: "Startup",
  opencode: "OpenCode",
  clash: "Clash",
};

const state = {
  status: null,
  statusError: null,
  activeLog: "bot",
  logText: "",
  logError: null,
  isRefreshingStatus: false,
  isRefreshingLogs: false,
  statusTimer: null,
  logTimer: null,
};

const el = {
  overallHealth: document.querySelector("#overall-health"),
  overallHealthLabel: document.querySelector("#overall-health-label"),
  lastRefreshed: document.querySelector("#last-refreshed"),
  autoRefresh: document.querySelector("#auto-refresh"),
  manualRefresh: document.querySelector("#manual-refresh"),
  memoryCount: document.querySelector("#memory-count"),
  memoryState: document.querySelector("#memory-state"),
  memoryList: document.querySelector("#memory-list"),
  activityList: document.querySelector("#activity-list"),
  clearActivity: document.querySelector("#clear-activity"),
  logFilter: document.querySelector("#log-filter"),
  refreshLogs: document.querySelector("#refresh-logs"),
  logStatus: document.querySelector("#log-status"),
  logOutput: document.querySelector("#log-output"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmSubmit: document.querySelector("#confirm-submit"),
  memoryDialog: document.querySelector("#memory-dialog"),
  memoryDialogTitle: document.querySelector("#memory-dialog-title"),
  memoryDialogMeta: document.querySelector("#memory-dialog-meta"),
  memoryDialogContent: document.querySelector("#memory-dialog-content"),
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => confirmAction(button.dataset.action));
  });

  document.querySelectorAll("[data-log]").forEach((button) => {
    button.addEventListener("click", () => setActiveLog(button.dataset.log));
  });

  el.manualRefresh.addEventListener("click", () => refreshAll({ manual: true }));
  el.refreshLogs.addEventListener("click", () => refreshLogs({ manual: true }));
  el.logFilter.addEventListener("change", renderLogs);
  el.autoRefresh.addEventListener("change", syncAutoRefresh);
  el.clearActivity.addEventListener("click", () => {
    el.activityList.replaceChildren();
    appendActivity("Activity history cleared.", "info");
  });

  appendActivity("Dashboard loaded. Waiting for backend status.", "info");
  refreshAll();
  syncAutoRefresh();
}

function syncAutoRefresh() {
  clearInterval(state.statusTimer);
  clearInterval(state.logTimer);
  state.statusTimer = null;
  state.logTimer = null;

  if (!el.autoRefresh.checked) {
    appendActivity("Auto refresh paused.", "info");
    return;
  }

  state.statusTimer = setInterval(() => refreshStatus(), STATUS_REFRESH_MS);
  state.logTimer = setInterval(() => refreshLogs(), LOG_REFRESH_MS);
}

async function refreshAll(options = {}) {
  await Promise.all([refreshStatus(options), refreshLogs(options)]);
}

async function refreshStatus(options = {}) {
  if (state.isRefreshingStatus) return;
  state.isRefreshingStatus = true;
  el.manualRefresh.disabled = true;

  try {
    const status = await fetchJson("/api/status");
    state.status = status && typeof status === "object" ? status : {};
    state.statusError = null;
    el.lastRefreshed.textContent = formatDateTime(new Date());
    if (options.manual) appendActivity("Status refreshed.", "success");
  } catch (error) {
    state.statusError = error;
    if (options.manual) appendActivity(`Status refresh failed: ${error.message}`, "error");
  } finally {
    state.isRefreshingStatus = false;
    el.manualRefresh.disabled = false;
    renderStatus();
    renderMemory();
  }
}

async function refreshLogs(options = {}) {
  if (state.isRefreshingLogs) return;
  state.isRefreshingLogs = true;
  el.refreshLogs.disabled = true;
  renderLogStatus("Loading log lines...");

  const logBox = el.logOutput;
  const wasAtBottom = isScrolledToBottom(logBox);
  const previousScrollTop = logBox.scrollTop;

  try {
    const payload = await fetchTextOrJson(`/api/logs?name=${encodeURIComponent(state.activeLog)}&lines=${LOG_LINES}`);
    state.logText = normalizeLogPayload(payload);
    state.logError = null;
    if (options.manual) appendActivity(`${LOG_LABELS[state.activeLog]} logs refreshed.`, "success");
  } catch (error) {
    state.logError = error;
    if (options.manual) appendActivity(`${LOG_LABELS[state.activeLog]} log refresh failed: ${error.message}`, "error");
  } finally {
    state.isRefreshingLogs = false;
    el.refreshLogs.disabled = false;
    renderLogs();
    if (wasAtBottom) {
      logBox.scrollTop = logBox.scrollHeight;
    } else {
      logBox.scrollTop = previousScrollTop;
    }
  }
}

function renderStatus() {
  const statuses = STATUS_CARDS.map((card) => {
    const data = getFirstObject(state.status, card.paths);
    const status = normalizeStatus(card, data);
    renderStatusCard(card, data, status);
    return status;
  });

  const overall = state.statusError ? "error" : aggregateHealth(statuses);
  el.overallHealth.dataset.state = overall;
  el.overallHealthLabel.textContent = state.statusError
    ? "API unavailable"
    : healthLabel(overall);
}

function renderStatusCard(card, data, status) {
  const node = document.querySelector(`[data-card="${card.key}"]`);
  const detailRows = buildDetailRows(card, data);
  const stateLine = state.statusError
    ? escapeHtml(state.statusError.message)
    : escapeHtml(status.message || "No backend detail provided.");
  const statusOnly = card.statusOnly ? '<span class="status-only">Status-only</span>' : "";

  node.dataset.state = state.statusError ? "error" : status.state;
  node.innerHTML = `
    <div class="status-card-head">
      <h2>${escapeHtml(card.title)}</h2>
      ${statusOnly}
    </div>
    <div class="card-state">
      <span class="dot" aria-hidden="true"></span>
      <strong>${escapeHtml(state.statusError ? "Unavailable" : healthLabel(status.state))}</strong>
    </div>
    <p>${stateLine}</p>
    <dl>${detailRows || "<div><dt>Data</dt><dd>Missing</dd></div>"}</dl>
  `;
}

function renderMemory() {
  const rolling = getFirstObject(state.status, ["rollingSummary", "rollingMemory"]) || {};
  const sessions = Array.isArray(rolling.sessions) ? rolling.sessions : [];
  const longTermMemory = rolling.longTermMemory;
  el.memoryCount.textContent = sessions.length === 1 ? "1 session" : `${sessions.length} sessions`;
  el.memoryList.replaceChildren();

  if (state.statusError) {
    setMemoryState(`Rolling memory unavailable: ${state.statusError.message}`);
    return;
  }

  if (!sessions.length) {
    setMemoryState("No rolling memory session metadata returned.");
    return;
  }

  el.memoryState.hidden = true;
  if (longTermMemory && longTermMemory.memoriesChars > 0) {
    el.memoryList.appendChild(renderLongTermMemory(longTermMemory));
  }
  sessions.forEach((session) => {
    el.memoryList.appendChild(renderMemorySession(session));
  });
}

function renderLongTermMemory(memory) {
  const article = document.createElement("article");
  article.className = "memory-card memory-card-action";
  article.tabIndex = 0;
  article.setAttribute("role", "button");

  article.innerHTML = `
    <div class="memory-card-head">
      <h3>Long-term memory</h3>
      <span>${escapeHtml(formatMaybeDate(memory.updatedAt))}</span>
    </div>
    <dl>
      <div><dt>Memory chars</dt><dd>${escapeHtml(formatValue(memory.memoriesChars))}</dd></div>
      <div><dt>Memory type</dt><dd>${escapeHtml(formatValue(memory.memoriesType))}</dd></div>
    </dl>
    <div class="summary-preview">
      <span>Click to view full content</span>
      <p>${escapeHtml(memory.preview || "Full content is available on demand.")}</p>
    </div>
  `;
  wireMemoryOpen(article, () => openMemoryDetail({ type: "longTerm" }));
  return article;
}

function renderMemorySession(session) {
  const article = document.createElement("article");
  article.className = "memory-card memory-card-action";
  article.tabIndex = 0;
  article.setAttribute("role", "button");

  const fields = [
    ["Rounds", session.roundCount],
    ["Version", session.version],
    ["Last compacted round", session.lastCompactedRound],
    ["Summarizing", formatBoolean(session.isSummarizing)],
    ["Summary disabled", formatBoolean(session.summaryDisabled)],
    ["Summary failures", session.summaryFailures],
    ["Skipped cycles", session.skippedCycles],
    ["Updated", formatMaybeDate(session.updatedAt)],
    ["Compacted", formatMaybeDate(session.compactedAt)],
    ["Summary chars", session.summaryChars],
  ];

  article.innerHTML = `
    <div class="memory-card-head">
      <h3>${escapeHtml(session.sessionId || "Unknown session")}</h3>
      <span>${escapeHtml(formatMaybeDate(session.updatedAt))}</span>
    </div>
    <dl>${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(formatValue(value))}</dd></div>`).join("")}</dl>
    <div class="summary-preview">
      <span>Summary preview · click to view full content</span>
      <p>${escapeHtml(session.summaryPreview || "No preview available.")}</p>
    </div>
  `;
  wireMemoryOpen(article, () => openMemoryDetail({ type: "session", sessionId: session.sessionId }));
  return article;
}

function wireMemoryOpen(node, handler) {
  node.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input, select, textarea")) return;
    handler();
  });
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handler();
  });
}

async function openMemoryDetail(params) {
  if (!el.memoryDialog?.showModal) return;
  const search = new URLSearchParams(params);
  el.memoryDialogTitle.textContent = "Loading memory...";
  el.memoryDialogMeta.textContent = "";
  el.memoryDialogContent.textContent = "Loading...";
  el.memoryDialog.showModal();

  try {
    const payload = await fetchJson(`/api/memory?${search.toString()}`);
    el.memoryDialogTitle.textContent = payload.title || "Memory";
    el.memoryDialogMeta.textContent = buildMemoryMeta(payload);
    el.memoryDialogContent.textContent = payload.content || "No memory content returned.";
  } catch (error) {
    el.memoryDialogTitle.textContent = "Memory unavailable";
    el.memoryDialogMeta.textContent = "";
    el.memoryDialogContent.textContent = error.message;
  }
}

function renderLogs() {
  const filter = el.logFilter.value;
  const lines = state.logText.split(/\r?\n/).filter((line) => matchesLogFilter(line, filter));
  const text = lines.join("\n").trimEnd();

  if (state.logError) {
    el.logOutput.textContent = "";
    renderLogStatus(`${LOG_LABELS[state.activeLog]} logs unavailable: ${state.logError.message}`);
    return;
  }

  if (!text) {
    el.logOutput.textContent = "";
    renderLogStatus(`No ${filter === "all" ? "" : `${filter} `}${LOG_LABELS[state.activeLog]} log lines returned.`);
    return;
  }

  el.logOutput.textContent = text;
  renderLogStatus(`${lines.length} line${lines.length === 1 ? "" : "s"} shown from ${LOG_LABELS[state.activeLog]}.`);
}

function setActiveLog(name) {
  if (!LOG_LABELS[name] || name === state.activeLog) return;
  state.activeLog = name;
  state.logText = "";
  state.logError = null;

  document.querySelectorAll("[data-log]").forEach((button) => {
    const isActive = button.dataset.log === name;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  el.logOutput.textContent = "";
  renderLogStatus(`Loading ${LOG_LABELS[name]} logs...`);
  refreshLogs({ manual: true });
}

async function confirmAction(actionKey) {
  const action = ACTIONS[actionKey];
  if (!action) return;

  const confirmed = await openConfirm(action.label, action.confirm);
  if (!confirmed) {
    appendActivity(`${action.label} canceled.`, "info");
    return;
  }

  await runAction(actionKey, action);
}

async function runAction(actionKey, action) {
  const button = document.querySelector(`[data-action="${actionKey}"]`);
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Working...";
  appendActivity(`${action.label} requested.`, "pending");

  try {
    const result = await fetchJson(action.endpoint, { method: "POST" });
    appendActivity(`${action.label} succeeded: ${summarizeActionResult(result)}`, "success");
    await refreshAll();
  } catch (error) {
    appendActivity(`${action.label} failed: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function openConfirm(title, message) {
  if (!el.confirmDialog.showModal) {
    return Promise.resolve(window.confirm(message));
  }

  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmDialog.showModal();
  el.confirmSubmit.focus();

  return new Promise((resolve) => {
    const closeHandler = () => {
      el.confirmDialog.removeEventListener("close", closeHandler);
      resolve(el.confirmDialog.returnValue === "confirm");
    };
    el.confirmDialog.addEventListener("close", closeHandler);
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function fetchTextOrJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json, text/plain" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function normalizeLogPayload(payload) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  if (Array.isArray(payload.lines)) return payload.lines.join("\n");
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.log === "string") return payload.log;
  if (typeof payload.output === "string") return payload.output;
  return JSON.stringify(payload, null, 2);
}

function normalizeStatus(card, data) {
  if (card.key === "rollingMemory" && Array.isArray(data?.sessions) && data.sessions.length) {
    return { state: "ok", message: `${data.sessions.length} session metadata record${data.sessions.length === 1 ? "" : "s"}.` };
  }

  if (!data || typeof data !== "object") {
    if (card.key === "rollingMemory") {
      const sessions = getFirstObject(state.status, ["rollingSummary", "rollingMemory"])?.sessions;
      if (Array.isArray(sessions) && sessions.length) {
        return { state: "ok", message: `${sessions.length} session metadata record${sessions.length === 1 ? "" : "s"}.` };
      }
    }
    return { state: "unknown", message: "Status field missing." };
  }

  const raw = String(data.status || data.state || data.health || "").toLowerCase();
  const stateName = raw.includes("ok") || raw.includes("up") || raw.includes("healthy") || data.running === true
    ? "ok"
    : raw.includes("warn") || raw.includes("degraded") || raw.includes("stale")
      ? "warn"
      : raw.includes("err") || raw.includes("down") || raw.includes("fail") || data.running === false
        ? "error"
        : "unknown";

  return {
    state: stateName,
    message: data.message || data.detail || data.reason || data.status || data.state || "",
  };
}

function aggregateHealth(statuses) {
  if (statuses.some((status) => status.state === "error")) return "error";
  if (statuses.some((status) => status.state === "warn")) return "warn";
  if (statuses.some((status) => status.state === "unknown")) return "unknown";
  return "ok";
}

function buildDetailRows(card, data) {
  if (!data || typeof data !== "object") return "";
  const rows = [];
  const rolling = card.key === "rollingMemory" ? getFirstObject(state.status, ["rollingSummary", "rollingMemory"]) : null;

  card.details.forEach((field) => {
    let value = data[field];
    if (card.key === "rollingMemory" && field === "sessionCount") {
      value = Array.isArray(rolling?.sessions) ? rolling.sessions.length : data.sessionCount;
    }
    if (value !== undefined && value !== null && value !== "") {
      rows.push(`<div><dt>${escapeHtml(labelize(field))}</dt><dd>${escapeHtml(formatValue(value))}</dd></div>`);
    }
  });

  return rows.join("");
}

function getFirstObject(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const value = source[key];
    if (value && typeof value === "object") return value;
  }
  return null;
}

function matchesLogFilter(line, filter) {
  if (filter === "all") return true;
  const lower = line.toLowerCase();
  if (filter === "rolling-summary") {
    return lower.includes("rolling-summary") || lower.includes("rolling summary") || lower.includes("rollingsummary");
  }
  return lower.includes(filter);
}

function appendActivity(message, type = "info") {
  const item = document.createElement("li");
  item.dataset.type = type;
  item.innerHTML = `<time>${escapeHtml(formatTime(new Date()))}</time><span>${escapeHtml(message)}</span>`;
  el.activityList.prepend(item);
  while (el.activityList.children.length > 30) {
    el.activityList.lastElementChild.remove();
  }
}

function setMemoryState(message) {
  el.memoryState.hidden = false;
  el.memoryState.textContent = message;
}

function renderLogStatus(message) {
  el.logStatus.textContent = message;
}

function summarizeActionResult(result) {
  if (!result || typeof result !== "object") return "completed";
  return result.message || result.status || result.result || "completed";
}

function buildMemoryMeta(payload) {
  const parts = [];
  if (payload.sessionId) parts.push(payload.sessionId);
  if (payload.updatedAt) parts.push(`Updated ${formatMaybeDate(payload.updatedAt)}`);
  if (payload.compactedAt) parts.push(`Compacted ${formatMaybeDate(payload.compactedAt)}`);
  if (Number.isFinite(payload.chars)) parts.push(`${payload.chars.toLocaleString()} chars`);
  return parts.join(" · ");
}

function isScrolledToBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 16;
}

function healthLabel(stateName) {
  return {
    ok: "Healthy",
    warn: "Degraded",
    error: "Critical",
    unknown: "Unknown",
  }[stateName] || "Unknown";
}

function labelize(value) {
  return String(value).replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}

function formatValue(value) {
  if (value === undefined || value === null || value === "") return "Missing";
  if (typeof value === "boolean") return formatBoolean(value);
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : "Missing";
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).join(", ");
  if (typeof value === "object") return formatObjectCompact(value);
  return String(value);
}

function formatObjectCompact(value) {
  return Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== "")
    .map(([key, entryValue]) => `${labelize(key)}: ${formatValue(entryValue)}`)
    .join("; ") || "Missing";
}

function formatBoolean(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Missing";
}

function formatMaybeDate(value) {
  if (!value) return "Missing";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : formatDateTime(date);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}
