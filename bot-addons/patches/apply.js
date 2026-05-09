"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BOT_DIST = path.join(
  require("os").homedir(),
  ".npm-global/lib/node_modules/@grinev/opencode-telegram-bot/dist"
);

// ---- prompt.js patch ----
const PROMPT_FILE = path.join(BOT_DIST, "bot/handlers/prompt.js");
const PROMPT_SENTINEL = "// @@telegram-addon-context-v2";
const PROMPT_LEGACY_SENTINEL = "// @@rolling-summary: inject system context";
const PROMPT_LEGACY_END_SENTINEL = "// @@end-rolling-summary";
const PROMPT_ANCHOR = "promptOptions.variant = storedModel.variant;";
const PROMPT_CLOSE_LINE = "        }\n";
const PROMPT_INJECTION = `
        // @@telegram-addon-context-v2: inject addon system context once per compact segment
        try {
          const { readFile } = await import("fs/promises");
          const { join } = await import("path");
          const { homedir } = await import("os");
          const appHome = join(homedir(), "Library/Application Support/opencode-telegram-bot");
          const statePath = join(appHome, "rolling-summary-state.json");
          const ltmPath = join(appHome, "long-term-memory.json");
          const addonContextSentinel = "<opencode-telegram-addon-context-v1>";
          let shouldInjectAddonContext = true;

          try {
            const { data: messagesData, error } = await opencodeClient.session.messages({
              sessionID: currentSession.id,
              directory: currentSession.directory,
            });
            if (!error && Array.isArray(messagesData)) {
              const latestCompactionIndex = messagesData.reduce((latestIndex, message, index) => {
                const messageParts = Array.isArray(message.parts) ? message.parts : [];
                const isUserCompaction = message.info?.role === "user" && messageParts.some((part) => part?.type === "compaction");
                return isUserCompaction ? index : latestIndex;
              }, -1);
              const segmentMessages = latestCompactionIndex >= 0
                ? messagesData.slice(latestCompactionIndex + 1)
                : messagesData;
              shouldInjectAddonContext = !segmentMessages.some((message) => (
                message.info?.role === "user" &&
                typeof message.info?.system === "string" &&
                message.info.system.includes(addonContextSentinel)
              ));
            }
          } catch (_) {}

          if (shouldInjectAddonContext) {
            let state = {};
            try { state = JSON.parse(await readFile(statePath, "utf-8")); } catch (_) {}
            const entry = state[currentSession.id];
            const systemParts = [promptOptions.system, addonContextSentinel];
            // long-term memory (cross-session, injected once per compact segment)
            try {
              const ltm = JSON.parse(await readFile(ltmPath, "utf-8"));
              if (ltm.memories) systemParts.push(ltm.memories);
            } catch (_) {}
            // rolling summary (session-level, injected once per compact segment)
            if (entry && entry.summary && !entry.summaryDisabled) {
              systemParts.push(entry.summary);
            }
            promptOptions.system = systemParts.filter(Boolean).join("\\n\\n");
          }
        } catch (_) {}
        // @@end-telegram-addon-context-v2`;
