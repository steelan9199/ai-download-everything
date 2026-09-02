"use strict";
/**
 * 快手适配器（纯代码，不花 token）
 *
 * 为什么能纯 HTTP 搞定：
 *  快手分享短链（v.kuaishou.com/xxxx）会 302 跳到
 *  https://www.kuaishou.com/short-video/<photoId>?...，这个页面的 HTML 里
 *  直接内嵌了 window.__APOLLO_STATE__，其中 VisionVideoDetailPhoto:<photoId>
 *  带有：
 *    - photoUrl      ：H.264 完整 mp4 直链（CDN 支持 Range，不强制 Cookie/Referer）
 *    - photoH265Url  ：H.265 版本（兜底）
 *    - caption/duration/id 等元信息
 *  而 /graphql 接口有滑块反爬（result 400002），绝不能依赖。
 *
 * 兜底：个别情况下 HTML 是验证页（没有 Apollo 数据），就弹内嵌浏览器窗口，
 * 真人过一下滑块/登录，程序从页面 JS 上下文（__APOLLO_STATE__ / <video>.src）
 * 和网络拦截里取回直链，再走同一个流式下载。
 */
import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 是否快手链接（短链 / 网页版 / chenzhongtech 跳转域都算） */
export function match(url) {
  let host = "";
  try {
    host = new URL(url).host;
  } catch (_) {
    return false;
  }
  return /(?:^|\.)(kuaishou\.com|chenzhongtech\.com|kwai\.com)$/i.test(host);
}

/**
 * 适配器主入口：解析直链 → 流式下载到下载目录，返回成品文件路径。
 * @param {object} opts { url, settings, askUser, onEvent, onLog, cancelToken }
 */
export async function download(opts = {}) {
  const { url, settings, askUser, onEvent = () => {}, onLog = () => {} } = opts;
  const downloadDir = settings.downloadDir;
  const isCancelled = () =>
    !!(opts.cancelToken && opts.cancelToken.cancelled);

  onEvent({ type: "status", msg: "快手链接：正在解析视频直链……" });

  // ① 首选：纯 HTTP 解析页面内嵌的 Apollo 数据（不开浏览器、不花 token）
  let info = null;
  try {
    info = await resolveViaHttp(url, onLog);
    onLog({ level: "info", msg: "已从页面解析到快手视频直链" });
  } catch (e) {
    onLog({
      level: "info",
      msg: "纯 HTTP 解析没拿到直链（" + (e && e.message) + "），转内嵌浏览器兜底",
    });
  }

  // ② 兜底：内嵌浏览器，真人过验证后从页面/网络里取直链
  if (!info) {
    info = await resolveViaBrowser(url, { askUser, onEvent, onLog, isCancelled });
  }
  if (!info || !info.videoUrl) {
    throw new Error(
      "没能从快手页面解析出视频地址（可能是图文/直播内容，或页面要求登录且未完成验证）",
    );
  }

  onLog({
    level: "info",
    msg:
      "视频：" +
      (info.caption || info.id || "未知标题") +
      (info.duration ? `（${fmtDuration(info.duration / 1000)}）` : ""),
  });
  onLog({ level: "info", msg: "直链：" + info.videoUrl.slice(0, 120) + "…" });

  // ③ 流式下载（带进度、断点续传、重试），成品用视频文案命名
  const baseName = safeFileName(info.caption || `kuaishou_${info.id || "video"}`);
  const outFile = uniquePath(path.join(downloadDir, baseName + ".mp4"));
  onEvent({ type: "status", msg: "开始下载快手视频……" });
  await streamDownload(info.videoUrl, outFile, {
    headers: buildHeaders(info),
    onEvent,
    isCancelled,
  });

  onEvent({ type: "direct-done", file: outFile });
  return outFile;
}

/* ------------------------------------------------------------------ */
/* 路径一：纯 HTTP 解析                                                 */
/* ------------------------------------------------------------------ */

/**
 * 跟随短链跳转并抓最终页面 HTML，解析 __APOLLO_STATE__ 里的视频信息。
 * @returns {videoUrl,caption,duration,id,pageUrl,cookies,ua}
 */
