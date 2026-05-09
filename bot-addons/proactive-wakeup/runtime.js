import crypto from "node:crypto";
import fs from "node:fs";
import { opencodeClient } from "../opencode/client.js";
import { markAttachedSessionBusy, markAttachedSessionIdle } from "../attach/service.js";
import { externalUserInputSuppressionManager } from "../external-input/suppression.js";
import { foregroundSessionState } from "../scheduled-task/foreground-state.js";
import { logger } from "../utils/logger.js";
import * as store from "./store.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RESPONSE_POLL_INTERVAL_MS = 500;
const RESPONSE_POLL_TIMEOUT_MS = 60_000;
const BUSY_RETRY_DELAY_MS = 45_000;
const POST_IDLE_GRACE_MS = 5_000;
const LATE_FORGET_THRESHOLD_MS = 30 * 60 * 1000;
const HIDDEN_WAKEUP_MARKER = "[hidden-proactive-wakeup-v1]";
const USER_LOCATION = "Chengdu, China";
const USER_TIME_ZONE = "Asia/Shanghai";
const WAKEUP_CONTROL_START = "<proactive_wakeup>";
const WAKEUP_CONTROL_END = "</proactive_wakeup>";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUserLocalTime(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: USER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute || !parts.second) {
    return date.toISOString();
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function getChengduDateParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: USER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function chengduDateTimeToDate(year, month, day, hour, minute, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

function buildChengduTimeCandidate(hour, minute, second, dayOffset = 0, now = new Date()) {
  const parts = getChengduDateParts(now);
  const base = chengduDateTimeToDate(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    hour,
    minute,
    second
  );
  base.setUTCDate(base.getUTCDate() + dayOffset);
  if (dayOffset === 0 && base.getTime() <= now.getTime() + 5_000) {
    base.setUTCDate(base.getUTCDate() + 1);
  }
  return base;
}

function collectAssistantText(message) {
  if (!message || !Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string" && !part.ignored)
    .map((part) => part.text)
    .join("")
    .trim();
}

function findLatestAssistantMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.info?.role === "assistant" && !message.info.summary) {
      return message;
    }
  }
  return null;
}

