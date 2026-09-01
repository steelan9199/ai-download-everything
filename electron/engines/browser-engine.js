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
    // 抖音/字节系「打开 App」深链用自定义协议（bytedance: 等）。把这些 scheme 注册成空处理器，
    // 在导航层之前就被吞掉，Windows 就不会再弹「获取打开此链接的应用」。
    for (const scheme of ["bytedance", "snssdk1128", "snssdk"]) {
      try {
        ses.protocol.handle(scheme, () => new Response(null, { status: 204 }));
      } catch (_) {
        /* 个别 scheme 注册失败不影响主流程 */
      }
    }
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

    // 非 HLS 直链（抖音这类签名 mp4，URL 不带 .mp4 后缀）：抖音/DASH 会把「纯画面」和
    // 「纯声音」拆成两条独立流。这里先统一收进一个候选池（content-type 仅作弱提示），
    // 「是画面还是声音」交给下载前 ffmpeg 探测（hasVideo / hasAudio）最终判定。
    const mediaCandidates = []; // { url, type, kind }
    const seenMedia = new Set();
    const onHeaders = (details, cb) => {
      const raw = details.responseHeaders || {};
      const ctArr = raw["content-type"] || raw["Content-Type"] || [];
      const ct = String(Array.isArray(ctArr) ? ctArr[0] || "" : ctArr);
      if (!isLikelyMedia(details.url, ct) || seenMedia.has(details.url)) {
        cb({});
        return;
      }
      seenMedia.add(details.url);
      mediaCandidates.push({ url: details.url, type: ct, kind: ctKind(ct) });
      if (mediaCandidates.length === 1)
        this.onEvent({ type: "found-media", url: details.url });
      cb({});
    };
    ses.webRequest.onHeadersReceived(filter, onHeaders);

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

    // 非 HLS 直链：把页面正在播放的 <video>/<audio> 地址也扫进来（抖音播放器可能用 currentSrc 指到 CDN）
    if (!m3u8Url) {
      const pageMedia = await this.grabPageMedia();
      for (const m of pageMedia) {
        if (seenMedia.has(m.url)) continue;
        seenMedia.add(m.url);
        mediaCandidates.push({
          url: m.url,
          type: m.type || "",
          kind: m.kind || null,
          pageDuration: m.duration && Number.isFinite(m.duration) ? m.duration : null,
          pageWidth: m.width || null,
          pageHeight: m.height || null,
        });
      }
    }
    // 抓到直链就走「探测 → 分流 → 点选 → 下载 → 合成」完整流程；没抓到才走「人喂链接」
    if (!m3u8Url && mediaCandidates.length) {
      const dctx = await this.collectContext(url);
      this.onEvent({ type: "status", msg: "抓到媒体直链，正在探测时长……" });
      return await this.downloadAndMergeAV(mediaCandidates, dctx);
    }

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

  /** 从页面里正在播放的 <video>/<audio> 元素拿媒体地址（抖音等直链站用 currentSrc 指到 CDN）。
   *  顺带取已加载的时长/分辨率，作为点选展示的一等数据（网页已解码，无需再探测）。 */
  async grabPageMedia() {
    if (!this.win || this.win.isDestroyed()) return [];
    try {
      const items = await this.win.webContents.executeJavaScript(
        `(() => {
          const out = [];
          document.querySelectorAll('video,audio').forEach((el) => {
            const s = el.currentSrc || el.src;
            if (!s) return;
            out.push({
              url: s,
              kind: el.tagName.toLowerCase(),
              duration: Number.isFinite(el.duration) ? el.duration : null,
              width: el.videoWidth || null,
              height: el.videoHeight || null,
            });
          });
          return out;
        })()`,
        true,
      );
      return Array.isArray(items)
        ? items.filter((m) => m && /^https?:/i.test(m.url))
        : [];
    } catch (_) {
      return [];
    }
  }

  /** 把一条直链下载到工作目录临时文件（后续交给 ffmpeg 合成），返回本地路径 */
  async downloadToTemp(url, ext, ctx) {
    const buf = await http.getBuffer(url, {
      headers: this.buildHeaders(ctx, url),
      timeoutMs: 120000,
    });
    const file = path.join(
      this.workDir,
      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
    );
    fs.writeFileSync(file, buf);
    return file;
  }

  /** 非 HLS 直链主流程：探测候选流的时长/分辨率/有无画面/有无声音 → 人工点选画面流 → 下载 → 合成 */
  async downloadAndMergeAV(all, ctx) {
    const probed = await this.probeCandidates(all, ctx);

    // 关键：画面/声音以「探测出的内容」为准，而不是 URL 后缀。抖音的纯音频流
    // （无视频轨）绝不能混进画面点选列表，否则就会「下成 mp4 却只有声音」。
    const videoList = probed.filter((c) => {
      if (c.hasVideo === true) return true; // 确有视频轨 → 画面
      if (c.hasAudio === true) return false; // 只有声音 → 归声音
      if (c.kind === "audio" || /^audio\//i.test(String(c.type || ""))) return false;
      return true; // 探测失败：默认当画面（单文件老站）
    });
    const audioList = probed.filter(
      (c) => c.hasAudio === true && c.hasVideo !== true,
    );

    const byDurDesc = (a, b) => (b.duration ?? -1) - (a.duration ?? -1);
    videoList.sort(byDurDesc);
    audioList.sort(byDurDesc);

    if (videoList.length === 0) {
      if (audioList.length === 0) throw new Error("没抓到任何媒体直链");
      this.onEvent({ type: "status", msg: "只抓到声音流（无画面），直接存音频" });
      const f = await this.downloadToTemp(
        audioList[0].url,
        extFromContentType(audioList[0].type) || ".m4a",
        ctx,
      );
      return await this.publishDirect(f);
    }

    let chosen;
    if (videoList.length === 1) chosen = videoList[0];
    else chosen = await this.askPickVideo(videoList, audioList);
    if (!chosen) throw new Error("没抓到画面流");

    const vFile = await this.downloadToTemp(
      chosen.url,
      extFromContentType(chosen.type) || extFromUrl(chosen.url) || ".mp4",
      ctx,
    );
    this.onEvent({ type: "status", msg: "画面流已下载，正在处理声音……" });

    if (chosen.hasAudio) return await this.publishDirect(vFile);

    const audio = audioList[0];
    if (!audio) {
      this.onEvent({ type: "status", msg: "没抓到独立声音流，直接输出画面（可能无声音）" });
      return await this.publishDirect(vFile);
    }
    const aFile = await this.downloadToTemp(
      audio.url,
      extFromContentType(audio.type) || ".m4a",
      ctx,
    );
    const outFile = path.join(this.downloadDir, `video_${Date.now()}.mp4`);
    this.onEvent({ type: "merge-start", file: outFile });
    await ffmpeg.mergeAV(this.ffmpegPath, vFile, aFile, outFile, {
      onLine: (l) => this.onLog({ level: "info", msg: l.trim() }),
    });
    this.onEvent({ type: "merge-done", file: outFile });
    return outFile;
  }

  /** 把已就位的本地文件发布到下载目录（无需合成时的成品搬运） */
  async publishDirect(tempFile) {
    const ext = path.extname(tempFile) || ".mp4";
    const outFile = path.join(this.downloadDir, `video_${Date.now()}${ext}`);
    fs.copyFileSync(tempFile, outFile);
    this.onEvent({ type: "direct-done", file: outFile });
    return outFile;
  }

  /** 批量探测候选流：并行调用 ffmpeg 拿时长/分辨率/有无声音，页面已解码的时长优先采用 */
  async probeCandidates(list, ctx) {
    return Promise.all(
      list.map(async (m) => {
        let info = { duration: null, width: null, height: null, hasAudio: false };
        if (this.ffmpegPath) {
          const headerStr = Object.entries(this.buildHeaders(ctx, m.url))
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
          try {
            info = await ffmpeg.probeMedia(this.ffmpegPath, m.url, {
              headers: headerStr,
            });
          } catch (_) {
            info = { duration: null, width: null, height: null, hasAudio: false };
          }
        }
        if (m.pageDuration != null && m.pageDuration > 0)
          info.duration = m.pageDuration;
        if (m.pageWidth) {
          info.width = m.pageWidth;
          info.height = m.pageHeight;
        }
        return { ...m, ...info };
      }),
    );
  }

  /** 让人从候选画面流里点选一条（按时长从长到短排列） */
  async askPickVideo(pics, auds) {
    const options = pics.map((p, i) => ({
      value: String(i),
      label:
        `${fmtDuration(p.duration)}` +
        (p.width && p.height ? ` · ${p.width}×${p.height}` : " · 分辨率未知") +
        (p.hasAudio
          ? " · 自带声音"
          : ` · 无声音${auds.length ? "（可合成）" : ""}`),
    }));
    const ans = await this.askUser({
      id: "pick-video",
      prompt: "抓到多条画面流（按时长从长到短排列）。请点选你要的那条（通常选最长的完整版）：",
      options,
    });
    const idx = Number(ans && ans.choice);
    return Number.isInteger(idx) && pics[idx] ? pics[idx] : pics[0];
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

/** content-type → 弱提示「video / audio」：只作探测失败时的兜底，不作为最终判定 */
function ctKind(ct) {
  const s = String(ct || "");
  if (/^video\//i.test(s)) return "video";
  if (/^audio\//i.test(s)) return "audio";
  return null;
}

/** 响应是否可能是媒体直链（收集前的粗筛，避免把 JS/CSS 也塞进候选池） */
function isLikelyMedia(url, ct) {
  if (ctKind(ct)) return true;
  if (/^application\/octet-stream$/i.test(String(ct || "")) && looksLikeMediaUrl(url))
    return true;
  return /\.(mp4|m4v|mov|webm|flv|m4a|mp3|aac)(\?.*)?$/i.test(url);
}

/** 秒数 → 「x分xx秒」/「x秒」的可读时长 */
function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "时长未知";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}秒`;
  return `${m}分${String(s).padStart(2, "0")}秒`;
}

/** 判断 URL 是否像媒体直链（配合 application/octet-stream 这种不写 video/ 的 CDN） */
function looksLikeMediaUrl(url) {
  return /aweme\/v1\/play|douyinvod|mime_type=video|video_id=/i.test(url);
}

/** content-type → 文件后缀 */
function extFromContentType(ct) {
  const m = /^video\/([a-z0-9.+-]+)/i.exec(String(ct || ""));
  if (!m) return null;
  const t = m[1].toLowerCase();
  const map = {
    mp4: ".mp4",
    "x-flv": ".flv",
    webm: ".webm",
    quicktime: ".mov",
    "x-matroska": ".mkv",
    mp2t: ".ts",
  };
  return map[t] || "." + t.split("+")[0];
}

/** URL 里带媒体后缀时给出扩展名（兜底） */
function extFromUrl(url) {
  const m = /\.(mp4|webm|mov|mkv|flv|ts|m4v|avi)(\?.*)?$/i.exec(String(url));
  return m ? "." + m[1].toLowerCase() : null;
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
