"use strict";
/**
 * 启动自检模块（纯代码，不花 token）
 * 探测 ffmpeg / yt-dlp.exe 是否存在、下载目录是否可写；
 * 缺失时返回「指引」（下载链接 + 安装命令 + 去填写路径入口），而不是报错装死。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as settings from "./settings.js";

// 指引文案：普通人也能照做的下载/安装方式
export const HELP = {
  ffmpeg: {
    title: "缺少 ffmpeg",
    steps: [
      '方式一（推荐，最快）：按 Win 键，输入「PowerShell」，右键"以管理员身份运行"，粘贴回车：',
      "  winget install Gyan.FFmpeg",
      '方式二：浏览器打开 https://www.gyan.dev/ffmpeg/builds/ 下载 "release full" 压缩包，解压后在设置页把 bin\\ffmpeg.exe 路径填进去。',
    ],
  },
  ytdlp: {
    title: "缺少 yt-dlp.exe",
    steps: [
      "方式一（推荐）：管理员 PowerShell 里粘贴回车：",
      "  winget install yt-dlp.yt-dlp",
      "方式二：浏览器打开 https://github.com/yt-dlp/yt-dlp/releases 下载 yt-dlp.exe，在设置页填它的完整路径（如 D:\\software\\yt-dlp.exe）。",
    ],
  },
};

// 在 PATH 上找命令（Windows: where.exe；其它平台: which）
export function findOnPath(name) {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  try {
    const out = execFileSync(cmd, [name], { encoding: "utf8", timeout: 5000 })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return out[0] || null;
  } catch (_) {
    return null;
  }
}

// 把「用户填的路径」或「PATH 探测结果」落地成一个绝对 exe 路径
export function resolveTool(configuredPath, name) {
  if (configuredPath && fs.existsSync(configuredPath)) {
    return { found: true, path: configuredPath, configured: true };
  }
  const p = findOnPath(name);
  if (p && fs.existsSync(p)) {
    return { found: true, path: p, configured: false };
  }
  // 用户填了但路径错误：单独标记，提示「你填的路径打不开」
  return {
    found: false,
    path: configuredPath || null,
    configuredWrong: !!configuredPath,
  };
}

export function checkDownloadDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 写一个临时文件再删掉，验证真的可写（不是只读盘/权限不足）
    const probe = path.join(dir, `.write-probe-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, path: dir, error: String(e.message || e) };
  }
}

export function run() {
  const cfg = settings.load();
  const ffmpeg = resolveTool(cfg.ffmpegPath, "ffmpeg");
  const ytdlp = resolveTool(cfg.ytdlpPath, "yt-dlp");
  const dir = checkDownloadDir(cfg.downloadDir);

  const result = {
    ffmpeg: { ...ffmpeg, help: ffmpeg.found ? null : HELP.ffmpeg },
    ytdlp: { ...ytdlp, help: ytdlp.found ? null : HELP.ytdlp },
    downloadDir: dir,
    os: { platform: process.platform, arch: process.arch },
    allReady: ffmpeg.found && ytdlp.found && dir.ok,
  };
  return result;
}
