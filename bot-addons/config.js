"use strict";

const fs = require("fs");
const path = require("path");

const APP_HOME = path.dirname(__dirname);
const ENV_FILE = path.join(APP_HOME, ".env");

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

const env = parseEnv(ENV_FILE);

module.exports = {
  APP_HOME,
  ENV_FILE,

  DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY || "",
  DEEPSEEK_API_URL: "https://api.deepseek.com",

  ROLLING_SUMMARY_ENABLED: env.ROLLING_SUMMARY_ENABLED !== "false",
  ROLLING_SUMMARY_ROUNDS: parseInt(env.ROLLING_SUMMARY_ROUNDS || "10", 10) || 10,
  ROLLING_SUMMARY_MODEL: env.ROLLING_SUMMARY_MODEL || "deepseek-chat",

  MAX_DIFF_TOKENS: 40000,
  SUMMARY_MAX_CHARS: 800,

  REGENERATION_VERSION: 5,
  REGENERATION_ROUNDS: 20,

  MAX_RETRIES: 3,
  RETRY_BACKOFF_MS: [1000, 2000, 4000],

  INACTIVITY_MINUTES: parseInt(env.ROLLING_SUMMARY_INACTIVITY_MINUTES || "30", 10) || 30,
};
