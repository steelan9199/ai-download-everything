"use strict";
/**
 * 大模型顾问（OpenAI 兼容接口，唯一烧 token 的模块）
 * 支持 OpenAI / DeepSeek / Kimi / 通义 等：都是 OpenAI 兼容的 /chat/completions，换 baseURL+key 即可。
 * 默认不自动调用（autoCall=false），只在「问 AI」或异常兜底时被 orchestrator 请来。
 */
import * as settings from "../settings.js";

let callCount = 0;
export function getCallCount() {
  return callCount;
}

/**
 * 发一次对话，返回 { ok, text } 或 { ok:false, error }。
 * 每次只问一件最小的事（由调用方把上下文压到一段里），避免多轮闲聊烧 token。
 */
export async function ask(prompt, options = {}) {
  const cfg = settings.load().ai || {};
  if (!cfg.apiKey)
    return { ok: false, error: "还没配置大模型 API Key，去「设置」页填一下。" };

  const base = (cfg.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions")
    ? base
    : base + "/chat/completions";
  const messages = [];
  if (options.system)
    messages.push({ role: "system", content: options.system });
  messages.push({ role: "user", content: prompt });

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.model || "gpt-4o-mini",
        messages,
        temperature: options.temperature ?? 0.2,
      }),
    });
  } catch (e) {
    return { ok: false, error: "网络请求失败：" + (e.message || e) };
  }
  callCount++;
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: `API 返回 ${res.status}：${t.slice(0, 300)}` };
  }
  const data = await res.json().catch(() => ({}));
  const text =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  return { ok: true, text };
}

/** 构造「请给一段最小可执行脚本」的提问，产出结构化 JSON（script 字段） */
export function buildScriptPrompt({ url, host, diagnostic, userDesc }) {
  return [
    "你是视频下载器里的诊断脚本助手。请针对下面这个下载失败的场景，写一段【单一职责、最小】的 Node.js 脚本，越快越好。",
    `目标站点：${url}（host: ${host}）`,
    `诊断摘要：${diagnostic}`,
    `用户描述：${userDesc || "（无）"}`,
    "",
    "脚本只能使用我注入的 api 对象，可用的 api：",
    "  api.http.get(url, {headers}) -> {status, text}",
    "  api.http.getBuffer(url, {headers}) -> Buffer",
    "  api.fs.writeFile(filename, data) / api.fs.readFile(filename) / api.fs.list()  （只能落在下载目录）",
    "  api.exec(ffmpeg 或 yt-dlp 命令)",
    "  api.log(msg)",
    "",
    '要求：把真正有用的结果写到下载目录下一个 "result.json"（务必用 api.fs.writeFile 写）。',
    "只输出一段 JS 代码，用 ```javascript 包裹，不要解释。若判断无法自动解决，输出 SOLUTION_IMPOSSIBLE。",
  ].join("\n");
}
