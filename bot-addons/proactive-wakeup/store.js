import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getRuntimePaths } from "../runtime/paths.js";

export const STATE_FILE = path.join(getRuntimePaths().appHome, "proactive-wakeup-state.json");
const STATE_FILE_TMP = `${STATE_FILE}.tmp`;

let cache = null;
let cacheMtime = 0;
let writeQueue = Promise.resolve();

function readState() {
  try {
    const stat = fs.statSync(STATE_FILE);
    if (stat.mtimeMs === cacheMtime && cache !== null) {
      return cache;
    }
    cacheMtime = stat.mtimeMs;
    cache = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return cache;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("[proactive-wakeup] Failed to read state file, resetting:", error.message);
    }
    cache = {};
    cacheMtime = 0;
    return cache;
  }
}

function writeState(state) {
  const json = JSON.stringify(state, null, 2);
  fs.writeFileSync(STATE_FILE_TMP, json, "utf-8");
  fs.renameSync(STATE_FILE_TMP, STATE_FILE);
  cache = state;
  cacheMtime = fs.statSync(STATE_FILE).mtimeMs;
}

function mutate(mutator) {
  const runMutation = async () => {
    const state = readState();
    const result = await mutator(state);
    writeState(state);
    return result;
  };
  const next = writeQueue.then(runMutation, runMutation);
  writeQueue = next.catch(() => undefined);
  return next;
}

function normalizeSessionEntry(entry) {
  const next = entry && typeof entry === "object" ? { ...entry } : {};
  next.pendingWakeups = Array.isArray(next.pendingWakeups) ? next.pendingWakeups : [];
  next.sentMessages = Array.isArray(next.sentMessages) ? next.sentMessages : [];
  return next;
}

export function getSessionEntry(sessionId) {
  const state = readState();
  return normalizeSessionEntry(state[sessionId]);
}

export function listAllSessions() {
  const state = readState();
  return Object.fromEntries(
    Object.entries(state).map(([sessionId, entry]) => [sessionId, normalizeSessionEntry(entry)])
  );
}

export function setSessionEntry(sessionId, entry) {
  return mutate((state) => {
    state[sessionId] = normalizeSessionEntry({
      ...(state[sessionId] || {}),
      ...entry,
      updatedAt: new Date().toISOString(),
    });
  });
}

export function mergeSessionEntry(sessionId, fields) {
  return mutate((state) => {
    state[sessionId] = normalizeSessionEntry({
      ...(state[sessionId] || {}),
      ...fields,
      updatedAt: new Date().toISOString(),
    });
  });
}

export function removeSessionEntry(sessionId) {
  return mutate((state) => {
    delete state[sessionId];
  });
}

export function listPendingWakeups(sessionId) {
  return getSessionEntry(sessionId).pendingWakeups;
}

export function upsertWakeup(sessionId, wakeup) {
  return mutate((state) => {
    const entry = normalizeSessionEntry(state[sessionId]);
    const existingIndex = entry.pendingWakeups.findIndex((item) => item.id === wakeup.id);
    const nextWakeup = {
      ...wakeup,
      status: wakeup.status || "pending",
      createdAt: wakeup.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (existingIndex >= 0) {
      entry.pendingWakeups[existingIndex] = {
        ...entry.pendingWakeups[existingIndex],
        ...nextWakeup,
      };
    } else {
      entry.pendingWakeups.push(nextWakeup);
    }
    state[sessionId] = entry;
  });
}

export function removeWakeup(sessionId, wakeupId) {
  return mutate((state) => {
    const entry = normalizeSessionEntry(state[sessionId]);
    entry.pendingWakeups = entry.pendingWakeups.filter((item) => item.id !== wakeupId);
    state[sessionId] = entry;
  });
}

export function markWakeupStatus(sessionId, wakeupId, status, extraFields = {}) {
  return mutate((state) => {
    const entry = normalizeSessionEntry(state[sessionId]);
    const wakeup = entry.pendingWakeups.find((item) => item.id === wakeupId);
    if (!wakeup) {
      return;
    }
    Object.assign(wakeup, extraFields, {
      status,
      updatedAt: new Date().toISOString(),
    });
    state[sessionId] = entry;
  });
}

export function addSentMessage(sessionId, sentMessage) {
  return mutate((state) => {
    const entry = normalizeSessionEntry(state[sessionId]);
    entry.sentMessages.push({
      ...sentMessage,
      createdAt: sentMessage.createdAt || new Date().toISOString(),
    });
    if (entry.sentMessages.length > 20) {
      entry.sentMessages = entry.sentMessages.slice(-20);
    }
    state[sessionId] = entry;
  });
}

export function listSentMessages(sessionId) {
  return getSessionEntry(sessionId).sentMessages;
}