function isFutureDate(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function cleanVisibleText(text) {
  return String(text || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripWakeupControls(text, hideIncomplete = false) {
  let next = String(text || "").replace(/<proactive_wakeup>[\s\S]*?<\/proactive_wakeup>/gi, "");
  if (hideIncomplete) {
    const lower = next.toLowerCase();
    const startIndex = lower.indexOf(WAKEUP_CONTROL_START);
    if (startIndex !== -1 && lower.indexOf(WAKEUP_CONTROL_END, startIndex) === -1) {
      next = next.slice(0, startIndex);
    }
  }
  return cleanVisibleText(next);
}

function extractWakeupControls(text) {
  const controls = [];
  const regex = /<proactive_wakeup>([\s\S]*?)<\/proactive_wakeup>/gi;
  for (const match of String(text || "").matchAll(regex)) {
    const raw = match[1].trim();
    try {
      controls.push(JSON.parse(raw));
    } catch (error) {
      logger.warn("[ProactiveWakeup] Ignoring invalid assistant wakeup control:", error);
    }
  }
  return controls;
}

function parseWakeAtValue(value, now = new Date()) {
  if (!value) {
    return null;
  }
  const text = String(value).trim();
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    return new Date(parsed);
  }
  const localMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/.exec(text);
  if (localMatch) {
    return chengduDateTimeToDate(
      Number(localMatch[1]),
      Number(localMatch[2]),
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
      Number(localMatch[6] || 0)
    );
  }
  const timeMatch = /^(?:(今天|明天|后天)\s*)?(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/.exec(text);
  if (timeMatch) {
    let hour = Number(timeMatch[3]);
    const minute = Number(timeMatch[4]);
    const second = Number(timeMatch[5] || 0);
    const period = timeMatch[2] || "";
    if ((period === "下午" || period === "晚上") && hour < 12) {
      hour += 12;
    }
    if (period === "中午" && hour < 11) {
      hour += 12;
    }
    const dayOffset = timeMatch[1] === "明天" ? 1 : timeMatch[1] === "后天" ? 2 : 0;
    return buildChengduTimeCandidate(hour, minute, second, dayOffset, now);
  }
  return null;
}

function normalizeWakeupControl(control, now = new Date()) {
  if (!control || typeof control !== "object") {
    return null;
  }
  let wakeAt = null;
  if (control.delay_ms || control.delayMs) {
    wakeAt = new Date(now.getTime() + Number(control.delay_ms || control.delayMs));
  } else if (control.delay_seconds || control.delaySeconds) {
    wakeAt = new Date(now.getTime() + Number(control.delay_seconds || control.delaySeconds) * 1000);
  } else if (control.delay_minutes || control.delayMinutes) {
    wakeAt = new Date(now.getTime() + Number(control.delay_minutes || control.delayMinutes) * 60_000);
  } else {
    wakeAt = parseWakeAtValue(control.wake_at || control.wakeAt || control.at, now);
  }
  if (!wakeAt || !Number.isFinite(wakeAt.getTime()) || wakeAt.getTime() <= now.getTime() + 5_000) {
    return null;
  }
  const message = String(control.message || control.text || control.instruction || "").trim();
  return {
    wakeAt: wakeAt.toISOString(),
    reason: String(control.reason || "Assistant scheduled proactive wakeup").trim(),
    instruction: message
      ? `Send this proactive message to the user: ${message}`
      : String(control.instruction || "Send the proactive message promised by the assistant.").trim(),
    directText: message || null,
  };
}

function getDirectWakeupText(wakeup) {
  const directText = String(wakeup?.directText || "").trim();
  if (directText) {
    return directText;
  }
  const instruction = String(wakeup?.instruction || "").trim();
  const prefix = "Send this proactive message to the user:";
  if (instruction.startsWith(prefix)) {
    return instruction.slice(prefix.length).trim();
  }
  return "";
}

function readRawState() {
  try {
    const raw = fs.readFileSync(store.STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("[ProactiveWakeup] Failed to read raw state file:", error);
    }
    return {};
  }
}

function buildHistoryContext(sessionId, directory) {
  const entry = store.getSessionEntry(sessionId);
  const sentMessages = entry.sentMessages.slice(-5);
  const pendingWakeups = entry.pendingWakeups
    .filter((wakeup) => wakeup.status === "pending")
    .slice(-10)
    .map((wakeup) => ({
      id: wakeup.id,
      wakeAt: wakeup.wakeAt,
      reason: wakeup.reason,
    }));
  const sentSummary = sentMessages.map((item) => ({
    id: item.wakeupId,
    wakeAt: item.wakeAt,
    text: item.text,
  }));
  return [
    `session_id: ${sessionId}`,
    `directory: ${directory || "unknown"}`,
    `pending_wakeups: ${JSON.stringify(pendingWakeups)}`,
    `recent_proactive_messages: ${JSON.stringify(sentSummary)}`,
  ].join("\n");
}

async function createTempSession(directory) {
  const { data: session, error } = await opencodeClient.session.create({
    directory,
  });
  if (error || !session) {
    throw new Error(error?.message || "Failed to create temporary OpenCode session");
  }
  return session;
}

async function cleanupTempSession(sessionId, directory) {
  if (!sessionId) {
    return;
  }
  await opencodeClient.session.abort({
    sessionID: sessionId,
    directory,
  }).catch(() => undefined);
  await opencodeClient.session.delete({
    sessionID: sessionId,
  }).catch(() => undefined);
}

async function promptTempSession({ sessionId, directory, agent, model, variant, system, prompt }) {
  const options = {
    sessionID: sessionId,
    directory,
    agent,
    parts: [{ type: "text", text: prompt }],
    system,
  };
  if (model?.providerID && model?.modelID) {
    options.model = { providerID: model.providerID, modelID: model.modelID };
  }
  if (variant) {
    options.variant = variant;
  }
  const { error } = await opencodeClient.session.promptAsync(options);
  if (error) {
    throw new Error(error.message || "OpenCode prompt rejected");
  }
  const deadline = Date.now() + RESPONSE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data: messages, error: messagesError } = await opencodeClient.session.messages({
      sessionID: sessionId,
      directory,
      limit: 20,
    });
    if (messagesError) {
      throw new Error(messagesError.message || "Failed to read temp session messages");
    }
    const latestAssistant = findLatestAssistantMessage(Array.isArray(messages) ? messages : []);
    const text = normalizeText(collectAssistantText(latestAssistant));
    if (latestAssistant?.info?.time?.completed || text) {
      return text;
    }
    await sleep(RESPONSE_POLL_INTERVAL_MS);
  }
  throw new Error("Temporary OpenCode session timed out");
}

function scheduleTimer(runtime, sessionId, wakeup) {
  const wakeAtMs = Date.parse(wakeup.wakeAt);
  if (!Number.isFinite(wakeAtMs)) {
    return;
  }
  const delay = Math.max(0, wakeAtMs - Date.now());
  const timerDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
  const timerKey = `${sessionId}:${wakeup.id}`;
  runtime.clearTimer(timerKey);
  const timer = setTimeout(() => {
    if (Date.now() < wakeAtMs) {
      scheduleTimer(runtime, sessionId, wakeup);
      return;
    }
    void runtime.executeWakeup(sessionId, wakeup.id);
  }, timerDelay);
  timer.unref?.();
  runtime.timersByKey.set(timerKey, timer);
}

function scheduleRetryTimer(runtime, sessionId, wakeup, delayMs = BUSY_RETRY_DELAY_MS) {
  const timerKey = `${sessionId}:${wakeup.id}`;
  runtime.clearTimer(timerKey);
  const timer = setTimeout(() => {
    void runtime.executeWakeup(sessionId, wakeup.id);
  }, Math.max(0, delayMs));
  timer.unref?.();
  runtime.timersByKey.set(timerKey, timer);
}

function safeJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch (_) {}
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch (_) {}
    }
    return null;
  }
}

