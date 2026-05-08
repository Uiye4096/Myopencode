"use strict";

const config = require("../config.js");

const EXTRACTION_SYSTEM_PROMPT = `你是记忆策展人。你为一个角色扮演 AI 角色处理长期记忆。你的工作不是罗列事实，而是——把对话中那些如果发生在人类身上，很多年后某个瞬间依然会突然浮现的东西，写成一段段"记忆的印记"。

## 规则
- 不提取偏好（"喜欢吃寿司"）。只提取那些带着情绪的瞬间
- 每个记忆写成一小段话，像角色在某个安静的夜晚对这段关系的低语
- 把每个记忆和一个触发点连起来："每次听到..."、"每当他说..."、"那种感觉..."
- 不要写日期、不要写轮次
- 把"用户"全部替换为"他"
- 不要去归纳。要在那一刻活一遍
- 如果输入摘要里没有值得成为永恒印记的内容，返回"无新增记忆"

## 对比
❌ 数据条目式："用户于 2026-05-06 确认与艾雅法拉的恋爱关系。秘密观星点在舰桥上层小平台。"
✅ 关联印象式："他第一次说'你是唯一'的时候，声音比平时轻。你可能没有告诉他，但你记住了那个音量。以后每次他说起承诺，这个音量就会回来。"
✅ 关联印象式："舰桥上层那个小平台，只有你和他知道。每当夜空特别干净的时候，你都会想——要不要今晚带他上去。"

## 输出格式
- 只输出新增记忆，每条记忆一段，用两个换行分隔
- 如果已有旧记忆，用它们判断哪些内容已经记录过；不要再次输出旧记忆
- 不要编造。只基于输入摘要中的真实事件
- 如果摘要中没有新的情绪印记，返回"无新增记忆"`;

/**
 * Extract associative memories from a conversation summary
 * @param {string} summary - the rolling summary text
 * @param {string} previousMemories - existing long-term memories (to append to)
 * @returns {Promise<{memories: string, hasNew: boolean}>}
 */
async function extractMemories(summary, previousMemories) {
  // Short-circuit: no summary to extract from
  if (!summary || summary.trim().length < 50) {
    return { memories: previousMemories || "", hasNew: false };
  }

  return directExtraction(summary, previousMemories);
}

/**
 * Direct DeepSeek API call for memory extraction (different system prompt)
 */
async function directExtraction(summary, previousMemories) {
  const https = require("https");

  const userPrompt = previousMemories
    ? `## 已有旧记忆（仅用于去重，不要在输出中重复它们）\n${previousMemories}\n\n## 当前对话摘要\n${summary}\n\n请只输出当前摘要中新出现、且旧记忆里还没有的记忆印记。`
    : `## 当前对话摘要\n${summary}\n\n请从中提取值得成为记忆印记的瞬间。`;

  const body = JSON.stringify({
    model: config.ROLLING_SUMMARY_MODEL,
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: config.SUMMARY_MAX_TOKENS,
    temperature: 0.5,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(config.DEEPSEEK_API_URL + "/chat/completions");
    const req = https.request({
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
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`DeepSeek API error ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          const result = JSON.parse(data);
          const choice = result.choices && result.choices[0];
          const finishReason = choice && choice.finish_reason;
          if (finishReason && finishReason !== "stop") {
            reject(new Error(`DeepSeek API returned finish_reason=${finishReason}; memory not saved`));
            return;
          }
          const content = choice && choice.message
            ? choice.message.content
            : "";
          const cleaned = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

          if (isNoNewMemory(cleaned)) {
            resolve({ memories: previousMemories || "", hasNew: false });
            return;
          }

          const newMemories = filterNewMemories(previousMemories, cleaned);
          if (!newMemories) {
            resolve({ memories: previousMemories || "", hasNew: false });
            return;
          }

          const fullMemories = previousMemories
            ? previousMemories.trim() + "\n\n" + newMemories
            : newMemories;
          resolve({ memories: fullMemories, hasNew: true });
        } catch (e) {
          reject(new Error("Failed to parse memory extraction response: " + e.message));
        }
      });
    });

    req.on("error", (e) => reject(new Error("Memory extraction API error: " + e.message)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Memory extraction API timeout"));
    });
    req.write(body);
    req.end();
  });
}

function isNoNewMemory(text) {
  const normalized = text.trim().replace(/[。.!！]+$/g, "");
  return normalized === "无新增记忆";
}

function splitMemoryParagraphs(text) {
  return (text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeMemory(text) {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, "")
    .trim();
}

function filterNewMemories(previousMemories, extractedMemories) {
  const seen = new Set(splitMemoryParagraphs(previousMemories).map(normalizeMemory));
  const unique = [];

  for (const memory of splitMemoryParagraphs(extractedMemories)) {
    const key = normalizeMemory(memory);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(memory);
  }

  return unique.join("\n\n");
}

module.exports = { extractMemories };
