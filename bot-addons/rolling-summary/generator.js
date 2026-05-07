"use strict";

const https = require("https");
const http = require("http");
const config = require("../config.js");

const SUMMARY_SYSTEM_PROMPT = `你是一个技术上下文提取器。你的输出会被另一个 LLM 作为 system prompt 使用。

## 输入
- 之前的上下文摘要（如果存在）
- 最近 10 轮对话记录

## 输出要求
返回一个上下文摘要，供另一个 LLM 在下轮对话中使用。必须包含：

### 1. 当前任务
用一句话描述用户正在做什么。

### 2. 已做出的决策
列出所有已确认的决定、选择和方案。如果某项决定被推翻或修改了，标注"（已废弃）"而非直接删除。

### 3. 关键实体
列出涉及的文件路径、函数名、错误信息、API 端点、配置项。每个实体一行，路径保留完整，错误信息保留原文。

### 4. 操作历史
最近的操作序列，每条标注 [成功] 或 [失败]。失败项标注原因。

### 5. 用户偏好
记录用户明确表达的偏好或约束（如"不要改配置文件"、"必须用 async"）。如果旧摘要中有偏好、本轮对话中用户推翻了它，标注"（已变更）"。

### 6. 待解决
列出还没有答案、还没有完成、或用户还没回复的问题。

## 格式规则
- 用中文
- 不要添加"以下是更新后的摘要："之类的引导语
- 如果旧摘要中的信息和本轮对话有冲突，以本轮为准
- 不要编造信息。如果旧摘要中某项在本轮没有被提及，保留它但标注"（无更新）"
- 总长度控制在 {{MAX_CHARS}} 字以内`;

/**
 * Build the user prompt for summary generation
 * @param {string|null} previousSummary
 * @param {string} newMessages
 * @returns {string}
 */
function buildSummaryPrompt(previousSummary, newMessages) {
  const prevSection = previousSummary
    ? `## 之前的摘要\n${previousSummary}`
    : "## 之前的摘要\n无（这是第一次生成摘要）";

  return `${prevSection}\n\n## 最近的变化\n${newMessages}`;
}

/**
 * Generate a rolling summary via DeepSeek API
 * @param {string|null} previousSummary
 * @param {string} newMessages - formatted recent rounds
 * @returns {Promise<string>} the new summary text
 */
async function generateSummary(previousSummary, newMessages) {
  return withRetry(async () => {
    const systemPrompt = SUMMARY_SYSTEM_PROMPT.replace("{{MAX_CHARS}}", String(config.SUMMARY_MAX_CHARS));
    const userPrompt = buildSummaryPrompt(previousSummary, newMessages);

    const body = JSON.stringify({
      model: config.ROLLING_SUMMARY_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: config.SUMMARY_MAX_TOKENS,
      temperature: 0.3,
    });

    const response = await deepseekRequest("/chat/completions", body);
    const data = JSON.parse(response);
    const choice = data.choices && data.choices[0];
    const finishReason = choice && choice.finish_reason;
    const content = choice && choice.message
      ? choice.message.content
      : "";

    if (finishReason && finishReason !== "stop") {
      throw new Error(`DeepSeek API returned finish_reason=${finishReason}; summary not saved`);
    }

    if (!content) {
      let preview = "";
      try { preview = JSON.stringify(JSON.parse(response)).slice(0, 200); } catch (_) { preview = response.slice(0, 200); }
      throw new Error("DeepSeek API returned empty content. Preview: " + preview);
    }

    // Remove thinking tags if present
    return content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  });
}

/**
 * Make an HTTPS request to DeepSeek API
 * @param {string} path
 * @param {string} body
 * @returns {Promise<string>}
 */
function deepseekRequest(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.DEEPSEEK_API_URL + path);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`DeepSeek API error ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        resolve(data);
      });
    });

    req.on("error", (e) => reject(new Error(`DeepSeek API network error: ${e.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("DeepSeek API timeout"));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Retry wrapper with exponential backoff
 * @param {Function} fn
 * @returns {Promise<any>}
 */
async function withRetry(fn) {
  let lastError;
  for (let attempt = 0; attempt < config.MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < config.MAX_RETRIES - 1) {
        const delay = config.RETRY_BACKOFF_MS[attempt] || 4000;
        console.log(`[rolling-summary] Retry ${attempt + 1}/${config.MAX_RETRIES} after ${delay}ms: ${e.message}`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { generateSummary };
