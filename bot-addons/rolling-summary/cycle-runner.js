"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const config = require("../config.js");
const store = require("./store.js");
const { generateSummary } = require("./generator.js");

const SUMMARY_ROUNDS = config.ROLLING_SUMMARY_ROUNDS;
const MAX_DIFF_TOKENS = config.MAX_DIFF_TOKENS;

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("[rolling-summary] sessionId argument required");
  process.exit(1);
}

/**
 * Fetch recent messages from OpenCode API
 */
function fetchMessages(sessionId, limit) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:4096/session/${sessionId}/message?limit=${limit}&order=desc`;
    const client = http;

  client.get(url, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    res.on("end", () => {
      const data = Buffer.concat(chunks).toString("utf8");
      if (res.statusCode >= 400) {
        reject(new Error(`OpenCode API error ${res.statusCode}: ${data.slice(0, 300)}`));
        return;
      }
      try {
        const result = JSON.parse(data);
        const messages = result.data || result.messages || result || [];
        resolve(Array.isArray(messages) ? messages : []);
      } catch (e) {
        reject(new Error("Failed to parse OpenCode response: " + e.message));
      }
    });
  }).on("error", (e) => reject(new Error("OpenCode API error: " + e.message)));
  });
}

/**
 * Format messages into a readable text diff.
 */
function formatMessageDiff(messages, maxTokens) {
  const parts = [];
  let totalChars = 0;
  const charLimit = maxTokens * 2;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    let role = "unknown";
    let text = "";

    if (msg.info) {
      role = msg.info.role || "unknown";
      if (msg.info.summary) continue;
    } else {
      role = msg.role || "unknown";
    }

    if (msg.parts) {
      const textParts = [];
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          textParts.push(part.text);
        } else if (part.type === "tool" && part.state) {
          const toolName = part.tool || "tool";
          const status = part.state.status || "unknown";
          const output = part.state.output || "";
          textParts.push(`[Tool:${toolName}](${status}): ${output.slice(0, 300)}`);
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

(async () => {
  console.log(`[rolling-summary] Cycle started for session ${sessionId}`);

  if (!config.ROLLING_SUMMARY_ENABLED) {
    console.log("[rolling-summary] Disabled, exiting");
    process.exit(0);
  }

  if (!config.DEEPSEEK_API_KEY) {
    console.error("[rolling-summary] DEEPSEEK_API_KEY not configured");
    process.exit(1);
  }

  if (store.isLocked(sessionId)) {
    console.log("[rolling-summary] Already in progress, exiting");
    process.exit(0);
  }

  store.lock(sessionId);

  try {
    const entry = store.get(sessionId);
    const version = (entry && entry.version) || 0;
    const skippedCycles = (entry && entry.skippedCycles) || 0;
    const summaryFailures = (entry && entry.summaryFailures) || 0;

    console.log(`[rolling-summary] version=${version}, skipped=${skippedCycles}, failures=${summaryFailures}`);

    let useRegeneration = version >= config.REGENERATION_VERSION;
    let roundsToFetch = config.ROLLING_SUMMARY_ROUNDS + skippedCycles * config.ROLLING_SUMMARY_ROUNDS;
    if (useRegeneration) {
      roundsToFetch = config.REGENERATION_ROUNDS + skippedCycles * config.ROLLING_SUMMARY_ROUNDS;
      console.log("[rolling-summary] Regeneration mode (version >= " + config.REGENERATION_VERSION + ")");
    }

    // Fetch messages
    const msgLimit = roundsToFetch * 3 + 10;
    let messages;
    try {
      messages = await fetchMessages(sessionId, msgLimit);
    } catch (e) {
      console.error("[rolling-summary] Failed to fetch messages:", e.message);
      store.unlock(sessionId);
      process.exit(1);
    }

    if (!messages || messages.length === 0) {
      console.log("[rolling-summary] No messages, skipping");
      store.unlock(sessionId);
      process.exit(0);
    }

    console.log(`[rolling-summary] Fetched ${messages.length} messages`);

    // Format diff
    const diffResult = formatMessageDiff(messages, MAX_DIFF_TOKENS);
    if (diffResult.truncated) {
      console.log("[rolling-summary] Diff truncated (token limit)");
    }

    if (!diffResult.text.trim()) {
      console.log("[rolling-summary] Empty diff, skipping");
      store.unlock(sessionId);
      process.exit(0);
    }

    // Generate summary
    const previousSummary = useRegeneration ? null : (entry && entry.summary) || null;
    let newSummary;
    try {
      newSummary = await generateSummary(previousSummary, diffResult.text);
    } catch (e) {
      console.error("[rolling-summary] Generation failed:", e.message);
      const newFailures = summaryFailures + 1;
      store.set(sessionId, {
        summaryFailures: newFailures,
        skippedCycles: (entry && entry.skippedCycles || 0) + 1,
      });
      store.unlock(sessionId);

      if (newFailures >= 3) {
        console.error("[rolling-summary] 3 consecutive failures, disabling");
        store.set(sessionId, { summaryDisabled: true, summaryFailures: newFailures });
      }
      process.exit(1);
    }

    if (!newSummary) {
      console.log("[rolling-summary] Empty summary returned");
      store.unlock(sessionId);
      process.exit(0);
    }

    // Store
    const newVersion = useRegeneration ? config.REGENERATION_VERSION + 1 : version + 1;
    store.set(sessionId, {
      summary: newSummary,
      version: newVersion,
      lastCompactedRound: entry.roundCount || 0,
      summaryFailures: 0,
      skippedCycles: 0,
      compactedAt: new Date().toISOString(),
    });

    console.log(`[rolling-summary] Complete: version ${newVersion}, ${newSummary.length} chars`);

    // Extract long-term memories every 3 summary versions
    if (newVersion > 0 && newVersion % 3 === 0) {
      try {
        console.log("[rolling-summary] Extracting long-term memories...");
        const { extractMemories } = require("./memory-extractor.js");
        const existingLTM = store.getLongTermMemory();
        const result = await extractMemories(newSummary, existingLTM);
        if (result.hasNew) {
          store.setLongTermMemory(result.memories);
          console.log(`[rolling-summary] Long-term memory updated (${result.memories.length} chars)`);
        } else {
          console.log("[rolling-summary] No new memories to extract");
        }
      } catch (e) {
        console.error("[rolling-summary] Memory extraction failed:", e.message);
      }
    }

    store.unlock(sessionId);
    process.exit(0);
  } catch (e) {
    console.error("[rolling-summary] Unexpected error:", e.message);
    store.unlock(sessionId);
    process.exit(1);
  }
})();
