"use strict";
/**
 * 分片并发下载器（纯代码，不花 token）
 * 为什么这样做：
 *  - 并发 = 不依赖播放速度，尽量一次拿全部分段；
 *  - 按「分片粒度」断点续传：完整落盘的 .ts 直接跳过，不重复下载，>1GB 也不会漏/重；
 *  - 先写 .part 再 rename = 原子落盘，避免程序被杀留下半截文件被误判为「已下载」。
 */
import fs from "node:fs";
import path from "node:path";
import * as http from "./http.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {Array} segments  每个 { uri, fileName?, ... }
 * @param {object} opts     { outDir, headers, concurrency, maxRetries, timeoutMs, onProgress }
 */
export async function downloadSegments(segments, opts = {}) {
  const outDir = opts.outDir;
  const headers = opts.headers || {};
  const concurrency = opts.concurrency || 6;
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs || 20000;
  const onProgress = opts.onProgress || (() => {});
  fs.mkdirSync(outDir, { recursive: true });

  const results = new Array(segments.length);
  const errors = [];
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < segments.length) {
      const idx = cursor++;
      const seg = segments[idx];
      const fileName = seg.fileName || `seg_${String(idx).padStart(5, "0")}.ts`;
      const dest = path.join(outDir, fileName);
      try {
        const buf = await downloadOne(seg.uri, dest, {
          headers,
          maxRetries,
          timeoutMs,
        });
        results[idx] = { ...seg, local: dest, ok: true, size: buf.length };
      } catch (e) {
        results[idx] = {
          ...seg,
          local: dest,
          ok: false,
          error: String(e.message || e),
        };
        errors.push({ idx, uri: seg.uri, error: String(e.message || e) });
      }
      done++;
      const okCount = results.filter((r) => r && r.ok).length;
      onProgress({ done, total: segments.length, ok: okCount });
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, Math.max(1, segments.length)); i++)
    workers.push(worker());
  await Promise.all(workers);

  return {
    results,
    errors,
    allOk: results.length > 0 && results.every((r) => r && r.ok),
  };
}

/** 下载单个分段到内存并原子落盘，带重试；已完整存在则跳过（断点续传） */
export async function downloadOne(
  uri,
  dest,
  { headers = {}, maxRetries = 3, timeoutMs = 20000 } = {},
) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return fs.readFileSync(dest); // 已经下完，直接复用
  }
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const buf = await http.getBuffer(uri, { headers, timeoutMs });
      const tmp = dest + ".part";
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      return buf;
    } catch (e) {
      lastErr = e;
      await sleep(300 * (attempt + 1)); // 指数退避，避免 403 时疯狂重试砸站
    }
  }
  throw lastErr || new Error("failed: " + uri);
}
