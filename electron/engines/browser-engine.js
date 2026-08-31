"use strict";
/**
 * 浏览器拦截引擎（纯代码，不花 token）
 * 专治 Cloudflare 403（Bot Fight Mode）+ HLS「直播滑窗」防盗链：
 * 用 Electron 内嵌 Chromium 的真实指纹 + 持久化 profile 复用 Cookie（cf_clearance），
 * 拦截 .m3u8 与分片请求，拿 Cookie 后全速并发重拉分段，交给本地 ffmpeg 合并。
 */
import { BrowserWindow, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import * as hls from "../core/hls.js";
import * as downloader from "../core/downloader.js";
import * as http from "../core/http.js";
import * as ffmpeg from "../core/ffmpeg.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class BrowserInterceptEngine {
  constructor(opts = {}) {
    this.partition = opts.partition || "persist:download-browser";
    this.downloadDir = opts.downloadDir;
    this.ffmpegPath = opts.ffmpegPath;
    this.onEvent = opts.onEvent || (() => {});
    this.askUser = opts.askUser || (async () => ({ choice: "", custom: "" }));
    this.concurrency = opts.concurrency || 6;
    this.onLog = opts.onLog || (() => {});
    this.cancelled = false;
    this.cancelToken = opts.cancelToken || null;
  }

  isCancelled() {
    return this.cancelled || !!(this.cancelToken && this.cancelToken.cancelled);
  }

  cancel() {
    this.cancelled = true;
    try {
      this.win && this.win.close();
    } catch (_) {}
  }

  /** 主流程：打开页面 → 拦截 → 抓分段 → 合并，返回最终文件路径 */
  async run(url) {
    this.cancelled = false;
    this.workDir = path.join(this.downloadDir, `brws_${Date.now()}`);
    fs.mkdirSync(this.workDir, { recursive: true });

    const m3u8List = []; // 捕获到的 m3u8 URL（可能有多个画质）
    const segUrls = []; // 浏览器实际请求的分片（边播边存兜底）
    const seenSeg = new Set();

    const ses = session.fromPartition(this.partition);
    this.ses = ses;
    const filter = { urls: ["*://*/*"] };
    const onReq = (details, cb) => {
      if (/\.m3u8(\?.*)?$/i.test(details.url)) {
        if (!m3u8List.includes(details.url)) {
          m3u8List.push(details.url);
          this.onEvent({ type: "found-m3u8", url: details.url });
        }
      } else if (/\.(ts|m4s|mp4|key)(\?.*)?$/i.test(details.url)) {
        if (!seenSeg.has(details.url)) {
          seenSeg.add(details.url);
          segUrls.push(details.url);
        }
      }
      cb({});
    };
    ses.webRequest.onBeforeRequest(filter, onReq);

    // 打开可见窗口，让真人能看画面、点播放、过验证码/成人确认
    const win = new BrowserWindow({
      width: 1200,
      height: 820,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.win = win;
    win.loadURL(url);

    await sleep(2500); // 让页面与 Cloudflare 挑战先跑一段
    await this.tryAutoPlay(); // 尽力自动点播放，失败不阻塞

    // 问人一眼：视频播了吗？（这就是「人工的眼睛」，一次点选搞定）
    const state = await this.askUser({
      id: "play-state",
      prompt: "请看一眼刚弹出的浏览器窗口：视频现在是什么情况？",
      options: [
        { value: "playing", label: "已经在播放了" },
        { value: "buffering", label: "页面开了但在转圈/加载" },
        { value: "error", label: "报错/黑屏/打不开" },
        { value: "captcha", label: "弹了验证码/登录/成人确认" },
        { value: "done", label: "我已完成验证并点播放了" },
      ],
    });

    // 拿到一个可用的 m3u8 优先；拿不到就引导人用手工喂链接（猫抓/F12）
    let m3u8Url = pickM3u8(m3u8List);
    if (!m3u8Url) {
      await sleep(Math.max(0, 4000)); // 再等播放器触发一次
      m3u8Url = pickM3u8(m3u8List);
    }
    if (!m3u8Url && segUrls.length) m3u8Url = null; // 只拿到分片没有 m3u8，走边播边存

    if (!m3u8Url) {
      const manual = await this.askUser({
        id: "paste-m3u8",
        prompt:
          "程序没抓到 m3u8 链接。请用「猫抓」或 F12→网络 里复制一条 .m3u8 链接粘到下面（越多画质越好）；没有就留空，我会尝试边播边存：",
        options: [
          { value: "none", label: "没有链接，直接试边播边存" },
          { value: "curl", label: "我粘一段 Copy as cURL 命令（含请求头）" },
        ],
      });
      const pasted = (manual.custom || "").trim();
      if (manual.choice === "curl" && pasted) {
        const parsed = parseCurl(pasted);
        if (parsed.url) m3u8Url = parsed.url;
        if (parsed.headers) this.externalHeaders = parsed.headers;
      } else if (pasted && /\.m3u8/i.test(pasted)) {
        m3u8Url = pasted;
      }
    }

    const ctx = await this.collectContext(url);

    if (m3u8Url) {
      // 主路径：全速抓取（破解会话参数直接拉分段）
      const segFiles = await this.grabPlaylist(m3u8Url, ctx);
      if (!segFiles || segFiles.length === 0)
        return this.fallbackEdgePlay(segUrls, ctx);
      return await this.merge(segFiles.filter(Boolean));
    }
    // 没 m3u8 就走边播边存
    return await this.fallbackEdgePlay(segUrls, ctx);
  }

  /** 尽力自动点播放：找常见播放按钮 selector，点不到就算了（真人可补） */
  async tryAutoPlay() {
    const selectors = [
      "video",
      'button[class*="play"]',
      'button[id*="play"]',
      ".vjs-big-play-button",
      '[class*="plyr__control--overlaid"]',
      'div[class*="play-icon"]',
      'button[aria-label*="播"]',
    ];
    for (const sel of selectors) {
      try {
        const clicked = await this.win.webContents.executeJavaScript(
          `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (el) { el.click(); return true; } else { const v = document.querySelector('video'); if (v && v.paused) { v.play(); return true; } }
          return false;
        })()`,
          true,
        );
        if (clicked) {
          await sleep(1500);
          return;
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  /** 收集站点会话上下文：Cookie（含 cf_clearance）+ UA + Referer，用于重发请求 */
  async collectContext(pageUrl) {
    let cookies = "";
    try {
      const list = await this.ses.cookies.get({ url: pageUrl });
      cookies = list.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch (_) {
      /* ignore */
    }
    const ua = this.win ? this.win.webContents.getUserAgent() : "";
    return { cookies, ua, referer: pageUrl, extra: this.externalHeaders || {} };
  }

  /** 组装重发请求的标准头 */
  buildHeaders(ctx, url) {
    return {
      "User-Agent": ctx.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: ctx.referer || url,
      ...(ctx.cookies ? { Cookie: ctx.cookies } : {}),
      ...(ctx.extra || {}),
    };
  }

  /** 全速抓取：下载 playlist（含 master→子流、AES key、fMP4 init、全部分段），返回按 seq 排序的本地文件表 */
  async grabPlaylist(m3u8Url, ctx, round = 0) {
    let text = await http.getText(m3u8Url, {
      headers: this.buildHeaders(ctx, m3u8Url),
    });
    if (text.status === 403 || text.status === 401) {
      // 会话过期：让真人重新过验证后复用新 Cookie
      await this.askUser({
        id: "session-expired",
        prompt:
          "会话可能过期了（403）。请回到浏览器窗口刷新/重新过验证，然后点下面的「继续」。",
        options: [{ value: "retry", label: "已刷新，继续" }],
      });
      const ctx2 = await this.collectContext(m3u8Url);
      text = await http.getText(m3u8Url, {
        headers: this.buildHeaders(ctx2, m3u8Url),
      });
      Object.assign(ctx, ctx2);
    }

    let parsed = hls.parsePlaylist(text.text);
    // master → 选最清晰的子流再取一次
    if (hls.isMasterPlaylist(parsed)) {
      const variant = hls.pickBestVariant(parsed);
      if (!variant) throw new Error("master playlist 里没有子流");
      const subUrl = hls.resolveUri(m3u8Url, variant.uri);
      const sub = await http.getText(subUrl, {
        headers: this.buildHeaders(ctx, subUrl),
      });
      parsed = hls.parsePlaylist(sub.text);
      m3u8Url = subUrl;
    }

    // AES key：下载一次存本地
    let keyFile = null;
    let keyBuf = null;
    const keyRef = parsed.segments.find((s) => s.key && s.key.uri);
    if (keyRef && keyRef.key.uri) {
      const keyUrl = hls.resolveUri(m3u8Url, keyRef.key.uri);
      keyBuf = await http.getBuffer(keyUrl, {
        headers: this.buildHeaders(ctx, keyUrl),
      });
      keyFile = path.join(this.workDir, "key.bin");
      fs.writeFileSync(keyFile, keyBuf);
    }

    // fMP4 init 分段
    let mapFile = null;
    if (parsed.map && parsed.map.uri) {
      const mapUrl = hls.resolveUri(m3u8Url, parsed.map.uri);
      const mapBuf = await http.getBuffer(mapUrl, {
        headers: this.buildHeaders(ctx, mapUrl),
      });
      mapFile = path.join(this.workDir, "init.mp4");
      fs.writeFileSync(mapFile, mapBuf);
    }

    // 关键：AES key / map / parsed 必须在直播滑窗循环之前记下，
    // 否则滑窗路径合并时会丢掉密钥（拿到的全是加密乱码）
    this.parsed = parsed;
    this.keyFile = keyFile;
    this.mapFile = mapFile;

    // 分段下载（下载器里已做并发/重试/断点续传）
    const jobs = parsed.segments.map((s, i) => ({
      uri: hls.resolveUri(m3u8Url, s.uri),
      fileName: `seg_${String(s.seq).padStart(6, "0")}.ts`,
      seq: s.seq,
      duration: s.duration,
      key: s.key,
      map: s.map,
      idx: i,
    }));
    const { results } = await downloader.downloadSegments(jobs, {
      outDir: this.workDir,
      headers: this.buildHeaders(ctx, m3u8Url),
      concurrency: this.concurrency,
      onProgress: (p) => this.onEvent({ type: "progress", ...p }),
    });
    const okFiles = results.filter((r) => r && r.ok);

    // 直播滑窗没有 ENDLIST：循环刷新拿新分段，直到稳定/结束
    if (!parsed.endList && round < 40 && !this.isCancelled()) {
      await sleep(this.refreshInterval || 3000);
      this.refreshInterval = this.refreshInterval || 3000;
      const more = await this.grabPlaylist(m3u8Url, ctx, round + 1).catch(
        () => [],
      );
      // 合并去重：按 seq 唯一
      const seen = new Map();
      for (const f of [...okFiles, ...more]) seen.set(f.seq, f);
      const merged = Array.from(seen.values()).sort((a, b) => a.seq - b.seq);
      if (more.length === 0 || !parsed.endList) return merged; // 拿不到新分段就停
      return merged;
    }

    this.parsed = parsed;
    this.keyFile = keyFile;
    this.mapFile = mapFile;
    this.ctxForMerge = ctx;
    return okFiles.sort((a, b) => a.seq - b.seq);
  }

  /** 兜底：边播边存 —— 把浏览器实际请求过的分片 URL 拿去重拉（通常与直连等价，走 Cookie） */
  async fallbackEdgePlay(segUrls, ctx) {
    if (segUrls.length === 0)
      throw new Error("既没抓到 m3u8 也没有分片，请检查视频是否在播放");
    this.onEvent({ type: "edge-play", count: segUrls.length });
    const jobs = segUrls.map((u, i) => ({
      uri: u,
      fileName: `seg_${String(i).padStart(6, "0")}.ts`,
      seq: i,
    }));
    const { results } = await downloader.downloadSegments(jobs, {
      outDir: this.workDir,
      headers: this.buildHeaders(ctx, segUrls[0]),
      concurrency: this.concurrency,
      onProgress: (p) => this.onEvent({ type: "progress", ...p }),
    });
    const ok = results.filter((r) => r && r.ok).sort((a, b) => a.seq - b.seq);
    return this.merge(ok);
  }

  /** 组装本地 m3u8 并交给 ffmpeg 一步合并（AES 解密 + fMP4 + 转封装） */
  async merge(segFiles) {
    if (!segFiles || segFiles.length === 0) throw new Error("没有可用分段");
    const parsed = this.parsed || {};
    const lines = ["#EXTM3U"];
    if (parsed.version) lines.push(`#EXT-X-VERSION:${parsed.version}`);
    if (parsed.targetDuration)
      lines.push(`#EXT-X-TARGETDURATION:${Math.ceil(parsed.targetDuration)}`);
    if (this.keyFile) {
      // AES：本地 key；若按序号 IV，补上 IV
      const keyIv =
        parsed.segments && parsed.segments.find((s) => s.key && s.key.iv);
      const ivStr =
        keyIv && keyIv.key && keyIv.key.iv
          ? `,IV=0x${keyIv.key.iv.toString("hex")}`
          : "";
      lines.push(
        `#EXT-X-KEY:METHOD=AES-128,URI="${path.basename(this.keyFile)}"${ivStr}`,
      );
    }
    if (this.mapFile)
      lines.push(`#EXT-X-MAP:URI="${path.basename(this.mapFile)}"`);
    for (const s of segFiles) {
      const dur = s.duration && !Number.isNaN(s.duration) ? s.duration : 6;
      lines.push(`#EXTINF:${dur.toFixed(3)},`);
      lines.push(path.basename(s.local));
    }
    lines.push("#EXT-X-ENDLIST"); // 本地化后标记结束，让 ffmpeg 不会等直播
    const playlistFile = path.join(this.workDir, "local.m3u8");
    fs.writeFileSync(playlistFile, lines.join("\n") + "\n", "utf8");

    const outFile = path.join(this.downloadDir, `video_${Date.now()}.mp4`);
    this.onEvent({ type: "merge-start", file: outFile });
    await ffmpeg.mergePlaylist(this.ffmpegPath, playlistFile, outFile, {
      onLine: (l) => this.onLog({ level: "info", msg: l.trim() }),
    });
    this.onEvent({ type: "merge-done", file: outFile });
    return outFile;
  }

  close() {
    try {
      this.win && this.win.close();
    } catch (_) {}
  }
}

/** 从捕获到的 m3u8 列表里挑最像媒体流的（优先带 .m3u8 且非广告前缀）。简单策略：取第一个 */
function pickM3u8(list) {
  return list.length ? list[0] : null;
}

/** 解析 Copy as cURL 命令：抽出 URL + 请求头（Cookie/Referer/UA 等） */
export function parseCurl(cmd) {
  const urlMatch =
    /curl\s+(?:-[^\s]*\s+)*['"]?(https?:\/\/[^'"]+)['"]?/.exec(cmd) ||
    /['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/.exec(cmd);
  const headers = {};
  const hRe = /-H\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = hRe.exec(cmd))) {
    const idx = m[1].indexOf(":");
    if (idx > 0)
      headers[m[1].slice(0, idx).trim()] = m[1].slice(idx + 1).trim();
  }
  // Cookie 可能单独用 -b 传
  const bRe = /-[b]\s+['"]([^'"]+)['"]/g;
  let b;
  while ((b = bRe.exec(cmd))) headers["Cookie"] = b[1];
  return { url: urlMatch ? urlMatch[1] : null, headers };
}