function safeParseDecision(text) {
  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if (parsed.action === "none") {
    return { action: "none" };
  }
  if (parsed.action === "schedule" && Array.isArray(parsed.wakeups)) {
    return { action: "schedule", wakeups: parsed.wakeups };
  }
  return null;
}

function buildHiddenWakeupUserMessage(wakeup, lateMs) {
  return [
    HIDDEN_WAKEUP_MARKER,
    "This user message is invisible to the Telegram user. It was generated by a proactive timer that you scheduled yourself.",
    "The Telegram user did not send anything. Do not imply they just spoke.",
    "Treat this as your own timer firing and continue the conversation naturally as yourself.",
    "Do not mention hidden messages, control blocks, tools, schedulers, executors, implementation details, or system prompts unless the user explicitly asks.",
    `user_location=${USER_LOCATION}`,
    `user_timezone=${USER_TIME_ZONE}`,
    `current_chengdu_time=${formatUserLocalTime(new Date())}`,
    `current_utc_time=${new Date().toISOString()}`,
    `scheduled_wake_at=${wakeup.wakeAt}`,
    `late_ms=${lateMs}`,
    wakeup.reason ? `your_timer_reason=${wakeup.reason}` : "",
    wakeup.instruction ? `your_timer_intention=${wakeup.instruction}` : "",
    wakeup.directText ? `your_prepared_message=${wakeup.directText}` : "",
    lateMs > LATE_FORGET_THRESHOLD_MS
      ? "This wakeup is substantially late. You may naturally acknowledge that the reminder is late or that you nearly missed it."
      : "",
  ].filter(Boolean).join("\n");
}