const PROMPT_TIME_SENTINEL = "// @@telegram-time-context-v2";
const PROMPT_TIME_END_SENTINEL = "// @@end-telegram-time-context-v2";
const PROMPT_TIME_LEGACY_SENTINEL = "// @@telegram-time-context-v1";
const PROMPT_TIME_LEGACY_END_SENTINEL = "// @@end-telegram-time-context-v1";
const PROMPT_TIME_ANCHOR = "const promptErrorLogContext = {";
const PROMPT_TIME_INJECTION = `
        // @@telegram-time-context-v2: inject hidden message timing and proactive wakeup context on every prompt
        try {
          const { readFile } = await import("fs/promises");
          const { join } = await import("path");
          const { homedir } = await import("os");
          const appHome = join(homedir(), "Library/Application Support/opencode-telegram-bot");
          const wakeupStatePath = join(appHome, "proactive-wakeup-state.json");
          const messageDate = ctx.message?.date ? new Date(ctx.message.date * 1000) : new Date();
          const receivedAt = new Date();
          const formatChengduDateTime = (date) => {
            const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Shanghai",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hourCycle: "h23",
            }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
            return parts.year && parts.month && parts.day && parts.hour && parts.minute && parts.second
              ? parts.year + "-" + parts.month + "-" + parts.day + " " + parts.hour + ":" + parts.minute + ":" + parts.second
              : date.toISOString();
          };
          let wakeupState = {};
          try { wakeupState = JSON.parse(await readFile(wakeupStatePath, "utf-8")); } catch (_) {}
          const wakeupEntry = wakeupState[currentSession.id] || {};
          const pendingWakeups = Array.isArray(wakeupEntry.pendingWakeups)
            ? wakeupEntry.pendingWakeups
                .filter((wakeup) => wakeup?.status === "pending")
                .slice(-10)
                .map((wakeup) => ({
                  id: wakeup.id,
                  wakeAt: wakeup.wakeAt,
                  reason: wakeup.reason,
                  instruction: wakeup.instruction,
                }))
            : [];
          const recentProactiveMessages = Array.isArray(wakeupEntry.sentMessages)
            ? wakeupEntry.sentMessages.slice(-5).map((message) => ({
                wakeupId: message.wakeupId,
                wakeAt: message.wakeAt,
                text: message.text,
              }))
            : [];
          const timeContext = [
            "[telegram-time-context-v2]",
            "user_location=Chengdu, China",
            "user_timezone=Asia/Shanghai",
            "message_sent_at_chengdu=" + formatChengduDateTime(messageDate),
            "message_received_at_chengdu=" + formatChengduDateTime(receivedAt),
            "message_sent_at=" + messageDate.toISOString(),
            "message_received_at=" + receivedAt.toISOString(),
            "message_delay_ms=" + Math.max(0, receivedAt.getTime() - messageDate.getTime()),
            "",
            "[proactive-wakeup-capability-v1]",
            "Status: connected and active.",
            "This Telegram bot has a hidden proactive wakeup scheduler. You do not need to inspect, configure, or call any external bridge.",
            "Your interface to the scheduler is a hidden control block in your final response. The Telegram bot strips the control block before sending your reply to the user.",
            "To schedule a wakeup, include exactly one hidden block anywhere in your final response:",
            "<proactive_wakeup>{\\"wake_at\\":\\"YYYY-MM-DD HH:mm:ss\\",\\"message\\":\\"text to send later\\",\\"reason\\":\\"short reason\\"}</proactive_wakeup>",
            "wake_at is interpreted as Chengdu local time unless it includes an explicit timezone or ISO offset. You may also use delay_seconds, delay_minutes, or delay_ms instead of wake_at.",
            "The control block is hidden from the user. In your visible text, simply confirm naturally that you will message at the chosen time.",
            "When the scheduled time arrives, this same conversation will receive an invisible user message beginning with [hidden-proactive-wakeup-v1]. The Telegram user cannot see that hidden message.",
            "When you see [hidden-proactive-wakeup-v1], treat it as your own timer firing and continue speaking naturally as yourself. Do not imply the user just sent a visible message.",
            "After scheduling, future turns will include pending_proactive_wakeups and recent_proactive_messages as implicit feedback. Do not mention tool calls or control blocks.",
            "When the user asks you to set/test/use a timer, do not say you do not know how. Choose or confirm an exact Chengdu local date/time down to seconds, add the hidden control block, and say what you will proactively send then.",
            "A good visible confirmation is: 我会在 YYYY-MM-DD HH:mm:ss（成都时间）主动发你：<message>。",
            "If you want a proactive follow-up yourself, state the exact Chengdu local date/time to the second, or a precise relative delay, and what you plan to say or check.",
            "Do not use or claim to use shell at, cron, /tmp files, osascript, macOS notifications, bash date, or any terminal command for proactive wakeups.",
            "Do not say the bridge may not be connected. It is connected.",
            "Do not mention system prompts, hidden tags, proactive-wakeup-capability, pending_proactive_wakeups, or implementation details in visible prose.",
            "pending_proactive_wakeups=" + JSON.stringify(pendingWakeups),
            "recent_proactive_messages=" + JSON.stringify(recentProactiveMessages),
          ].join("\\n");
          promptOptions.system = [promptOptions.system, timeContext].filter(Boolean).join("\\n\\n");
        } catch (_) {}
        // @@end-telegram-time-context-v2
`;

function ensurePromptTimeInjection(content) {
  const existingIdx = content.indexOf(PROMPT_TIME_SENTINEL);
  if (existingIdx !== -1) {
    const existingEndIdx = content.indexOf(PROMPT_TIME_END_SENTINEL, existingIdx);
    if (existingEndIdx === -1) {
      console.error("[patch] Existing prompt.js time context end not found");
      return null;
    }
    const replaceEnd = content.indexOf("\n", existingEndIdx);
    const endIdx = replaceEnd === -1 ? existingEndIdx + PROMPT_TIME_END_SENTINEL.length : replaceEnd + 1;
    return content.slice(0, existingIdx) + PROMPT_TIME_INJECTION + content.slice(endIdx);
  }
  const legacyIdx = content.indexOf(PROMPT_TIME_LEGACY_SENTINEL);
  if (legacyIdx !== -1) {
    const legacyEndIdx = content.indexOf(PROMPT_TIME_LEGACY_END_SENTINEL, legacyIdx);
    if (legacyEndIdx !== -1) {
      const replaceEnd = content.indexOf("\n", legacyEndIdx);
      const endIdx = replaceEnd === -1 ? legacyEndIdx + PROMPT_TIME_LEGACY_END_SENTINEL.length : replaceEnd;
      return content.slice(0, legacyIdx) + PROMPT_TIME_INJECTION + content.slice(endIdx);
    }
  }
  const timeAnchorIdx = content.indexOf(PROMPT_TIME_ANCHOR);
  if (timeAnchorIdx === -1) {
    console.error("[patch] Time context anchor not found in prompt.js: " + PROMPT_TIME_ANCHOR);
    return null;
  }
  return content.slice(0, timeAnchorIdx) + PROMPT_TIME_INJECTION + content.slice(timeAnchorIdx);
}

