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

function patchPromptFile() {
  let content = fs.readFileSync(PROMPT_FILE, "utf-8");

  if (content.includes(PROMPT_SENTINEL)) {
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
    const newContent = content.slice(0, legacyIdx) + PROMPT_INJECTION + content.slice(endIdx);
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

  const newContent = content.slice(0, insertAt) + PROMPT_INJECTION + content.slice(insertAt);
  fs.writeFileSync(PROMPT_FILE, newContent, "utf-8");
  console.log("[patch] prompt.js patched successfully");
  return true;
}

// ---- bot/index.js patch ----
const INDEX_FILE = path.join(BOT_DIST, "bot/index.js");
const INDEX_SENTINEL = "// @@rolling-summary";
const INDEX_ANCHOR = "await pinnedMessageManager.onMessageComplete(tokens);";
const INDEX_AFTER = "            }\n";
const ADDN_DIR = path.join(
  require("os").homedir(),
  "Library/Application Support/opencode-telegram-bot/addons"
);
const CYCLE_RUNNER = path.join(ADDN_DIR, "rolling-summary/cycle-runner.js");

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
  const keyboardOk = patchKeyboardFile();
  const pinnedManagerOk = patchPinnedManagerFile();

  if (promptOk && indexOk && keyboardOk && pinnedManagerOk) {
    console.log("[patch] All patches applied successfully");
    process.exit(0);
  } else {
    console.error("[patch] Some patches failed");
    process.exit(1);
  }
}

main();