export async function resolveViaHttp(inputUrl, onLog = () => {}) {
  const jar = new Map();
  const { url: pageUrl, html } = await fetchPage(inputUrl, jar);

  const photo = extractPhotoFromHtml(html);
  if (!photo) {
    // 没拿到 = 撞验证页/登录墙（HTML 里没有 Apollo 数据）
    throw new Error("页面里没有视频数据（疑似滑块验证/登录墙）");
  }
  onLog({ level: "info", msg: "解析页面：" + pageUrl.slice(0, 90) });
  return {
    videoUrl: normalizeUrl(photo.photoUrl),
    h265Url: normalizeUrl(photo.photoH265Url),
    caption: photo.caption || "",
    duration: Number(photo.duration) || null,
    id: photo.id || null,
    pageUrl,
    cookies: jarHeader(jar),
    ua: UA,
  };
}

/** 手动跟随 3xx（收集 Set-Cookie），返回最终页面 HTML */
async function fetchPage(inputUrl, jar) {
  let url = inputUrl;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Cookie: jarHeader(jar),
      },
    });
    // 收集 cookie（Node 18+ 的 getSetCookie）
    const sc =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    for (const c of sc) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m) jar.set(m[1].trim(), m[2]);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      res.body?.cancel?.();
      if (!loc) throw new Error("跳转缺少 Location");
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`页面请求失败 HTTP ${res.status}`);
    return { url, html: await res.text() };
  }
  throw new Error("重定向次数过多");
}