function patchPromptFile() {
  let content = fs.readFileSync(PROMPT_FILE, "utf-8");

  if (content.includes(PROMPT_SENTINEL)) {
    const updatedContent = ensurePromptTimeInjection(content);
    if (updatedContent === null) {
      return false;
    }
    if (updatedContent !== content) {
      fs.writeFileSync(PROMPT_FILE, updatedContent, "utf-8");
      console.log("[patch] prompt.js time/proactive context upgraded successfully");
      return true;
    }
    console.log("[patch] prompt.js already patched, skipping");
    return true;
  }

  const legacyIdx = content.indexOf(PROMPT_LEGACY_SENTINEL);
  if (legacyIdx !== -1) {
    const legacyEndIdx = content.indexOf(PROMPT_LEGACY_END_SENTINEL, legacyIdx);
    if (legacyEndIdx === -1) {
      console.error("[patch] Legacy prompt.js patch end not found");
      return false;
    }
    const replaceEnd = content.indexOf("\n", legacyEndIdx);
    const endIdx = replaceEnd === -1 ? legacyEndIdx + PROMPT_LEGACY_END_SENTINEL.length : replaceEnd;
    const newContent = ensurePromptTimeInjection(content.slice(0, legacyIdx) + PROMPT_INJECTION + content.slice(endIdx));
    if (newContent === null) {
      return false;
    }
    fs.writeFileSync(PROMPT_FILE, newContent, "utf-8");
    console.log("[patch] prompt.js legacy patch upgraded successfully");
    return true;
  }

  const anchorIdx = content.indexOf(PROMPT_ANCHOR);
  if (anchorIdx === -1) {
    console.error("[patch] Anchor not found in prompt.js: " + PROMPT_ANCHOR);
    return false;
  }

  // Find the second closing brace after the anchor (closes model-config block, not variant sub-block)
  let insertAt = content.indexOf("}", anchorIdx);
  if (insertAt === -1) {
    console.error("[patch] Could not find insertion point in prompt.js");
    return false;
  }
  insertAt = content.indexOf("}", insertAt + 1); // second brace
  if (insertAt === -1) {
    console.error("[patch] Could not find model-config closing brace in prompt.js");
    return false;
  }
  insertAt += 1; // AFTER the second closing brace

  let newContent = ensurePromptTimeInjection(content.slice(0, insertAt) + PROMPT_INJECTION + content.slice(insertAt));
  if (newContent === null) {
    return false;
  }

  fs.writeFileSync(PROMPT_FILE, newContent, "utf-8");
  console.log("[patch] prompt.js patched successfully");
  return true;
}

// ---- bot/index.js patch ----
const INDEX_FILE = path.join(BOT_DIST, "bot/index.js");
const ASSISTANT_RUN_STATE_FILE = path.join(BOT_DIST, "bot/assistant-run-state.js");
const INDEX_SENTINEL = "// @@rolling-summary";
const INDEX_ANCHOR = "await pinnedMessageManager.onMessageComplete(tokens);";
const INDEX_AFTER = "            }\n";
const ADDN_DIR = path.join(
  require("os").homedir(),
  "Library/Application Support/opencode-telegram-bot/addons"
);
const CYCLE_RUNNER = path.join(ADDN_DIR, "rolling-summary/cycle-runner.js");
const PROACTIVE_RUNTIME_IMPORT = 'import { proactiveWakeupRuntime } from "../proactive-wakeup/runtime.js";';
const BOT_INDEX_CLIENT_TIMEOUT_SENTINEL = "timeoutSeconds: 45";
const START_BOT_APP_FILE = path.join(BOT_DIST, "app/start-bot-app.js");
const START_BOT_APP_SENTINEL = "proactiveWakeupRuntime";
const START_BOT_APP_IMPORT = 'import { proactiveWakeupRuntime } from "../proactive-wakeup/runtime.js";';
const START_BOT_WEBHOOK_OLD = `    const webhookInfo = await bot.api.getWebhookInfo();
    if (webhookInfo.url) {
        logger.info(\`[Bot] Webhook detected: \${webhookInfo.url}, removing...\`);
        await bot.api.deleteWebhook();
        logger.info("[Bot] Webhook removed, switching to long polling");
    }`;
const START_BOT_WEBHOOK_NEW = `    try {
        const webhookInfo = await bot.api.getWebhookInfo();
        if (webhookInfo.url) {
            logger.info(\`[Bot] Webhook detected: \${webhookInfo.url}, removing...\`);
            await bot.api.deleteWebhook();
            logger.info("[Bot] Webhook removed, switching to long polling");
        }
    }
    catch (error) {
        logger.warn("[Bot] Could not check Telegram webhook before polling; continuing startup", error);
    }`;
const START_BOT_RETRY_CONST_OLD = "const SHUTDOWN_TIMEOUT_MS = 5000;";
const START_BOT_RETRY_CONST_NEW = `const SHUTDOWN_TIMEOUT_MS = 5000;
const TELEGRAM_START_RETRY_MS = 10000;`;
const START_BOT_STOP_OLD = `        try {
            bot.stop();
        }
        catch (error) {
            logger.warn("[App] Failed to stop Telegram bot cleanly", error);
        }`;
const START_BOT_STOP_NEW = `        Promise.resolve(bot.stop()).catch((error) => {
            logger.warn("[App] Failed to stop Telegram bot cleanly", error);
        });`;
