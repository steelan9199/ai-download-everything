"use strict";
/**
 * 设置持久化模块
 * 为什么外置成一个模块：所有模块（下载引擎/自检/AI 顾问）都要读同一份配置，
 * 集中读写 + 默认值兜底，能避免每处各自 parse JSON、默认值不一致的坑。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULTS = {
  // 下载目录：默认给用户主目录下，必填可改
  downloadDir: path.join(os.homedir(), "Downloads", "AI下载视频"),
  // 二进制路径：留空 = 走系统 PATH 自动探测（启动自检会 resolve）
  ffmpegPath: "",
  ytdlpPath: "",
  // 大模型（OpenAI 兼容）
  ai: {
    apiKey: "",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    autoCall: false, // 默认关闭自动调用，只在「问 AI」或异常兜底时触发
  },
  // 并发分片下载数 / 重试策略
  download: {
    concurrency: 6,
    maxRetries: 3,
    timeoutMs: 20000,
  },
  // 临时全权（仅本会话生效，任务结束自动复位）
  fullAccess: false,
};

export function settingsFile() {
  // 优先走 Electron userData（跨版本稳定）；--selfcheck 时 app 未完全 ready 会退回临时目录
  try {
    if (app && app.getPath && app.getPath("userData")) {
      return path.join(app.getPath("userData"), "settings.json");
    }
  } catch (_) {
    /* ignore */
  }
  return path.join(os.tmpdir(), "ai-video-downloader-settings.json");
}

export function load() {
  const file = settingsFile();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    /* 首次运行无文件，走默认值 */
  }
  // 深合并：保证新增的默认字段永远存在，用户改过的字段保留
  return deepMerge(DEFAULTS, stored || {});
}

export function save(patch) {
  const current = load();
  const next = deepMerge(current, patch || {});
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(override || {})) {
    const v = override[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object"
    ) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