/** 从页面 HTML 里抽出带 photoUrl 的视频对象（Apollo JSON 解析为主，正则兜底） */
export function extractPhotoFromHtml(html) {
  const apollo = parseApolloState(html);
  if (apollo) {
    const found = [];
    walk(apollo, (o) => {
      if (o && typeof o === "object" && typeof o.photoUrl === "string")
        found.push(o);
    });
    if (found.length) return pickBestPhoto(found);
  }
  // 正则兜底：直接捞 "photoUrl":"..."（值里是 JSON 转义，\u002F 等）
  const m = /"photoUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);
  if (m) {
    const caption = /"caption"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);
    const dur = /"duration"\s*:\s*(\d+)/.exec(html);
    const id = /VisionVideoDetailPhoto:([^"]+)"/.exec(html);
    return {
      photoUrl: jsonUnescape(m[1]),
      caption: caption ? jsonUnescape(caption[1]) : "",
      duration: dur ? Number(dur[1]) : null,
      id: id ? id[1] : null,
    };
  }
  return null;
}

/** 定位 window.__APOLLO_STATE__ = {...} 并做大括号配对后 JSON.parse */
function parseApolloState(html) {
  const marker = "__APOLLO_STATE__";
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const eq = html.indexOf("=", idx);
  const start = html.indexOf("{", eq);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

/** 多个候选时取时长最长的（防御页面里混进广告/预览片段） */
function pickBestPhoto(list) {
  return [...list].sort(
    (a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0),
  )[0];
}

/* ------------------------------------------------------------------ */
/* 路径二：内嵌浏览器兜底（滑块/登录墙）                                  */
/* ------------------------------------------------------------------ */

async function resolveViaBrowser(inputUrl, ctx) {
  const { askUser, onEvent, onLog, isCancelled } = ctx;
  const { BrowserWindow, session } = await import("electron");

  const partition = "persist:download-browser";
  const ses = session.fromPartition(partition);

  // 快手 App 深链（kwai:// 等）注册成空处理器，吞掉「打开此链接的应用」系统弹窗
  for (const scheme of ["kwai", "kuaishou", "kwainebula"]) {
    try {
      ses.protocol.handle(scheme, () => new Response(null, { status: 204 }));
    } catch (_) {
      /* 个别 scheme 注册失败不影响主流程 */
    }
  }

  // 网络拦截兜底：页面播放器/MSE 实际请求的 mp4（按 content-length 取最大的一条）
  const mp4Pool = [];
  const seenMp4 = new Set();
  const filter = { urls: ["*://*/*"] };
  const onHeaders = (details, cb) => {
    try {
      const raw = details.responseHeaders || {};
      const ctArr = raw["content-type"] || raw["Content-Type"] || [];
      const ct = String(Array.isArray(ctArr) ? ctArr[0] || "" : ctArr);
      const lenArr = raw["content-length"] || raw["Content-Length"] || [];
      const len = Number(Array.isArray(lenArr) ? lenArr[0] : lenArr) || 0;
      const looksMp4 =
        /^video\//i.test(ct) ||
        (/kwaicdn|chenzhongtech|yximgs|kwai/.test(details.url) &&
          /\.mp4(\?|$)/i.test(details.url));
      if (looksMp4 && !seenMp4.has(details.url)) {
        seenMp4.add(details.url);
        mp4Pool.push({ url: details.url, len });
        onEvent({ type: "found-media", url: details.url });
      }
    } catch (_) {
      /* ignore */
    }
    cb({});
  };
  ses.webRequest.onHeadersReceived(filter, onHeaders);

  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(inputUrl, { userAgent: UA });

    // 轮询页面 JS 上下文取直链（Apollo 数据 / <video> 地址）
    let info = await pollPageVideo(win, 25000, isCancelled);

    if (!info) {
      const ans = await askUser({
        id: "ks-verify",
        prompt:
          "快手页面需要真人操作一下。请在弹出的浏览器窗口里完成滑块验证/登录（或关闭「打开 App」弹窗），" +
          "等视频能正常播放后，点下面的「已完成」：",
        options: [
          { value: "ready", label: "已完成验证，视频能播放了" },
          { value: "abort", label: "打不开/放弃" },
        ],
      });
      if (ans.choice === "ready")
        info = await pollPageVideo(win, 25000, isCancelled);
    }

    // 网络拦截兜底：页面里取不到（MSE blob 地址）时用抓到的最大 mp4
    if (!info && mp4Pool.length) {
      mp4Pool.sort((a, b) => b.len - a.len);
      info = { videoUrl: mp4Pool[0].url };
      onLog({ level: "info", msg: "改用网络拦截到的 mp4 直链" });
    }
    if (!info) return null;

    // 收集会话上下文（Cookie/UA），CDN 虽不强制，带上更稳
    const pageUrl = win.webContents.getURL();
    let cookies = "";
    try {
      const list = await ses.cookies.get({ url: pageUrl });
      cookies = list.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch (_) {
      /* ignore */
    }
    return {
      videoUrl: normalizeUrl(info.videoUrl || info.photoUrl),
      caption: info.caption || "",
      duration: Number(info.duration) || null,
      id: info.id || null,
      pageUrl,
      cookies,
      ua: UA,
    };
  } finally {
    try {
      ses.webRequest.onHeadersReceived(null);
    } catch (_) {
      /* ignore */
    }
    try {
      win.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/** 在页面里反复执行提取脚本，直到拿到视频地址或超时 */
async function pollPageVideo(win, timeoutMs, isCancelled) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCancelled()) return null;
    await sleep(1500);
    if (win.isDestroyed()) return null;
    let got = null;
    try {
      got = await win.webContents.executeJavaScript(
        `(() => {
          const out = {};
          try {
            const ap = window.__APOLLO_STATE__;
            const roots = [];
            if (ap) { roots.push(ap.defaultClient || ap); if (ap.clients) roots.push(ap.clients); }
            const seen = new Set(); let done = false;
            const walk = (o) => {
              if (done || !o || typeof o !== 'object' || seen.has(o)) return;
              seen.add(o);
              if (typeof o.photoUrl === 'string' && /^https?:/.test(o.photoUrl)) {
                out.photoUrl = o.photoUrl;
                out.caption = o.caption || '';
                out.duration = o.duration || null;
                out.id = o.id || null;
                done = true; return;
              }
              for (const k in o) { walk(o[k]); if (done) break; }
            };
            for (const r of roots) { walk(r); if (done) break; }
          } catch (e) {}
          if (!out.photoUrl) {
            const v = document.querySelector('video');
            if (v && v.currentSrc && /^https?:/.test(v.currentSrc)) {
              out.videoUrl = v.currentSrc;
              out.duration = Number.isFinite(v.duration) ? v.duration * 1000 : null;
            }
          }
          return out;
        })()`,
        true,
      );
    } catch (_) {
      /* 页面还在跳转/刷新，继续轮询 */
    }
    if (got && (got.photoUrl || got.videoUrl)) return got;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 流式下载（进度 / 断点续传 / 重试）                                     */
/* ------------------------------------------------------------------ */

/**
 * 下载到大文件：先写 .part，支持 Range 续传，完成后原子改名。
 * 进度事件与 yt-dlp 引擎同形：{type:'progress', percent, speed, eta}
 */
export async function streamDownload(url, destFile, opts = {}) {
  const headers = opts.headers || {};
  const onEvent = opts.onEvent || (() => {});
  const isCancelled = opts.isCancelled || (() => false);
  const partFile = destFile + ".part";
  const maxRetries = 3;
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (isCancelled()) throw new Error("已取消下载");
    let resumeFrom = 0;
    try {
      if (fs.existsSync(partFile)) resumeFrom = fs.statSync(partFile).size;
    } catch (_) {
      resumeFrom = 0;
    }
    try {
      const reqHeaders = {
        "User-Agent": headers["User-Agent"] || UA,
        Accept: "*/*",
        ...headers,
      };
      if (resumeFrom > 0) reqHeaders.Range = `bytes=${resumeFrom}-`;

      const res = await fetch(url, {
        method: "GET",
        headers: reqHeaders,
        redirect: "follow",
      });
      if (!res.ok && res.status !== 206)
        throw new Error(`HTTP ${res.status} for ${url}`);

      // 200 = 服务器无视 Range（或全新下载）；206 = 续传
      const total = parseTotal(res, resumeFrom);
      const append = res.status === 206 && resumeFrom > 0;
      if (!append) resumeFrom = 0;

      const ws = fs.createWriteStream(partFile, { flags: append ? "a" : "w" });
      let loaded = resumeFrom;
      let lastTick = Date.now();
      let lastBytes = loaded;

      const reader = res.body.getReader();
      for (;;) {
        if (isCancelled()) {
          try {
            reader.cancel();
            ws.destroy();
          } catch (_) {}
          throw new Error("已取消下载");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await new Promise((resolve, reject) =>
            ws.write(value, (e) => (e ? reject(e) : resolve())),
          );
          loaded += value.length;
          const now = Date.now();
          if (now - lastTick >= 500) {
            const speed = ((loaded - lastBytes) / (now - lastTick)) * 1000; // B/s
            onEvent({
              type: "progress",
              percent: total ? Math.min(99, (loaded / total) * 100) : 0,
              speed: fmtSpeed(speed),
              eta:
                total && speed > 0
                  ? fmtEta((total - loaded) / speed)
                  : "",
            });
            lastTick = now;
            lastBytes = loaded;
          }
        }
      }
      await new Promise((resolve, reject) =>
        ws.end((e) => (e ? reject(e) : resolve())),
      );

      // 完整性校验：知道总大小就比对，防止 .part 比实际整片大
      if (total) {
        const got = fs.statSync(partFile).size;
        if (got < total) throw new Error(`下载不完整（${got}/${total} 字节）`);
      }
      fs.renameSync(partFile, destFile);
      onEvent({ type: "progress", percent: 100, speed: "", eta: "" });
      return destFile;
    } catch (e) {
      lastErr = e;
      if (isCancelled()) throw e;
      await sleep(800 * (attempt + 1)); // 退避后靠 .part 断点续传
    }
  }
  throw lastErr || new Error("下载失败");
}

/** 从 Content-Range / Content-Length 算出整片总字节数 */
function parseTotal(res, resumeFrom) {
  const cr = res.headers.get("content-range");
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) return Number(m[1]);
  }
  const cl = Number(res.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > 0) {
    return res.status === 206 ? resumeFrom + cl : cl;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

function buildHeaders(info) {
  return {
    "User-Agent": info.ua || UA,
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: info.pageUrl || "https://www.kuaishou.com/",
    ...(info.cookies ? { Cookie: info.cookies } : {}),
  };
}

function jarHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 协议相对地址补 https；JSON 转义还原 */
function normalizeUrl(u) {
  if (!u) return null;
  let s = String(u);
  if (s.startsWith("//")) s = "https:" + s;
  return s;
}

function jsonUnescape(s) {
  try {
    return JSON.parse('"' + s + '"');
  } catch (_) {
    return String(s).replace(/\\u002F/gi, "/");
  }
}

function walk(o, fn, seen = new Set()) {
  if (!o || typeof o !== "object" || seen.has(o)) return;
  seen.add(o);
  fn(o);
  if (Array.isArray(o)) for (const v of o) walk(v, fn, seen);
  else for (const k of Object.keys(o)) walk(o[k], fn, seen);
}

/** 文案 → 合法 Windows 文件名（去掉 \ / : * ? " < > | 和控制符，折叠空白） */
function safeFileName(name) {
  let s = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (!s) s = "kuaishou_video";
  return s.slice(0, 80);
}

/** 目标文件已存在时加 (2)/(3)… 避免覆盖 */
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

function fmtSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "";
  if (bytesPerSec >= 1024 * 1024)
    return (bytesPerSec / 1024 / 1024).toFixed(1) + "MB/s";
  return Math.round(bytesPerSec / 1024) + "KB/s";
}

function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${String(r).padStart(2, "0")}秒` : `${r}秒`;
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "时长未知";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s}秒` : `${m}分${String(s).padStart(2, "0")}秒`;
}