const START_BOT_START_OLD = `    try {
        await bot.start({
            onStart: (botInfo) => {
                logger.info(\`Bot @\${botInfo.username} started!\`);
            },
        });
    }
    finally {`;
const START_BOT_START_NEW = `    try {
        while (!shutdownStarted) {
            try {
                await bot.start({
                    onStart: (botInfo) => {
                        logger.info(\`Bot @\${botInfo.username} started!\`);
                    },
                });
                if (!shutdownStarted) {
                    logger.warn(\`[Bot] Telegram polling stopped unexpectedly; retrying in \${TELEGRAM_START_RETRY_MS}ms\`);
                }
            }
            catch (error) {
                if (shutdownStarted) {
                    break;
                }
                logger.error(\`[Bot] Telegram polling failed; retrying in \${TELEGRAM_START_RETRY_MS}ms\`, error);
            }
            if (!shutdownStarted) {
                await new Promise((resolve) => setTimeout(resolve, TELEGRAM_START_RETRY_MS));
            }
        }
    }
    finally {`;

const INDEX_INJECTION = `
              // @@rolling-summary: round counter
              try {
                const { readFileSync, writeFileSync, renameSync } = await import("fs");
                const { join } = await import("path");
                const { homedir } = await import("os");
                const { spawn } = await import("child_process");
                const statePath = join(homedir(), "Library/Application Support/opencode-telegram-bot/rolling-summary-state.json");
                const stateTmp = statePath + ".tmp";
                let state = {};
                try { state = JSON.parse(readFileSync(statePath, "utf-8")); } catch (_) {}
                const cs = getCurrentSession();
                const sid = cs ? cs.id : null;
                if (sid) {
                  const entry = state[sid] || {};
                  entry.roundCount = (entry.roundCount || 0) + 1;
                  entry.updatedAt = new Date().toISOString();
                  state[sid] = entry;
                  writeFileSync(stateTmp, JSON.stringify(state, null, 2), "utf-8");
                  renameSync(stateTmp, statePath);
                  const rounds = parseInt(process.env.ROLLING_SUMMARY_ROUNDS || "10", 10);
                  if (entry.roundCount > 0 && entry.roundCount % rounds === 0 && !entry.isSummarizing && !entry.summaryDisabled) {
                    logger.info(\`[Bot] Triggering summary cycle for \${sid} at round \${entry.roundCount}\`);
                    entry.isSummarizing = true;
                    state[sid] = entry;
                    writeFileSync(stateTmp, JSON.stringify(state, null, 2), "utf-8");
                    renameSync(stateTmp, statePath);
                    const addonDir = join(homedir(), "Library/Application Support/opencode-telegram-bot/addons");
                    const runnerPath = join(addonDir, "rolling-summary/cycle-runner.js");
                    const child = spawn(process.execPath, [runnerPath, sid], {
                      detached: true,
                      stdio: "ignore",
                      cwd: addonDir,
                    });
                    child.unref();
                  }
                }
              } catch (_) {}
              // @@end-rolling-summary
`;

function patchIndexFile() {
  const content = fs.readFileSync(INDEX_FILE, "utf-8");

  if (content.includes(INDEX_SENTINEL)) {
    console.log("[patch] index.js already patched, skipping");
    return true;
  }

  const anchorIdx = content.indexOf(INDEX_ANCHOR);
  if (anchorIdx === -1) {
    console.error("[patch] Anchor not found in index.js: " + INDEX_ANCHOR);
    return false;
  }

  // Find the end of the line and insert after it
  let nlIdx = content.indexOf("\n", anchorIdx);
  if (nlIdx === -1) {
    console.error("[patch] Could not find end of anchor line in index.js");
    return false;
  }
  const insertAt = nlIdx + 1;

  const newContent = content.slice(0, insertAt) + INDEX_INJECTION + content.slice(insertAt);
  fs.writeFileSync(INDEX_FILE, newContent, "utf-8");
  console.log("[patch] index.js patched successfully");
  return true;
}

function patchBotIndexImports() {
  let content = fs.readFileSync(INDEX_FILE, "utf-8");
  if (content.includes(PROACTIVE_RUNTIME_IMPORT)) {
    console.log("[patch] index.js proactive wakeup import already present, skipping");
    return true;
  }
  const importAnchor = 'import { scheduledTaskRuntime } from "../scheduled-task/runtime.js";';
  if (!content.includes(importAnchor)) {
    console.error("[patch] Import anchor not found in index.js: " + importAnchor);
    return false;
  }
  content = content.replace(importAnchor, `${importAnchor}\nimport { proactiveWakeupRuntime } from "../proactive-wakeup/runtime.js";`);
  fs.writeFileSync(INDEX_FILE, content, "utf-8");
  console.log("[patch] index.js proactive wakeup import patched successfully");
  return true;
}

