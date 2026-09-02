const { app, BrowserWindow, session } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "iqiyi-probe-result.json");
const TARGET = "https://sports.iqiyi.com/resource/pcw/play/giqcbm8h24";
const PARTITION = "persist:download-browser";

const m3u8 = new Set();
const segs = new Set();
const media = new Set();
const allMediaish = [];

function log(...a) {
  try {
    fs.appendFileSync(OUT + ".log", a.join(" ") + "\n");
  } catch (_) {}
  console.log(...a);
}

app.whenReady().then(async () => {
  fs.writeFileSync(OUT, "");
  const ses = session.fromPartition(PARTITION);

  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (d, cb) => {
    const u = d.url;
    if (/\.m3u8(\?|$)/i.test(u)) {
      if (!m3u8.has(u)) { m3u8.add(u); log("[M3U8]", u); }
    } else if (/\.(ts|m4s|mp4|key|flv)(\?|$)/i.test(u)) {
      if (!segs.has(u)) { segs.add(u); log("[SEG]", u.slice(0, 160)); }
    }
    cb({});
  });

  ses.webRequest.onHeadersReceived({ urls: ["*://*/*"] }, (d, cb) => {
    const h = d.responseHeaders || {};
    const ct = String(h["content-type"] || h["Content-Type"] || "").toLowerCase();
    if (/^video\/|^audio\/|mpegurl|mp2t|octet-stream/.test(ct)) {
      const key = d.url + " || " + ct;
      if (!media.has(key)) {
        media.add(key);
        allMediaish.push({ url: d.url, ct });
        log("[MEDIA]", ct, d.url.slice(0, 160));
      }
    }
    cb({});
  });

  const win = new BrowserWindow({
    width: 1200, height: 820, show: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });

  win.webContents.on("did-navigate", (_e, u) => log("[NAV]", u));
  win.webContents.on("did-fail-load", (_e, code, desc, u) => log("[FAIL]", code, desc, u));

  async function autoplay() {
    try {
      await win.webContents.executeJavaScript(
        `(() => {
          const vs = document.querySelectorAll('video');
          let acted = false;
          vs.forEach(v => { try { v.muted = true; v.play && v.play(); acted = true; } catch(e){} });
          const btns = document.querySelectorAll('button,[class*=play],[class*=Play]');
          btns.forEach(b => { try { b.click(); } catch(e){} });
          return { videos: vs.length, acted };
        })()`,
        true,
      ).then((r) => log("[AUTOPLAY]", JSON.stringify(r))).catch(() => {});
    } catch (_) {}
  }

  async function grabPageMedia() {
    try {
      const items = await win.webContents.executeJavaScript(
        `(() => {
          const out = [];
          document.querySelectorAll('video,audio').forEach(el => {
            const s = el.currentSrc || el.src;
            if (s) out.push({ tag: el.tagName, src: s, dur: el.duration, w: el.videoWidth, h: el.videoHeight, paused: el.paused });
          });
          return out;
        })()`,
        true,
      );
      log("[PAGE-MEDIA]", JSON.stringify(items, null, 2));
      return items;
    } catch (e) {
      log("[PAGE-MEDIA-ERR]", String(e));
      return [];
    }
  }

  log("[LOAD]", TARGET);
  await win.loadURL(TARGET).catch((e) => log("[LOAD-ERR]", String(e)));

  // 分几次尝试自动播放 + 抓 <video> 地址（总时长约 35s）
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const wait of [5000, 6000, 7000, 8000, 9000]) {
    await sleep(wait);
    await autoplay();
    await grabPageMedia();
    log("---- tick ----  m3u8=" + m3u8.size + " segs=" + segs.size + " media=" + allMediaish.length);
  }

  const result = {
    target: TARGET,
    finalUrl: win.webContents.getURL(),
    m3u8: [...m3u8],
    segCount: segs.size,
    segSample: [...segs].slice(0, 10),
    media: allMediaish.slice(0, 40),
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  log("[DONE] m3u8=" + m3u8.size + " segs=" + segs.size + " media=" + allMediaish.length);
  app.quit();
});

setTimeout(() => { try { app.exit(2); } catch (_) {} }, 70000);
