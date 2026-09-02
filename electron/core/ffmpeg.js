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

/** 探测远程/本地媒体元信息：时长、分辨率、是否含声音（点选候选流前展示用）。
 *  带 headers 过防盗链；-t 1 只读约 1 秒即退出，避免把整片下下来。
 */
export async function probeMedia(
  ffmpegPath,
  input,
  { headers = "", timeLimitMs = 15000, onLine = () => {} } = {},
) {
  // -rw_timeout：网络 I/O 超时（微秒），8 秒没数据 ffmpeg 自己退出，
  // 避免 CDN 静默丢连接时 ffmpeg 干等（外层还有 timeLimitMs 进程级兜底）
  const args = ["-hide_banner", "-y", "-rw_timeout", "8000000"];
  if (headers) args.push("-headers", headers);
  args.push("-i", input, "-t", "1", "-c", "copy", "-f", "null", "-");
  let stderr = "";
  try {
    const r = await runSpawn(ffmpegPath, args, {
      onLine: (chunk) => {
        stderr += chunk;
        onLine(chunk);
      },
      timeLimitMs,
    });
    stderr += r.stderr || "";
  } catch (e) {
    stderr += (e && e.message) || "";
  }
  return parseProbe(stderr);
}

function parseProbe(stderr) {
  const out = {
    duration: null,
    width: null,
    height: null,
    hasVideo: false,
    hasAudio: false,
  };
  const d = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
  if (d)
    out.duration =
      parseInt(d[1], 10) * 3600 + parseInt(d[2], 10) * 60 + parseFloat(d[3]);
  out.hasVideo = /Stream #0:\d+[^\n]*Video:/.test(stderr);
  out.hasAudio = /Stream #0:\d+[^\n]*Audio:/.test(stderr);
  const res = /Video:[^\n]*?\s(\d{2,5})x(\d{2,5})[\s,]/i.exec(stderr);
  if (res) {
    out.width = parseInt(res[1], 10);
    out.height = parseInt(res[2], 10);
  }
  return out;
}

/** 单个完整 TS 文件转封装为 mp4（爱奇艺字节区间拼接后的整片用）。
 *  先 -c copy 直封；部分 TS 的 AAC 流缺采样率字段会导致直封失败，此时只重编码音频、视频仍 copy。 */
export async function remuxTs(
  ffmpegPath,
  inputTs,
  outputFile,
  { onLine = () => {} } = {},
) {
  const common = ["-y", "-i", inputTs, "-movflags", "+faststart"];
  try {
    await runSpawn(ffmpegPath, [...common, "-c", "copy", outputFile], {
      onLine,
    });
  } catch (e) {
    onLine(
      "直接封装失败（常见于音频流缺采样率），改为音频重编码重试：" +
        String((e && e.message) || e).split("\n")[0],
    );
    await runSpawn(
      ffmpegPath,
      [
        ...common,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-b:a",
        "128k",
        outputFile,
      ],
      { onLine },
    );
  }
  return outputFile;
}

/** 音视频双流合成：纯画面 + 纯声音 → 一个 mp4（-c copy 不重编码，秒级无损） */
export async function mergeAV(
  ffmpegPath,
  videoFile,
  audioFile,
  outputFile,
  { onLine = () => {} } = {},
) {
  const args = [
    "-y",
    "-i",
    videoFile,
    "-i",
    audioFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputFile,
  ];
  await runSpawn(ffmpegPath, args, { onLine });
  return outputFile;
}