function patchBotIndexTelegramTimeout() {
  let content = fs.readFileSync(INDEX_FILE, "utf-8");
  if (content.includes(BOT_INDEX_CLIENT_TIMEOUT_SENTINEL)) {
    console.log("[patch] index.js Telegram client timeout already patched, skipping");
    return true;
  }
  const botOptionsNeedle = "    const botOptions = {};";
  const botOptionsReplacement = `    const botOptions = {
        client: {
            timeoutSeconds: 45,
        },
    };`;
  if (!content.includes(botOptionsNeedle)) {
    console.error("[patch] Bot options anchor not found in index.js");
    return false;
  }
  content = content.replace(botOptionsNeedle, botOptionsReplacement);
  const proxyClientNeedle = "        botOptions.client = {\n            baseFetchConfig:";
  const proxyClientReplacement = "        botOptions.client = {\n            timeoutSeconds: 45,\n            baseFetchConfig:";
  if (!content.includes(proxyClientNeedle)) {
    console.error("[patch] Proxy bot client anchor not found in index.js");
    return false;
  }
  content = content.replace(proxyClientNeedle, proxyClientReplacement);
  fs.writeFileSync(INDEX_FILE, content, "utf-8");
  console.log("[patch] index.js Telegram client timeout patched successfully");
  return true;
}

function patchBotIndexSessionIdle() {
  let content = fs.readFileSync(INDEX_FILE, "utf-8");
  if (content.includes("// @@proactive-wakeup: idle decision")) {
    console.log("[patch] index.js proactive wakeup idle hook already present, skipping");
    return true;
  }
  const needle = `        finally {
            foregroundSessionState.markIdle(sessionId);
            await scheduledTaskRuntime.flushDeferredDeliveries();
        }
    });`;
  if (!content.includes(needle)) {
    console.error("[patch] Idle finally block not found in index.js");
    return false;
  }
  const injection = `
            // @@proactive-wakeup: idle decision
            try {
                const currentSessionForWakeups = getCurrentSession();
                if (currentSessionForWakeups && currentSessionForWakeups.id === sessionId) {
                    void proactiveWakeupRuntime.queueSessionIdleDecision(sessionId, currentSessionForWakeups.directory, {
                        agent: completedRun?.actualAgent || completedRun?.configuredAgent || null,
                        model: completedRun?.actualProviderID && completedRun?.actualModelID
                            ? {
                                providerID: completedRun.actualProviderID,
                                modelID: completedRun.actualModelID,
                            }
                            : (completedRun?.configuredProviderID && completedRun?.configuredModelID
                                ? {
                                    providerID: completedRun.configuredProviderID,
                                    modelID: completedRun.configuredModelID,
                                }
                                : null),
                        variant: completedRun?.actualVariant || completedRun?.configuredVariant || null,
                        summary: completedRun?.messageText || null,
                    });
                }
            } catch (_) {}
            // @@end-proactive-wakeup
`;
  content = content.replace(needle, `${needle}${injection}`);
  fs.writeFileSync(INDEX_FILE, content, "utf-8");
  console.log("[patch] index.js proactive wakeup idle hook patched successfully");
  return true;
}

function patchBotIndexWakeupControlBridge() {
  let content = fs.readFileSync(INDEX_FILE, "utf-8");
  let changed = false;

  if (!content.includes("proactiveWakeupRuntime.stripAssistantWakeupControls(messageText, { hideIncomplete: true })")) {
    const partialNeedle = "        const preparedStreamPayload = prepareStreamingPayload(messageText);";
    const partialReplacement = [
      "        const visibleMessageText = proactiveWakeupRuntime.stripAssistantWakeupControls(messageText, { hideIncomplete: true });",
      "        const preparedStreamPayload = prepareStreamingPayload(visibleMessageText);",
    ].join("\n");
    if (!content.includes(partialNeedle)) {
      console.error("[patch] Partial wakeup-control bridge anchor not found in index.js");
      return false;
    }
    content = content.replace(partialNeedle, partialReplacement);
    changed = true;
  }

  if (!content.includes("proactiveWakeupRuntime.consumeAssistantWakeupControls(sessionId, currentSession.directory, messageText, wakeupContext)")) {
    const completeNeedle = `            try {
                assistantRunState.markResponseCompleted(sessionId, {
                    agent: completionInfo.agent,
                    providerID: completionInfo.providerID,
                    modelID: completionInfo.modelID,
                });
                await finalizeAssistantResponse({
                    sessionId,
                    messageId,
                    messageText,`;
    const completeReplacement = `            try {
                const wakeupContext = {
                    agent: completionInfo.agent,
                    model: completionInfo.providerID && completionInfo.modelID
                        ? {
                            providerID: completionInfo.providerID,
                            modelID: completionInfo.modelID,
                        }
                        : null,
                    variant: completionInfo.variant || null,
                };
                const wakeupResult = await proactiveWakeupRuntime.consumeAssistantWakeupControls(sessionId, currentSession.directory, messageText, wakeupContext);
                const visibleMessageText = wakeupResult.visibleText || proactiveWakeupRuntime.stripAssistantWakeupControls(messageText);
                assistantRunState.markResponseCompleted(sessionId, {
                    agent: completionInfo.agent,
                    providerID: completionInfo.providerID,
                    modelID: completionInfo.modelID,
                    messageText: visibleMessageText,
                    scheduledWakeupCount: wakeupResult.scheduled.length,
                });
                await finalizeAssistantResponse({
                    sessionId,
                    messageId,
                    messageText: visibleMessageText,`;
    if (!content.includes(completeNeedle)) {
      console.error("[patch] Complete wakeup-control bridge anchor not found in index.js");
      return false;
    }
    content = content.replace(completeNeedle, completeReplacement);
    const ttsNeedle = "                    text: messageText,";
    if (!content.includes(ttsNeedle)) {
      console.error("[patch] TTS wakeup-control bridge anchor not found in index.js");
      return false;
    }
    content = content.replace(ttsNeedle, "                    text: visibleMessageText,");
    changed = true;
  }

  if (!content.includes("!completedRun?.scheduledWakeupCount")) {
    const idleNeedle = "                if (currentSessionForWakeups && currentSessionForWakeups.id === sessionId) {";
    const idleReplacement = "                if (currentSessionForWakeups && currentSessionForWakeups.id === sessionId && !completedRun?.scheduledWakeupCount) {";
    if (!content.includes(idleNeedle)) {
      console.error("[patch] Wakeup duplicate-skip anchor not found in index.js");
      return false;
    }
    content = content.replace(idleNeedle, idleReplacement);
    changed = true;
  }

  if (!content.includes("proactiveWakeupRuntime.flushDueWakeupsAfterIdle(sessionId);")) {
    const flushNeedle = "            await scheduledTaskRuntime.flushDeferredDeliveries();";
    if (!content.includes(flushNeedle)) {
      console.error("[patch] Wakeup idle flush anchor not found in index.js");
      return false;
    }
    content = content.replace(flushNeedle, `${flushNeedle}\n            proactiveWakeupRuntime.flushDueWakeupsAfterIdle(sessionId);`);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(INDEX_FILE, content, "utf-8");
    console.log("[patch] index.js wakeup-control bridge patched successfully");
  } else {
    console.log("[patch] index.js wakeup-control bridge already present, skipping");
  }
  return true;
}

