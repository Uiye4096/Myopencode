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
const PROMPT_SENTINEL = "// @@rolling-summary";
const PROMPT_ANCHOR = "promptOptions.variant = storedModel.variant;";
const PROMPT_CLOSE_LINE = "        }\n";
const PROMPT_INJECTION = `
        // @@rolling-summary: inject system context
        try {
          const { readFile } = await import("fs/promises");
          const { join } = await import("path");
          const { homedir } = await import("os");
          const appHome = join(homedir(), "Library/Application Support/opencode-telegram-bot");
          const statePath = join(appHome, "rolling-summary-state.json");
          const ltmPath = join(appHome, "long-term-memory.json");
          const state = JSON.parse(await readFile(statePath, "utf-8"));
          const entry = state[currentSession.id];
          const parts = [promptOptions.system];
          // long-term memory (cross-session, always injected)
          try {
            const ltm = JSON.parse(await readFile(ltmPath, "utf-8"));
            if (ltm.memories) parts.push(ltm.memories);
          } catch (_) {}
          // rolling summary (session-level)
          if (entry && entry.summary && !entry.summaryDisabled) {
            parts.push(entry.summary);
          }
          promptOptions.system = parts.filter(Boolean).join("\\n\\n");
        } catch (_) {}
        // @@end-rolling-summary`;

function patchPromptFile() {
  const content = fs.readFileSync(PROMPT_FILE, "utf-8");

  if (content.includes(PROMPT_SENTINEL)) {
    console.log("[patch] prompt.js already patched, skipping");
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

  const promptOk = patchPromptFile();
  const indexOk = patchIndexFile();

  if (promptOk && indexOk) {
    console.log("[patch] All patches applied successfully");
    process.exit(0);
  } else {
    console.error("[patch] Some patches failed");
    process.exit(1);
  }
}

main();
