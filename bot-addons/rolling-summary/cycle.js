"use strict";

const store = require("./store.js");
const { generateSummary } = require("./generator.js");
const config = require("../config.js");

/**
 * Estimate token count from text (rough: 1 token ~ 4 chars for Chinese, ~1 for English).
 * Conservative estimate: 1 token ~ 2 chars.
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 2);
}

/**
 * Format messages into a readable text diff for the summary model.
 * @param {Array} messages - raw messages from OpenCode API
 * @returns {{ text: string, truncated: boolean }}
 */
function formatMessageDiff(messages, maxTokens) {
  const parts = [];
  let totalChars = 0;
  const charLimit = maxTokens * 2;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    let role = msg.role || (msg.info && msg.info.role) || "unknown";
    let text = "";

    if (msg.info && msg.info.summary) {
      // Skip compaction summary artifacts
      continue;
    }

    if (msg.parts) {
      const textParts = [];
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          textParts.push(part.text);
        } else if (part.type === "tool" && part.state) {
          const toolName = part.tool || "tool";
          const title = part.state.title || "";
          const output = part.state.output || "";
          const status = part.state.status || "unknown";
          textParts.push(`[Tool: ${toolName}] ${title} (${status}): ${output.slice(0, 200)}`);
        }
      }
      text = textParts.join("\n");
    } else if (msg.content) {
      text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    }

    if (!text.trim()) continue;

    const line = `[${role.toUpperCase()}]: ${text.trim()}\n`;
    if (totalChars + line.length > charLimit) {
      parts.unshift("...(earlier messages truncated)...\n");
      return { text: parts.join("\n"), truncated: true };
    }
    parts.unshift(line);
    totalChars += line.length;
  }

  return { text: parts.join("\n"), truncated: false };
}

/**
 * Execute a rolling summary cycle for a session.
 * Callers: this MUST be the implementor's responsibility to use opcodeclient.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {Function} params.fetchMessages - (sessionId, limit) => Promise<Array>
 * @param {object} params.logger - { info, error, warn }
 * @returns {Promise<void>}
 */
async function runSummaryCycle({ sessionId, fetchMessages, logger }) {
  if (!config.ROLLING_SUMMARY_ENABLED) {
    logger.info("[rolling-summary] Disabled, skipping cycle");
    return;
  }

  if (!config.DEEPSEEK_API_KEY) {
    logger.error("[rolling-summary] DEEPSEEK_API_KEY not configured, skipping");
    return;
  }

  // Check lock
  if (store.isLocked(sessionId)) {
    logger.info("[rolling-summary] Cycle already in progress for session, skipping");
    const entry = store.get(sessionId);
    store.set(sessionId, { skippedCycles: (entry.skippedCycles || 0) + 1 });
    return;
  }

  store.lock(sessionId);

  try {
    const entry = store.get(sessionId);
    const previousSummary = entry && entry.summary ? entry.summary : null;
    const version = (entry && entry.version) || 0;
    const skippedCycles = (entry && entry.skippedCycles) || 0;
    const summaryFailures = (entry && entry.summaryFailures) || 0;

    logger.info(`[rolling-summary] Starting cycle for ${sessionId} (version ${version}, skipped ${skippedCycles})`);

    // Determine how many rounds to fetch
    let roundsToFetch;
    let useRegeneration = false;

    if (version >= config.REGENERATION_VERSION) {
      // Regenerate from actual messages, not from old summary chain
      roundsToFetch = config.REGENERATION_ROUNDS + skippedCycles * config.ROLLING_SUMMARY_ROUNDS;
      useRegeneration = true;
      logger.info("[rolling-summary] Regeneration mode (version >= " + config.REGENERATION_VERSION + ")");
    } else {
      roundsToFetch = config.ROLLING_SUMMARY_ROUNDS + skippedCycles * config.ROLLING_SUMMARY_ROUNDS;
    }

    // Fetch recent messages
    let messages;
    try {
      messages = await fetchMessages(sessionId, roundsToFetch * 2 + 10); // fetch more than needed (each round ~2 messages)
    } catch (e) {
      logger.error("[rolling-summary] Failed to fetch messages:", e.message);
      store.unlock(sessionId);
      return;
    }

    if (!messages || messages.length === 0) {
      logger.warn("[rolling-summary] No messages fetched, skipping cycle");
      store.unlock(sessionId);
      return;
    }

    // Format messages as diff
    const diffResult = formatMessageDiff(messages, config.MAX_DIFF_TOKENS);
    if (diffResult.truncated) {
      logger.warn("[rolling-summary] Diff exceeded token limit, truncated");
    }

    if (!diffResult.text.trim()) {
      logger.warn("[rolling-summary] Empty diff after formatting, skipping");
      store.unlock(sessionId);
      return;
    }

    // Generate summary
    const effectivePrevious = useRegeneration ? null : previousSummary;
    let newSummary;
    try {
      newSummary = await generateSummary(effectivePrevious, diffResult.text);
    } catch (e) {
      logger.error("[rolling-summary] Summary generation failed:", e.message);
      const newFailures = summaryFailures + 1;
      store.set(sessionId, {
        summaryFailures: newFailures,
        skippedCycles: (entry.skippedCycles || 0) + 1,
      });
      store.unlock(sessionId);

      if (newFailures >= 3) {
        logger.error("[rolling-summary] 3 consecutive failures, disabling summary for this session");
        store.set(sessionId, { summaryDisabled: true, summaryFailures: newFailures });
      }
      return;
    }

    if (!newSummary) {
      logger.warn("[rolling-summary] Empty summary returned");
      store.unlock(sessionId);
      return;
    }

    // Store new summary
    const newVersion = useRegeneration ? config.REGENERATION_VERSION : version + 1;
    store.set(sessionId, {
      summary: newSummary,
      version: newVersion,
      lastCompactedRound: entry.roundCount || 0,
      summaryFailures: 0,
      skippedCycles: 0,
      compactedAt: new Date().toISOString(),
    });

    logger.info(`[rolling-summary] Cycle complete for ${sessionId}: version ${newVersion}, ${newSummary.length} chars`);
  } catch (e) {
    logger.error("[rolling-summary] Unexpected error in cycle:", e.message);
  } finally {
    store.unlock(sessionId);
  }
}

module.exports = { runSummaryCycle, estimateTokens, formatMessageDiff };