function patchAssistantRunStateFile() {
  let content = fs.readFileSync(ASSISTANT_RUN_STATE_FILE, "utf-8");
  if (content.includes('typeof info?.messageText === "string"')) {
    console.log("[patch] assistant-run-state.js already patched, skipping");
    return true;
  }
  const anchor = `        if (info?.modelID) {
            run.actualModelID = info.modelID;
        }`;
  if (!content.includes(anchor)) {
    console.error("[patch] Assistant run state anchor not found");
    return false;
  }
  content = content.replace(anchor, `${anchor}
        if (typeof info?.messageText === "string") {
            run.messageText = info.messageText;
        }
        if (Number.isFinite(info?.scheduledWakeupCount)) {
            run.scheduledWakeupCount = info.scheduledWakeupCount;
        }`);
  fs.writeFileSync(ASSISTANT_RUN_STATE_FILE, content, "utf-8");
  console.log("[patch] assistant-run-state.js patched successfully");
  return true;
}

function patchBotCleanupShutdown() {
  let content = fs.readFileSync(INDEX_FILE, "utf-8");
  if (content.includes("proactiveWakeupRuntime.shutdown();")) {
    console.log("[patch] index.js proactive wakeup shutdown already present, skipping");
    return true;
  }
  const anchor = "scheduledTaskRuntime.shutdown();";
  if (!content.includes(anchor)) {
    console.error("[patch] Shutdown anchor not found in index.js: " + anchor);
    return false;
  }
  content = content.replace(anchor, `${anchor}\n    proactiveWakeupRuntime.shutdown();`);
  fs.writeFileSync(INDEX_FILE, content, "utf-8");
  console.log("[patch] index.js proactive wakeup shutdown patched successfully");
  return true;
}

function patchStartBotAppFile() {
  let content = fs.readFileSync(START_BOT_APP_FILE, "utf-8");
  if (content.includes("// @@proactive-wakeup-startup-hook")) {
    console.log("[patch] start-bot-app.js already patched, skipping");
    return true;
  }
  const importAnchor = 'import { scheduledTaskRuntime } from "../scheduled-task/runtime.js";';
  if (!content.includes(importAnchor)) {
    console.error("[patch] Import anchor not found in start-bot-app.js: " + importAnchor);
    return false;
  }
  if (!content.includes('import { proactiveWakeupRuntime } from "../proactive-wakeup/runtime.js";')) {
    content = content.replace(importAnchor, `${importAnchor}\nimport { proactiveWakeupRuntime } from "../proactive-wakeup/runtime.js";`);
  }
  const initAnchor = "await scheduledTaskRuntime.initialize(bot);";
  if (!content.includes(initAnchor)) {
    console.error("[patch] Init anchor not found in start-bot-app.js: " + initAnchor);
    return false;
  }
  if (!content.includes("await proactiveWakeupRuntime.initialize(bot.api, config.telegram.allowedUserId);")) {
    content = content.replace(initAnchor, `${initAnchor}\n    await proactiveWakeupRuntime.initialize(bot.api, config.telegram.allowedUserId);`);
  }
  const shutdownAnchor = "scheduledTaskRuntime.shutdown();";
  if (!content.includes(shutdownAnchor)) {
    console.error("[patch] Shutdown anchor not found in start-bot-app.js: " + shutdownAnchor);
    return false;
  }
  if (!content.includes("proactiveWakeupRuntime.shutdown();")) {
    content = content.split(shutdownAnchor).join(`${shutdownAnchor}\n        proactiveWakeupRuntime.shutdown();`);
  }
  content = `// @@proactive-wakeup-startup-hook\n${content}`;
  fs.writeFileSync(START_BOT_APP_FILE, content, "utf-8");
  console.log("[patch] start-bot-app.js proactive wakeup patched successfully");
  return true;
}

