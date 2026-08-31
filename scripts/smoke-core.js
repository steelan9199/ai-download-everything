#!/usr/bin/env node
"use strict";
/**
 * 核心管线冒烟测试（不依赖 Electron，纯 Node 即可跑）：
 *   [1] m3u8 解析（含 AES key）——离线验证解析器
 *   [2] 真实公测流：下载播放列表 → 并发下分段 → 本地化 m3u8 → ffmpeg 合并 → 报时长/体积
 * 用途：装完依赖后，先跑它确认核心链路是通的，再跑完整 UI / 难站。
 * 运行： node scripts/smoke-core.js
 * 可选环境变量：DEMO_SEG=12（只下多少段，默认 12）；FFMPEG_PATH（指定 ffmpeg 路径）
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import * as hls from "../electron/core/hls.js";
import * as http from "../electron/core/http.js";
import * as downloader from "../electron/core/downloader.js";
import * as ffmpeg from "../electron/core/ffmpeg.js";

const outDir = path.join(os.tmpdir(), "ai-video-downloader-demo");
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

async function hasFfmpeg() {
  try {
    await ffmpeg.runSpawn(ffmpegPath, ["-version"]);
    return true;
  } catch (_) {
    return false;
  }
}

// [1] 离线：解析一段含 AES-128 的 m3u8
async function testParse() {
  const sample = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:0",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001',
    "#EXTINF:6.0,",
    "seg0.ts",
    "#EXTINF:6.0,",
    "seg1.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const p = hls.parsePlaylist(sample);
  const ok =
    p.segments.length === 2 &&
    p.endList === true &&
    p.segments[0].key &&
    p.segments[0].key.method === "AES-128";
  console.log(
    `[1] m3u8 解析(含AES key): ${ok ? "✅ 通过" : "❌ 失败"}  (分段=${p.segments.length} endList=${p.endList})`,
  );
  return ok;
}

// [2] 在线：真实公测流走完整「下载→合并」链路（用公网无害测试流，非任何目标站）
async function testPipeline() {
  const candidates = [
    "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8",
  ];
  let text = null;
  let base = null;
  for (const u of candidates) {
    try {
      const r = await http.getText(u, { timeoutMs: 15000 });
      if (r.status === 200 && r.text.includes("#EXTM3U")) {
        text = r.text;
        base = u;
        break;
      }
    } catch (_) {
      /* try next */
    }
  }
  if (!text) {
    console.log("[2] 端到端: ⚠ 跳过（拿不到公测播放列表，可能断网）");
    return false;
  }

  let parsed = hls.parsePlaylist(text);
  if (hls.isMasterPlaylist(parsed)) {
    const v = hls.pickBestVariant(parsed);
    const subUrl = hls.resolveUri(base, v.uri);
    const sub = await http.getText(subUrl, { timeoutMs: 15000 });
    parsed = hls.parsePlaylist(sub.text);
    base = subUrl;
  }

  const limit = parseInt(process.env.DEMO_SEG || "12", 10);
  const segs = parsed.segments.slice(0, limit).map((s, i) => ({
    uri: hls.resolveUri(base, s.uri),
    fileName: `seg_${String(i).padStart(5, "0")}.ts`,
    duration: s.duration,
    seq: s.seq,
    key: s.key,
  }));

  fs.mkdirSync(outDir, { recursive: true });
  const { allOk, results } = await downloader.downloadSegments(segs, {
    outDir,
    concurrency: 6,
  });
  if (!allOk) {
    console.log("[2] 分片下载: ❌ 部分失败");
    console.log(results.filter((r) => !r.ok)[0]);
    return false;
  }

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:" + Math.ceil(parsed.targetDuration || 6),
  ];
  for (const s of segs)
    lines.push("#EXTINF:" + (s.duration || 6).toFixed(3) + ",", s.fileName);
  lines.push("#EXT-X-ENDLIST");
  const pl = path.join(outDir, "local.m3u8");
  fs.writeFileSync(pl, lines.join("\n") + "\n");

  const outFile = path.join(outDir, "demo.mp4");
  await ffmpeg.mergePlaylist(ffmpegPath, pl, outFile, { onLine: () => {} });
  const dur = await ffmpeg.probeDuration(ffmpegPath, outFile);
  const size = fs.statSync(outFile).size;
  console.log(
    `[2] 端到端下载→合并: ✅ 通过  (分片=${segs.length} 大小=${(size / 1024 / 1024).toFixed(2)}MB 时长=${dur ? dur.toFixed(1) + "s" : "?"})`,
  );
  console.log(`    产物: ${outFile}`);
  return true;
}

(async () => {
  console.log("=== AI 视频下载器 · 核心管线冒烟测试 ===");
  console.log("ffmpeg 路径: " + ffmpegPath);
  await testParse();
  if (await hasFfmpeg()) await testPipeline();
  else
    console.log(
      "[2] 端到端: ❌ 未检测到 ffmpeg，请先安装并加入 PATH 或设置 FFMPEG_PATH",
    );
  console.log("=== 完成 ===");
})();
