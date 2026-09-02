"use strict";
/**
 * 浏览器拦截引擎（纯代码，不花 token）
 * 专治 Cloudflare 403（Bot Fight Mode）+ HLS「直播滑窗」防盗链：
 * 用 Electron 内嵌 Chromium 的真实指纹 + 持久化 profile 复用 Cookie（cf_clearance），
 * 拦截 .m3u8 与分片请求，拿 Cookie 后全速并发重拉分段，交给本地 ffmpeg 合并。
 */
import { BrowserWindow, session, net } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as hls from "../core/hls.js";
import * as downloader from "../core/downloader.js";
import * as http from "../core/http.js";
import * as ffmpeg from "../core/ffmpeg.js";
import { streamDownload } from "./kuaishou-engine.js";

/**
 * 短链域 → 站点主域。短链（v.douyin.com 等）当 Referer 会被判为非法来源，
 * Chromium 直接 Cancelling request ... with invalid referrer，所以统一换成主域。
 */
const SHORT_LINK_MAIN = {
  "v.douyin.com": "https://www.douyin.com/",
  "v.kuaishou.com": "https://www.kuaishou.com/",
  "chenzhongtech.com": "https://www.kuaishou.com/",
};

/** 把 Referer 归一成「站点主域 + /」（短链换成主域），非法值返回空串 */
function normalizeReferer(u) {
  if (!u) return "";
  try {
    const url = new URL(u);
    for (const [host, main] of Object.entries(SHORT_LINK_MAIN)) {
      if (url.host === host || url.host.endsWith("." + host)) return main;
    }
    return url.origin + "/";
  } catch (_) {
    return "";
  }
}

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
    // 抖音/字节系「打开 App」深链用自定义协议（bytedance: 等），快手是 kwai:/kuaishou:。
    // 把这些 scheme 注册成空处理器，在导航层之前就被吞掉，Windows 就不会再弹「获取打开此链接的应用」。
    for (const scheme of ["bytedance", "snssdk1128", "snssdk", "kwai", "kuaishou", "kwainebula"]) {
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
        // 爱奇艺调度接口（pcw-data.video.iqiyi.com）返回的是 JSON 节点列表，不是媒体分片
        if (isIqiyiScheduler(details.url)) {
          cb({});
          return;
        }
        // 爱奇艺广告分片（/videos/other/、.f4v、qd_tvid 为空）丢弃，只留正片
        if (isIqiyiAd(details.url)) {
          cb({});
          return;
        }
        if (!seenSeg.has(details.url)) {
          seenSeg.add(details.url);
          segUrls.push(details.url);
          if (segUrls.length === 1 || segUrls.length % 10 === 0)
            this.onLog({
              level: "info",
              msg: `已捕获正片分片 ${segUrls.length} 个`,
            });
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
      mediaCandidates.push({
        url: details.url,
        type: ct,
        // content-type 不可靠（抖音声音流也可能标 video/mp4），URL 里的
        // media-audio / media-video 是更准的归类依据
        kind: ctKind(ct) || mediaKindFromUrl(details.url),
      });
      if (mediaCandidates.length === 1)
        this.onEvent({ type: "found-media", url: details.url });
      this.onLog({
        level: "info",
        msg: `捕获媒体直链 ${mediaCandidates.length} 条（${
          /media-audio|mime_type=audio/i.test(details.url) ? "声音" : "画面?"
        }）`,
      });
      cb({});
    };
    ses.webRequest.onHeadersReceived(filter, onHeaders);

    // 打开可见窗口：加载带「地址栏」的浏览壳，页面本体放进同分区的 <webview>。
    // 这样既能显示/修改当前网址（像正常浏览器），又不丢 Cookie 复用与网络拦截。
    const win = new BrowserWindow({
      width: 1200,
      height: 820,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
    });
    this.win = win;

    // 记录 <webview> 的 guest webContents：自动点播放 / 抓页面媒体都作用在它上面
    this.viewWc = null;
    win.webContents.on("did-attach-webview", (_e, webContents) => {
      this.viewWc = webContents;
    });

    const shellFile = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "browser-shell.html",
    );
    await win.loadFile(shellFile, { query: { url, partition: this.partition } });

    // 等 webview attach 就绪（通常瞬间完成）
    for (let i = 0; i < 100 && !this.viewWc; i++) await sleep(100);

    await sleep(2500); // 让页面与 Cloudflare 挑战先跑一段
    await this.tryAutoPlay(); // 尽力自动点播放，失败不阻塞
    this.onEvent({
      type: "status",
      msg: "内置浏览器窗口已打开：请确认正片在播放；分片没抓全时，把进度条从头拖到尾拖一遍",
    });

    // 问人一眼：视频播了吗？（这就是「人工的眼睛」，一次点选搞定）
    this.onLog({
      level: "info",
      msg: `等待你确认播放状态（目前已捕获 m3u8=${m3u8List.length} 个、正片分片=${segUrls.length} 个）`,
    });
    const state = await this.askUser({
      id: "play-state",
      prompt:
        "请看一眼刚弹出的浏览器窗口：视频现在是什么情况？\n\n" +
        "⚠ 重要：如果视频正在播，【先别点任何选项】。到浏览器窗口里把进度条从最开头拖到最末尾、慢慢拖一遍（每个位置停 1~2 秒），" +
        "逼播放器把全片分片都请求出来；同时看主窗口日志里「已捕获正片分片 N 个」，等数字不再增长后，再回来点「已经在播放了」。",
      options: [
        { value: "playing", label: "已经在播放了（我已拖完进度条、分片抓全）" },
        { value: "buffering", label: "页面开了但在转圈/加载" },
        { value: "error", label: "报错/黑屏/打不开" },
        { value: "captcha", label: "弹了验证码/登录/成人确认" },
        { value: "done", label: "我已完成验证并点播放了" },
      ],
    });

    // 抖音网页版常「静音自动播放」：浏览器自动播放策略下，声音流可能根本没发起请求，
    // 导致只抓到画面流。用户刚才在页面上点过/拖过进度条（已产生用户手势），这里
    // 强制取消静音，逼播放器把声音流也请求出来，再等几秒让网络拦截抓到。
    if (state.choice === "playing" || state.choice === "done") {
      await this.forceUnmute();
      await sleep(5000);
      this.onLog({
        level: "info",
        msg: `静音解除后共捕获媒体直链 ${mediaCandidates.length} 条`,
      });
    }

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
          kind: (m.kind === "video" || m.kind === "audio" ? m.kind : null)
            || mediaKindFromUrl(m.url),
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
    // 页面 <video> 时长：校验边播边存拼出的整片是否完整（不全就提示拖进度条，而不是产出残片）
    const pageDuration = await this.getPageDuration();

    if (m3u8Url) {
      // 主路径：全速抓取（破解会话参数直接拉分段）
      const segFiles = await this.grabPlaylist(m3u8Url, ctx);
      if (!segFiles || segFiles.length === 0)
        return this.fallbackEdgePlay(segUrls, ctx, pageDuration);
      return await this.merge(segFiles.filter(Boolean));
    }
    // 没 m3u8 就走边播边存
    return await this.fallbackEdgePlay(segUrls, ctx, pageDuration);
  }

  /** 尽力自动点播放：找常见播放按钮 selector，点不到就算了（真人可补） */
  async tryAutoPlay() {
    if (!this.viewWc || this.viewWc.isDestroyed()) return;
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
        const clicked = await this.viewWc.executeJavaScript(
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

  /** 强制页面里的 <video>/<audio> 取消静音并播放。
   *  浏览器自动播放策略要求「先有用户手势」——用户在页面上点过/拖过进度条后即满足，
   *  目的是逼抖音 DASH 播放器把「声音流」也请求出来（静音时它可能压根不请求）。 */
  async forceUnmute() {
    if (!this.viewWc || this.viewWc.isDestroyed()) return;
    try {
      await this.viewWc.executeJavaScript(
        `(() => {
          document.querySelectorAll('video,audio').forEach((el) => {
            try {
              el.muted = false;
              el.volume = 1;
              if (el.paused) el.play().catch(() => {});
            } catch (_) {}
          });
        })()`,
        true,
      );
    } catch (_) {}
  }

  /** 从页面里正在播放的 <video>/<audio> 元素拿媒体地址（抖音等直链站用 currentSrc 指到 CDN）。
   * 顺带取已加载的时长/分辨率，作为点选展示的一等数据（网页已解码，无需再探测）。 */
  async grabPageMedia() {
    if (!this.viewWc || this.viewWc.isDestroyed()) return [];
    try {
      const items = await this.viewWc.executeJavaScript(
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
          // MSE 播放器的 <video>.currentSrc 是 blob: 地址，真实 CDN 直链从
          // 资源计时记录里捞（画面流 media-video / 声音流 media-audio 都在）。
          try {
            performance.getEntriesByType('resource').forEach((e) => {
              if (/douyinvod|media-audio|media-video|mime_type=(video|audio)|aweme\\/v1\\/play/i.test(e.name)) {
                out.push({ url: e.name, kind: null, duration: null, width: null, height: null });
              }
            });
          } catch (_) {}
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

  /** 把一条直链流式下载到工作目录临时文件（后续交给 ffmpeg 合成），返回本地路径。
   *  首选 Node 原生 fetch 流式下载：带 Range 续传 + 退避重试 + 无整体超时，
   *  且不经过 Chromium 网络栈（避开「invalid referrer 直接取消请求」和 60s 全局超时）。
   *  万一 Node 侧被拒（少数 CDN 认 TLS 指纹），再回退 Electron net（浏览器同栈）。 */
  async downloadToTemp(url, ext, ctx, label = "媒体") {
    const file = path.join(
      this.workDir,
      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
    );
    this.onEvent({ type: "status", msg: `正在下载${label}流……` });
    const headers = this.buildHeaders(ctx, url);
    try {
      await streamDownload(url, file, {
        headers,
        isCancelled: () => this.isCancelled(),
        onEvent: (p) => this.onEvent({ type: "progress", ...p }),
      });
      this.onLog({ level: "info", msg: `${label}流下载完成：${file}` });
      return file;
    } catch (e) {
      this.onLog({
        level: "warn",
        msg: `${label}流 Node 下载失败（${e && e.message}），改用浏览器网络栈重试`,
      });
    }
    await this.downloadViaNet(url, file + ".part", {
      headers,
      onProgress: (p) =>
        this.onEvent({ type: "progress", percent: p.percent || 0 }),
    });
    fs.renameSync(file + ".part", file);
    return file;
  }

  /** Electron net 流式下载到 dest：自动跟随重定向；超时/4xx 明确报错，不装死 */
  downloadViaNet(url, dest, { headers = {}, onProgress = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (!settled) {
          settled = true;
          fn(v);
        }
      };
      let req;
      try {
        req = net.request({ url, partition: this.partition, redirect: "follow" });
      } catch (e) {
        return reject(e);
      }
      for (const [k, v] of Object.entries(headers)) {
        try {
          req.setHeader(k, String(v));
        } catch (_) {}
      }
      const timer = setTimeout(() => {
        try {
          req.abort();
        } catch (_) {}
        done(
          reject,
          new Error("下载超时（网络卡住或被重置）：" + url.slice(0, 100)),
        );
      }, 60000);
      const ws = fs.createWriteStream(dest);
      ws.on("error", (e) => {
        clearTimeout(timer);
        done(reject, e);
      });
      req.on("response", (res) => {
        if (res.statusCode >= 400) {
          clearTimeout(timer);
          try {
            req.abort();
          } catch (_) {}
          try {
            res.resume();
          } catch (_) {}
          return done(
            reject,
            new Error(
              `HTTP ${res.statusCode}：直链可能已过期，回浏览器窗口把视频再播一下刷新签名后重试`,
            ),
          );
        }
        const total = Number(res.headers["content-length"] || 0) || 0;
        let got = 0;
        let lastTick = 0;
        res.on("data", (chunk) => {
          got += chunk.length;
          const now = Date.now();
          if (now - lastTick > 400) {
            lastTick = now;
            onProgress({ percent: total ? (got / total) * 100 : 0, loaded: got, total });
          }
        });
        res.on("error", (e) => {
          clearTimeout(timer);
          done(reject, e);
        });
        res.pipe(ws);
        ws.on("finish", () => {
          clearTimeout(timer);
          onProgress({ percent: 100, loaded: got, total });
          done(resolve, { size: got });
        });
      });
      req.on("error", (e) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch (_) {}
        done(reject, e);
      });
      req.end();
    });
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
    // 声音流判定：探测确有声音轨最准；探测失败时，content-type / URL 里的
    // media-audio 特征也算数（之前探测一失败声音流就被两边都丢弃，导致成品无声）
    const audioList = probed.filter(
      (c) =>
        c.hasVideo !== true &&
        (c.hasAudio === true ||
          c.kind === "audio" ||
          /^audio\//i.test(String(c.type || "")) ||
          /media-audio|mime_type=audio/i.test(c.url)),
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
      "画面",
    );
    this.onEvent({ type: "status", msg: "画面流已下载，正在处理声音……" });

    if (chosen.hasAudio) return await this.publishDirect(vFile);

    const audio = audioList[0];
    if (!audio) {
      this.onEvent({
        type: "status",
        msg: "没抓到独立声音流，直接输出画面（可能无声音）。若要声音：回浏览器窗口让视频出声播放几秒后重试",
      });
      return await this.publishDirect(vFile);
    }
    const aFile = await this.downloadToTemp(
      audio.url,
      extFromContentType(audio.type) || ".m4a",
      ctx,
      "声音",
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
          // ffmpeg 的 -headers 要求每个头都以 CRLF 结尾（包括最后一个），
          // 缺结尾 CRLF 会让 Cookie 头与 ffmpeg 内置头粘连、被 CDN 判 403。
          const headerStr =
            Object.entries(this.buildHeaders(ctx, m.url))
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n") + "\r\n";
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
        this.onLog({
          level: "info",
          msg: `候选流探测：${fmtDuration(info.duration)} · ${
            info.width ? info.width + "x" + info.height : "分辨率未知"
          } · 画面=${info.hasVideo ? "有" : "?"} 声音=${info.hasAudio ? "有" : "?"}`,
        });
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

  /** 收集站点会话上下文：Cookie（含 cf_clearance）+ UA + Referer，用于重发请求
   *  注意：Cookie 按域隔离，短链域（v.douyin.com）取不到 www 域的 Cookie，
   *  所以优先用浏览器窗口当前真实地址（短链 302 之后的落地页）。 */
  async collectContext(pageUrl) {
    let url = pageUrl;
    try {
      if (this.viewWc && !this.viewWc.isDestroyed()) {
        const cur = this.viewWc.getURL();
        if (cur && /^https?:/i.test(cur)) url = cur;
      }
    } catch (_) {
      /* ignore */
    }
    let cookies = "";
    try {
      const list = await this.ses.cookies.get({ url });
      cookies = list.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch (_) {
      /* ignore */
    }
    const ua =
      this.viewWc && !this.viewWc.isDestroyed()
        ? this.viewWc.getUserAgent()
        : "";
    return { cookies, ua, referer: normalizeReferer(url) || url, extra: this.externalHeaders || {} };
  }

  /** 组装重发请求的标准头 */
  buildHeaders(ctx, url) {
    return {
      "User-Agent": ctx.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: normalizeReferer(ctx.referer) || url,
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
  async fallbackEdgePlay(segUrls, ctx, expectedDuration = null) {
    if (segUrls.length === 0)
      throw new Error("既没抓到 m3u8 也没有分片，请检查视频是否在播放");
    // 爱奇艺：所有「分片」是同一个 .ts 文件的字节区间（/videos/v1ts/ 路径 + start/end 参数），
    // 必须原始字节拼接成整片再转封装，不能走 m3u8/concat 分离器（区间中段不是独立可解文件）。
    if (segUrls.some((u) => /\/videos\/v1ts\//.test(String(u))))
      return this.iqiyiByteRangeMerge(segUrls, ctx, expectedDuration);

    // 爱奇艺分片 URL 自带 start 字节偏移：必须按 start 排序，捕获顺序不等于播放顺序
    const startOf = (u) => {
      const m = /[?&]start=(\d+)/.exec(String(u));
      return m ? Number(m[1]) : NaN;
    };
    const ordered = [...segUrls].sort((a, b) => {
      const sa = startOf(a);
      const sb = startOf(b);
      if (Number.isNaN(sa) && Number.isNaN(sb)) return 0;
      if (Number.isNaN(sa)) return 1;
      if (Number.isNaN(sb)) return -1;
      return sa - sb;
    });
    this.onEvent({ type: "edge-play", count: ordered.length });
    const jobs = ordered.map((u, i) => ({
      uri: u,
      fileName: `seg_${String(i).padStart(6, "0")}.ts`,
      seq: i,
    }));
    const { results } = await downloader.downloadSegments(jobs, {
      outDir: this.workDir,
      headers: this.buildHeaders(ctx, ordered[0]),
      concurrency: this.concurrency,
      onProgress: (p) => this.onEvent({ type: "progress", ...p }),
    });
    const ok = results.filter((r) => r && r.ok).sort((a, b) => a.seq - b.seq);
    return this.merge(ok);
  }

  /** 爱奇艺「单文件字节区间」合并：
   *  播放器把同一个 .ts 文件按 start/end 字节区间拉取，重拉后按 start 顺序原始字节拼接即为整片。
   *  不能用 m3u8/concat 分离器（区间中段从 TS 包中间开始，不是独立可解文件）。 */
  async iqiyiByteRangeMerge(segUrls, ctx, expectedDuration = null) {
    const startOf = (u) => {
      const m = /[?&]start=(\d+)/.exec(String(u));
      return m ? Number(m[1]) : NaN;
    };
    const ordered = [...segUrls].sort((a, b) => {
      const sa = startOf(a);
      const sb = startOf(b);
      if (Number.isNaN(sa) && Number.isNaN(sb)) return 0;
      if (Number.isNaN(sa)) return 1;
      if (Number.isNaN(sb)) return -1;
      return sa - sb;
    });
    this.onEvent({ type: "edge-play", count: ordered.length });
    this.onLog({
      level: "info",
      msg: "爱奇艺字节区间模式：按 start 排序后重拉分片，再原始字节拼接",
    });
    const jobs = ordered.map((u, i) => ({
      uri: u,
      fileName: `raw_${String(i).padStart(6, "0")}.ts`,
      seq: i,
    }));
    const { results } = await downloader.downloadSegments(jobs, {
      outDir: this.workDir,
      headers: this.buildHeaders(ctx, ordered[0]),
      concurrency: this.concurrency,
      onProgress: (p) => this.onEvent({ type: "progress", ...p }),
    });

    // 逐文件校验：过期签名/调度接口会返回小体积 JSON/HTML 文本，必须剔除
    const mediaFiles = [];
    for (const r of results) {
      if (!r || !r.ok || !r.local) continue;
      try {
        const buf = Buffer.alloc(64);
        const fd = fs.openSync(r.local, "r");
        fs.readSync(fd, buf, 0, 64, 0);
        fs.closeSync(fd);
        const head = buf.toString("utf8").trimStart();
        if (head.startsWith("{") || head.startsWith("<")) {
          this.onLog({
            level: "info",
            msg: `丢弃非媒体响应（${path.basename(r.local)} 开头是 JSON/HTML，可能签名过期）`,
          });
          continue;
        }
      } catch (_) {
        /* 读不到头就当媒体文件交给 ffmpeg 判 */
      }
      mediaFiles.push(r.local);
    }
    if (mediaFiles.length === 0)
      throw new Error(
        "分片下载后全是错误响应（签名可能过期）。请回到浏览器窗口刷新页面、让视频重新播放后，再点一次下载。",
      );

    // 原始字节顺序拼接（同一次 HTTP 响应内的字节序即文件字节序）
    const mergedTs = path.join(this.workDir, "full.ts");
    const out = fs.createWriteStream(mergedTs);
    for (const f of mediaFiles) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(f);
        rs.on("error", reject);
        out.on("error", reject);
        rs.pipe(out, { end: false });
        rs.on("end", resolve);
      });
    }
    await new Promise((resolve) => out.end(resolve));
    this.onLog({
      level: "info",
      msg: `拼接完成：${mediaFiles.length} 段 → ${fs.statSync(mergedTs).size} 字节`,
    });

    // 时长校验：拼出的整片明显短于页面时长 = 分片没抓全，提示拖进度条而不是产出残缺文件
    if (this.ffmpegPath) {
      const dur = await ffmpeg.probeDuration(this.ffmpegPath, mergedTs, {
        onLine: () => {},
      });
      this.onLog({
        level: "info",
        msg: `拼接后整片时长：${dur ? Math.round(dur) + " 秒" : "未知"}` +
          (expectedDuration ? `（页面视频 ${Math.round(expectedDuration)} 秒）` : ""),
      });
      if (dur && expectedDuration && dur < expectedDuration * 0.85) {
        throw new Error(
          `分片没抓全（拼出 ${Math.round(dur)} 秒 / 正片约 ${Math.round(
            expectedDuration,
          )} 秒）。请在浏览器窗口里把进度条从最开头拖到最末尾拖一遍（每个位置停 1~2 秒），等分片数不再涨后再点下载。`,
        );
      }
    }

    const outFile = path.join(this.downloadDir, `video_${Date.now()}.mp4`);
    this.onEvent({ type: "merge-start", file: outFile });
    await ffmpeg.remuxTs(this.ffmpegPath, mergedTs, outFile, {
      onLine: (l) => this.onLog({ level: "info", msg: l.trim() }),
    });
    this.onEvent({ type: "merge-done", file: outFile });
    return outFile;
  }

  /** 读取页面 <video> 的时长（秒），用于校验边播边存拼出的整片是否完整 */
  async getPageDuration() {
    if (!this.viewWc || this.viewWc.isDestroyed()) return null;
    try {
      const d = await this.viewWc.executeJavaScript(
        `(() => { let best = 0; document.querySelectorAll('video').forEach(v => { if (Number.isFinite(v.duration) && v.duration > best) best = v.duration; }); return best; })()`,
        true,
      );
      return d && d > 0 ? d : null;
    } catch (_) {
      return null;
    }
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

/** 爱奇艺调度接口判定：pcw-data.video.iqiyi.com 的 .ts URL 返回 JSON（CDN 节点列表），不是媒体内容 */
function isIqiyiScheduler(u) {
  return /pcw-data\.video\.iqiyi\.com/i.test(String(u || ""));
}

/** 爱奇艺广告分片判定：只对爱奇艺/71edge 特征 URL 生效，避免误伤其它站。
 *  正片：/videos/v1ts/ 路径、.ts、qd_tvid 非空；广告：/videos/other/、.f4v、qd_tvid 为空。 */
function isIqiyiAd(u) {
  const s = String(u || "");
  if (!/iqiyi|71edge|qd_tvid|\/videos\/v1ts\//i.test(s)) return false;
  if (/\/videos\/other\//i.test(s)) return true;
  if (/\.f4v(\?|$)/i.test(s)) return true;
  if (!/[?&]qd_tvid=[^&]/.test(s)) return true;
  return false;
}

/** content-type → 弱提示「video / audio」：只作探测失败时的兜底，不作为最终判定 */
function ctKind(ct) {
  const s = String(ct || "");
  if (/^video\//i.test(s)) return "video";
  if (/^audio\//i.test(s)) return "audio";
  return null;
}

/** URL 特征判断抖音 DASH 流是画面还是声音（content-type 不可靠时的依据）：
 *  画面流路径含 media-video / 参数 mime_type=video；声音流含 media-audio / mime_type=audio */
function mediaKindFromUrl(url) {
  const s = String(url || "");
  if (/media-audio|mime_type=audio|\/media-audio-/i.test(s)) return "audio";
  if (
    /media-video|mime_type=video|douyinvod|aweme\/v1\/play|video_id=/i.test(s)
  )
    return "video";
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
  return /aweme\/v1\/play|douyinvod|mime_type=(video|audio)|video_id=|media-(video|audio)/i.test(
    url,
  );
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