function patchStartBotAppWebhookPreflight() {
  let content = fs.readFileSync(START_BOT_APP_FILE, "utf-8");
  let changed = false;
  if (!content.includes("Could not check Telegram webhook before polling; continuing startup")) {
    if (!content.includes(START_BOT_WEBHOOK_OLD)) {
      console.error("[patch] start-bot-app.js webhook preflight anchor not found");
      return false;
    }
    content = content.replace(START_BOT_WEBHOOK_OLD, START_BOT_WEBHOOK_NEW);
    changed = true;
  }
  if (!content.includes("TELEGRAM_START_RETRY_MS")) {
    if (!content.includes(START_BOT_RETRY_CONST_OLD)) {
      console.error("[patch] start-bot-app.js retry const anchor not found");
      return false;
    }
    content = content.replace(START_BOT_RETRY_CONST_OLD, START_BOT_RETRY_CONST_NEW);
    changed = true;
  }
  if (!content.includes("Promise.resolve(bot.stop()).catch")) {
    if (!content.includes(START_BOT_STOP_OLD)) {
      console.error("[patch] start-bot-app.js bot.stop anchor not found");
      return false;
    }
    content = content.replace(START_BOT_STOP_OLD, START_BOT_STOP_NEW);
    changed = true;
  }
  if (!content.includes("Telegram polling failed; retrying")) {
    if (!content.includes(START_BOT_START_OLD)) {
      console.error("[patch] start-bot-app.js bot.start anchor not found");
      return false;
    }
    content = content.replace(START_BOT_START_OLD, START_BOT_START_NEW);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(START_BOT_APP_FILE, content, "utf-8");
    console.log("[patch] start-bot-app.js Telegram startup resilience patched successfully");
  } else {
    console.log("[patch] start-bot-app.js Telegram startup resilience already patched, skipping");
  }
  return true;
}

// ---- keyboard.js patch ----
const KEYBOARD_FILE = path.join(BOT_DIST, "bot/utils/keyboard.js");
const KEYBOARD_SENTINEL = "function withCompactLabel";
const KEYBOARD_HELPER_ANCHOR = "function formatContextForButton(contextInfo) {";
const KEYBOARD_CONTEXT_RETURN = '    return t("keyboard.context", { used, limit, percent });';
const KEYBOARD_CONTEXT_REPLACEMENT = '    return withCompactLabel(t("keyboard.context", { used, limit, percent }));';
const KEYBOARD_EMPTY_RETURN = ': t("keyboard.context_empty");';
const KEYBOARD_EMPTY_REPLACEMENT = ': withCompactLabel(t("keyboard.context_empty"));';
const KEYBOARD_HELPER = `function withCompactLabel(text) {
    return text.replace(/^📊\\s*/, "📊 Compact ");
}
`;

function patchKeyboardFile() {
  let content = fs.readFileSync(KEYBOARD_FILE, "utf-8");

  if (content.includes(KEYBOARD_SENTINEL)) {
    console.log("[patch] keyboard.js already patched, skipping");
    return true;
  }

  const helperIdx = content.indexOf(KEYBOARD_HELPER_ANCHOR);
  if (helperIdx === -1) {
    console.error("[patch] Anchor not found in keyboard.js: " + KEYBOARD_HELPER_ANCHOR);
    return false;
  }

  content = content.slice(0, helperIdx) + KEYBOARD_HELPER + content.slice(helperIdx);

  if (!content.includes(KEYBOARD_CONTEXT_RETURN)) {
    console.error("[patch] Context return not found in keyboard.js");
    return false;
  }
  content = content.replace(KEYBOARD_CONTEXT_RETURN, KEYBOARD_CONTEXT_REPLACEMENT);

  if (!content.includes(KEYBOARD_EMPTY_RETURN)) {
    console.error("[patch] Empty context return not found in keyboard.js");
    return false;
  }
  content = content.replace(KEYBOARD_EMPTY_RETURN, KEYBOARD_EMPTY_REPLACEMENT);

  fs.writeFileSync(KEYBOARD_FILE, content, "utf-8");
  console.log("[patch] keyboard.js patched successfully");
  return true;
}

