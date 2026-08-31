"use strict";
/**
 * ffmpeg 调用封装（纯代码）
 * 为什么不内置二进制：严格遵守「绝不把第三方二进制塞进包」，路径一律从设置/自检结果传入。
 * 主路径用「本地 m3u8 交给 ffmpeg 读」：AES 解密、fMP4 init、分段拼接、转封装一步到位，
 * 省掉在 Node 里手写 AES + concat 的复杂度和出错面。
 */
import { spawn } from "node:child_process";

function tail(s, n) {
  return s.length > n ? "..." + s.slice(-n) : s;
}

export function runSpawn(
  bin,
  args,
  { onLine = () => {}, timeLimitMs = 0 } = {},
) {
  return new Promise((resolve, reject) => {
    const cp = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    let stdout = "";
    const timer =
      timeLimitMs > 0
        ? setTimeout(() => {
            try {
              cp.kill("SIGKILL");
            } catch (_) {}
          }, timeLimitMs)
        : null;
    cp.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    cp.stderr.on("data", (d) => {
      stderr += d.toString();
      onLine(d.toString());
    });
    cp.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    cp.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else
        reject(new Error("ffmpeg 退出码 " + code + "\n" + tail(stderr, 2000)));
    });
  });
}

/** 把本地 m3u8（分段/密钥已本地化）合并转封装为 mp4/ts 目标文件 */
export async function mergePlaylist(
  ffmpegPath,
  playlistFile,
  outputFile,
  { onLine = () => {} } = {},
) {
  // -allowed_extensions ALL：允许 key/分段用非标准扩展名（.key/.bin/.m4s 等）
  const args = [
    "-y",
    "-allowed_extensions",
    "ALL",
    "-i",
    playlistFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputFile,
  ];
  await runSpawn(ffmpegPath, args, { onLine });
  return outputFile;
}

/** 纯 TS 裸分段合并（不经过 m3u8）：用 concat demuxer，需要一个列表文件 */
export async function concatList(
  ffmpegPath,
  listFile,
  outputFile,
  { onLine = () => {} } = {},
) {
  const args = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    outputFile,
  ];
  await runSpawn(ffmpegPath, args, { onLine });
  return outputFile;
}

/** 探测媒体时长/流信息：解析 ffmpeg -i 的 stderr，用于 Demo 验证「确实拿到了完整视频」
 *  格式：Duration: 00:01:23.45, start: ...
 */
export async function probeDuration(
  ffmpegPath,
  file,
  { onLine = () => {} } = {},
) {
  const { stderr } = await runSpawn(ffmpegPath, ["-i", file], { onLine }).catch(
    (e) => ({ stderr: e.message }),
  );
  const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}
