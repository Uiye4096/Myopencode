"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config.js");

const STATE_FILE = path.join(config.APP_HOME, "rolling-summary-state.json");
const STATE_FILE_TMP = STATE_FILE + ".tmp";

let cache = null;
let cacheMtime = 0;

function readState() {
  try {
    const stat = fs.statSync(STATE_FILE);
    if (stat.mtimeMs === cacheMtime && cache !== null) return cache;
    cacheMtime = stat.mtimeMs;
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    cache = JSON.parse(raw);
    return cache;
  } catch (e) {
    if (e.code === "ENOENT") {
      cache = {};
      cacheMtime = 0;
      return cache;
    }
    console.error("[rolling-summary] Failed to read state file, resetting:", e.message);
    cache = {};
    cacheMtime = 0;
    return cache;
  }
}

function writeState(state) {
  try {
    const json = JSON.stringify(state, null, 2);
    fs.writeFileSync(STATE_FILE_TMP, json, "utf-8");
    fs.renameSync(STATE_FILE_TMP, STATE_FILE);
    cache = state;
    cacheMtime = fs.statSync(STATE_FILE).mtimeMs;
  } catch (e) {
    console.error("[rolling-summary] Failed to write state file:", e.message);
  }
}

/** Get summary entry for a sessionId */
function get(sessionId) {
  const state = readState();
  return state[sessionId] || null;
}

/** Set summary entry for a sessionId (full overwrite — use merge for partial) */
function set(sessionId, data) {
  const state = readState();
  state[sessionId] = Object.assign({}, state[sessionId] || {}, data, {
    updatedAt: new Date().toISOString(),
  });
  writeState(state);
}

/** Merge fields into existing entry (preserves fields not mentioned) */
function merge(sessionId, fields) {
  const state = readState();
  const existing = state[sessionId] || {};
  state[sessionId] = Object.assign({}, existing, fields, {
    updatedAt: new Date().toISOString(),
  });
  writeState(state);
}

/** Delete summary entry for a sessionId */
function remove(sessionId) {
  const state = readState();
  delete state[sessionId];
  writeState(state);
}

/** Increment round counter, return new count */
function incrementRound(sessionId) {
  const state = readState();
  const entry = state[sessionId] || {};
  const count = (entry.roundCount || 0) + 1;
  entry.roundCount = count;
  entry.updatedAt = new Date().toISOString();
  state[sessionId] = entry;
  writeState(state);
  return count;
}

/** Set isSummarizing flag */
function lock(sessionId) {
  set(sessionId, { isSummarizing: true });
}

/** Clear isSummarizing flag */
function unlock(sessionId) {
  set(sessionId, { isSummarizing: false });
}

/** Check if summarizing in progress */
function isLocked(sessionId) {
  const entry = get(sessionId);
  if (!entry || !entry.isSummarizing) return false;
  // Auto-expire stale locks (> 5 min)
  const lockAge = Date.now() - new Date(entry.updatedAt).getTime();
  if (lockAge > 5 * 60 * 1000) {
    console.log("[rolling-summary] Expiring stale lock for session:", sessionId);
    unlock(sessionId);
    return false;
  }
  return true;
}

/** Compact stale entries (inactive > INACTIVITY_MINUTES) */
function compactStale() {
  const state = readState();
  const now = Date.now();
  const threshold = config.INACTIVITY_MINUTES * 60 * 1000;
  let changed = false;
  for (const key of Object.keys(state)) {
    const entry = state[key];
    const updatedAt = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
    if (now - updatedAt > threshold) {
      delete state[key];
      changed = true;
      console.log("[rolling-summary] Auto-cleaned stale session:", key);
    }
  }
  if (changed) writeState(state);
}

// ---- long-term memory (cross-session, persistent) ----
const LTM_FILE = path.join(config.APP_HOME, "long-term-memory.json");
const LTM_FILE_TMP = LTM_FILE + ".tmp";

function getLongTermMemory() {
  try {
    const raw = fs.readFileSync(LTM_FILE, "utf-8");
    return JSON.parse(raw).memories || "";
  } catch (e) {
    if (e.code === "ENOENT") return "";
    console.error("[rolling-summary] Failed to read long-term memory:", e.message);
    return "";
  }
}

function setLongTermMemory(memories) {
  try {
    const json = JSON.stringify({ memories, updatedAt: new Date().toISOString() }, null, 2);
    fs.writeFileSync(LTM_FILE_TMP, json, "utf-8");
    fs.renameSync(LTM_FILE_TMP, LTM_FILE);
  } catch (e) {
    console.error("[rolling-summary] Failed to write long-term memory:", e.message);
  }
}

module.exports = {
  get,
  set,
  merge,
  remove,
  incrementRound,
  lock,
  unlock,
  isLocked,
  compactStale,
  getLongTermMemory,
  setLongTermMemory,
};