// ---- pinned/manager.js patch ----
const PINNED_MANAGER_FILE = path.join(BOT_DIST, "pinned/manager.js");
const PINNED_CONTEXT_SENTINEL = "// @@compact-context-stat";
const PINNED_CONTEXT_BLOCK_START = "            // Get the maximum context size and total cost from session history";
const PINNED_CONTEXT_BLOCK_END = "            this.state.tokensUsed = maxContextSize;";
const PINNED_CONTEXT_REPLACEMENT = [
  "            // @@compact-context-stat: ignore pre-compaction context peaks",
  "            // Context = input + cache.read (cache.read contains previously cached context)",
  "            const latestCompactionIndex = messagesData.reduce((latestIndex, message, index) => {",
  "                const parts = Array.isArray(message.parts) ? message.parts : [];",
  "                const isUserCompaction = message.info?.role === \"user\" && parts.some((part) => part?.type === \"compaction\");",
  "                return isUserCompaction ? index : latestIndex;",
  "            }, -1);",
  "            const contextMessages = latestCompactionIndex >= 0",
  "                ? messagesData.slice(latestCompactionIndex + 1)",
  "                : messagesData;",
  "            let maxContextSize = 0;",
  "            let totalCost = 0;",
  "            logger.debug(`[PinnedManager] Processing ${messagesData.length} messages from history`);",
  "            messagesData.forEach(({ info }) => {",
  "                if (info.role !== \"assistant\") {",
  "                    return;",
  "                }",
  "                const assistantInfo = info;",
  "                if (assistantInfo.summary) {",
  "                    logger.debug(`[PinnedManager] Skipping summary message`);",
  "                    return;",
  "                }",
  "                totalCost += assistantInfo.cost || 0;",
  "            });",
  "            contextMessages.forEach(({ info }) => {",
  "                if (info.role !== \"assistant\") {",
  "                    return;",
  "                }",
  "                const assistantInfo = info;",
  "                if (assistantInfo.summary) {",
  "                    logger.debug(`[PinnedManager] Skipping summary message for context`);",
  "                    return;",
  "                }",
  "                const input = assistantInfo.tokens?.input || 0;",
  "                const cacheRead = assistantInfo.tokens?.cache?.read || 0;",
  "                const contextSize = input + cacheRead;",
  "                logger.debug(`[PinnedManager] Assistant message: input=${input}, cache.read=${cacheRead}, total=${contextSize}`);",
  "                if (contextSize > maxContextSize) {",
  "                    maxContextSize = contextSize;",
  "                }",
  "            });",
  "            // @@end-compact-context-stat",
  "",
].join("\n");

function patchPinnedManagerFile() {
  const content = fs.readFileSync(PINNED_MANAGER_FILE, "utf-8");

  if (content.includes(PINNED_CONTEXT_SENTINEL)) {
    console.log("[patch] pinned/manager.js already patched, skipping");
    return true;
  }

  const startIdx = content.indexOf(PINNED_CONTEXT_BLOCK_START);
  if (startIdx === -1) {
    console.error("[patch] Context block start not found in pinned/manager.js");
    return false;
  }

  const endIdx = content.indexOf(PINNED_CONTEXT_BLOCK_END, startIdx);
  if (endIdx === -1) {
    console.error("[patch] Context block end not found in pinned/manager.js");
    return false;
  }

  const newContent =
    content.slice(0, startIdx) +
    PINNED_CONTEXT_REPLACEMENT +
    content.slice(endIdx);
  fs.writeFileSync(PINNED_MANAGER_FILE, newContent, "utf-8");
  console.log("[patch] pinned/manager.js patched successfully");
  return true;
}

// ---- Main ----
function main() {
  // Check bot package version
  let pkgPath = path.join(BOT_DIST, "../package.json");
  if (!fs.existsSync(pkgPath)) {
    pkgPath = path.join(BOT_DIST, "../../package.json");
  }

  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    console.log(`[patch] Bot version: ${pkg.version}`);
  }

  // Verify dist files exist
  if (!fs.existsSync(PROMPT_FILE)) {
    console.error("[patch] prompt.js not found at: " + PROMPT_FILE);
    process.exit(1);
  }
  if (!fs.existsSync(INDEX_FILE)) {
    console.error("[patch] index.js not found at: " + INDEX_FILE);
    process.exit(1);
  }
  if (!fs.existsSync(ASSISTANT_RUN_STATE_FILE)) {
    console.error("[patch] assistant-run-state.js not found at: " + ASSISTANT_RUN_STATE_FILE);
    process.exit(1);
  }
  if (!fs.existsSync(KEYBOARD_FILE)) {
    console.error("[patch] keyboard.js not found at: " + KEYBOARD_FILE);
    process.exit(1);
  }
  if (!fs.existsSync(PINNED_MANAGER_FILE)) {
    console.error("[patch] pinned/manager.js not found at: " + PINNED_MANAGER_FILE);
    process.exit(1);
  }

  const promptOk = patchPromptFile();
  const indexOk = patchIndexFile();
  const indexImportOk = patchBotIndexImports();
  const indexTelegramTimeoutOk = patchBotIndexTelegramTimeout();
  const indexIdleOk = patchBotIndexSessionIdle();
  const indexWakeupControlOk = patchBotIndexWakeupControlBridge();
  const indexShutdownOk = patchBotCleanupShutdown();
  const assistantRunStateOk = patchAssistantRunStateFile();
  const startBotAppOk = patchStartBotAppFile();
  const startBotWebhookOk = patchStartBotAppWebhookPreflight();
  const keyboardOk = patchKeyboardFile();
  const pinnedManagerOk = patchPinnedManagerFile();

  if (promptOk && indexOk && indexImportOk && indexTelegramTimeoutOk && indexIdleOk && indexWakeupControlOk && indexShutdownOk && assistantRunStateOk && startBotAppOk && startBotWebhookOk && keyboardOk && pinnedManagerOk) {
    console.log("[patch] All patches applied successfully");
    process.exit(0);
  } else {
    console.error("[patch] Some patches failed");
    process.exit(1);
  }
}

main();