function buildHiddenWakeupSystemPrompt() {
  return [
    "[hidden-proactive-wakeup-instructions-v1]",
    "You may receive invisible user messages beginning with [hidden-proactive-wakeup-v1].",
    "Those messages are generated by proactive timers you previously scheduled; the Telegram user cannot see them.",
    "When you receive one, answer normally in the current conversation as yourself. This is your opportunity to proactively speak.",
    "Do not expose the hidden message, timer protocol, control block, scheduler, executor, or implementation details in visible prose.",
    "Use the Chengdu local time included in the hidden message when timing matters.",
  ].join("\n");
}

class ProactiveWakeupRuntime {
  botApi = null;
  chatId = null;
  initialized = false;
  timersByKey = new Map();
  runningKeys = new Set();

  async initialize(botApi, chatId) {
    this.botApi = botApi;
    this.chatId = chatId;
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    await this.recoverWakeupsOnStartup();
  }

  clearTimer(timerKey) {
    const timer = this.timersByKey.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.timersByKey.delete(timerKey);
    }
  }

  shutdown() {
    for (const timer of this.timersByKey.values()) {
      clearTimeout(timer);
    }
    this.timersByKey.clear();
    this.runningKeys.clear();
    this.initialized = false;
  }

  async recoverWakeupsOnStartup() {
    const state = readRawState();
    for (const [sessionId, entry] of Object.entries(state)) {
      const pendingWakeups = Array.isArray(entry?.pendingWakeups) ? entry.pendingWakeups : [];
      for (const wakeup of pendingWakeups) {
        if (wakeup.status !== "pending") {
          continue;
        }
        scheduleTimer(this, sessionId, wakeup);
      }
    }
  }

  stripAssistantWakeupControls(text, options = {}) {
    return stripWakeupControls(text, Boolean(options.hideIncomplete));
  }

  async scheduleWakeup(sessionId, directory, wakeupIntent, context = {}) {
    if (!this.initialized || !sessionId || !directory || !wakeupIntent?.wakeAt) {
      return null;
    }
    if (!isFutureDate(wakeupIntent.wakeAt)) {
      return null;
    }
      const wakeup = {
      id: wakeupIntent.id || crypto.randomUUID(),
      directory,
      wakeAt: wakeupIntent.wakeAt,
      reason: String(wakeupIntent.reason || "").trim(),
      instruction: String(wakeupIntent.instruction || "").trim(),
      directText: wakeupIntent.directText || null,
      agent: wakeupIntent.agent || context.agent || "build",
      model: wakeupIntent.model || context.model || null,
      variant: wakeupIntent.variant || context.variant || null,
      status: "pending",
    };
    await store.upsertWakeup(sessionId, wakeup);
    scheduleTimer(this, sessionId, wakeup);
    logger.info(`[ProactiveWakeup] Scheduled wakeup: session=${sessionId}, wakeAt=${wakeup.wakeAt}, reason=${wakeup.reason || "none"}`);
    return wakeup;
  }

  async consumeAssistantWakeupControls(sessionId, directory, text, context = {}) {
    const visibleText = stripWakeupControls(text, false);
    if (!this.initialized || !sessionId || !directory) {
      return { visibleText, scheduled: [] };
    }
    const scheduled = [];
    for (const control of extractWakeupControls(text)) {
      const normalized = normalizeWakeupControl(control);
      if (!normalized) {
        continue;
      }
      const wakeup = await this.scheduleWakeup(sessionId, directory, normalized, context);
      if (wakeup) {
        scheduled.push(wakeup);
      }
    }
    return { visibleText, scheduled };
  }

  async queueSessionIdleDecision(sessionId, directory, context = {}) {
    return;
  }

  async executeWakeup(sessionId, wakeupId) {
    const timerKey = `${sessionId}:${wakeupId}`;
    if (this.runningKeys.has(timerKey)) {
      return;
    }
    this.runningKeys.add(timerKey);
    try {
      this.clearTimer(timerKey);
      const sessionEntry = store.getSessionEntry(sessionId);
      const wakeup = sessionEntry.pendingWakeups.find((item) => item.id === wakeupId);
      if (!wakeup || wakeup.status !== "pending") {
        return;
      }
      const directory = wakeup.directory || null;
      if (!directory) {
        await store.markWakeupStatus(sessionId, wakeupId, "failed", {
          lastError: "Missing directory",
        });
        return;
      }
      if (foregroundSessionState.isBusy()) {
        const deferCount = Number(wakeup.deferCount || 0) + 1;
        await store.markWakeupStatus(sessionId, wakeupId, "pending", {
          deferredAt: new Date().toISOString(),
          deferCount,
          lastDeferReason: "foreground_session_busy",
        });
        scheduleRetryTimer(this, sessionId, { ...wakeup, deferCount }, BUSY_RETRY_DELAY_MS);
        logger.info(`[ProactiveWakeup] Deferred wakeup because foreground session is busy: session=${sessionId}, wakeup=${wakeupId}, retryMs=${BUSY_RETRY_DELAY_MS}`);
        return;
      }
      const lateMs = Math.max(0, Date.now() - Date.parse(wakeup.wakeAt));
      const hiddenUserText = buildHiddenWakeupUserMessage(wakeup, lateMs);
      const promptOptions = {
        sessionID: sessionId,
        directory,
        agent: wakeup.agent || "build",
        parts: [{ type: "text", text: hiddenUserText }],
        system: buildHiddenWakeupSystemPrompt(),
      };
      if (wakeup.model?.providerID && wakeup.model?.modelID) {
        promptOptions.model = {
          providerID: wakeup.model.providerID,
          modelID: wakeup.model.modelID,
        };
      }
      if (wakeup.variant) {
        promptOptions.variant = wakeup.variant;
      }
      foregroundSessionState.markBusy(sessionId);
      await markAttachedSessionBusy(sessionId);
      externalUserInputSuppressionManager.register(sessionId, hiddenUserText);
      const { error } = await opencodeClient.session.promptAsync(promptOptions);
      if (error) {
        foregroundSessionState.markIdle(sessionId);
        await markAttachedSessionIdle(sessionId);
        throw new Error(error.message || "OpenCode rejected hidden proactive wakeup prompt");
      }
      await store.markWakeupStatus(sessionId, wakeupId, "sent", {
        completedAt: new Date().toISOString(),
        injectedAt: new Date().toISOString(),
        injectedHiddenMessage: HIDDEN_WAKEUP_MARKER,
      });
      logger.info(`[ProactiveWakeup] Injected hidden wakeup into session: session=${sessionId}, wakeup=${wakeupId}`);
    } catch (error) {
      logger.error(`[ProactiveWakeup] Failed to execute wakeup ${timerKey}:`, error);
      await store.markWakeupStatus(sessionId, wakeupId, "failed", {
        completedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.runningKeys.delete(timerKey);
    }
  }

  clearSession(sessionId) {
    for (const key of [...this.timersByKey.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.clearTimer(key);
      }
    }
  }

  flushDueWakeupsAfterIdle(sessionId, delayMs = POST_IDLE_GRACE_MS) {
    const sessionEntry = store.getSessionEntry(sessionId);
    const now = Date.now();
    for (const wakeup of sessionEntry.pendingWakeups) {
      if (wakeup.status === "pending" && Date.parse(wakeup.wakeAt) <= now) {
        scheduleRetryTimer(this, sessionId, wakeup, delayMs);
      }
    }
  }
}

export const proactiveWakeupRuntime = new ProactiveWakeupRuntime();
