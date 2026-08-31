'use strict';
/**
 * yt-dlp 直下引擎（纯代码，不花 token）
 * 覆盖绝大多数普通站（YouTube 等）——拿到 URL 直接交给本地 yt-dlp.exe，事半功倍。
 * 失败时把 stderr 原样交回给 orchestrator，供「规则表」判断要不要切浏览器拦截。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function tail(s, n) { return s.length > n ? '...' + s.slice(-n) : s; }

const MEDIA_EXT = ['.mp4', '.mkv', '.webm', '.ts', '.flv', '.mov', '.avi', '.m4a', '.mp3', '.aac', '.flac'];

/** 在目录里找刚刚产出的媒体文件（--print 没拿到时的兜底） */
function newestMedia(dir, withinMs = 10 * 60 * 1000) {
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (!MEDIA_EXT.includes(path.extname(f).toLowerCase())) continue;
      if (Date.now() - st.mtimeMs > withinMs) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs };
    }
  } catch (_) { /* ignore */ }
  return best ? best.file : null;
}

/**
 * @param {object} opts { ytdlpPath, outputDir, onProgress, onLog, cancel }
 * @returns 结构化结果（不抛错，交给上层路由）
 */
async function download(url, opts = {}) {
  const { ytdlpPath, outputDir, onProgress = () => {}, onLog = () => {} } = opts;
  try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) { return { ok: false, hint: ['DIR'], error: String(e.message || e) }; }

  // 自定义进度模板：DLPROG 前缀便于在 stdout 里与 --print 的输出区分
  const args = [
    '--newline', '--no-warnings', '--no-colors', '--no-playlist',
    // 关键：不显式指定时，中文 Windows 上 yt-dlp 会把 --print/filepath 走 stdout 编码成 GBK，
    // 而这里用 UTF-8 读 d.toString()，导致中文路径变乱码、后续「打开文件夹」报路径无效。
    '--encoding', 'utf-8',
    '--socket-timeout', '15', '--retries', '3',
    '--progress-template', 'download:DLPROG\t%(progress._percent_str)s\t%(progress._speed_str)s\t%(progress._eta_str)s',
    '--print', 'after_move:DLFILE\t%(filepath)s',
    '--merge-output-format', 'mp4',
    '-P', outputDir,
    '--', url
  ];

  const result = { ok: false, output: null, hint: [], stderr: '' };
  await new Promise((resolve) => {
    const cp = spawn(ytdlpPath, args, { windowsHide: true });
    cp.stdout.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.startsWith('DLPROG\t')) {
          const [, p, s, e] = line.split('\t');
          const percent = parseFloat(p);
          if (!Number.isNaN(percent)) onProgress({ percent, speed: s, eta: e });
        } else if (line.startsWith('DLFILE\t')) {
          result.output = line.slice('DLFILE\t'.length).trim();
        }
      }
    });
    cp.stderr.on('data', (d) => { result.stderr += d.toString(); });
    cp.on('error', (e) => { result.error = String(e.message || e); result.hint = ['BIN']; onLog({ level: 'error', msg: 'yt-dlp 启动失败: ' + result.error }); resolve(); });
    cp.on('close', (code) => {
      if (code === 0) {
        result.ok = true;
        if (!result.output) result.output = newestMedia(outputDir);
      } else {
        result.hint = guessHint(result.stderr);
        onLog({ level: 'error', msg: 'yt-dlp 退出码 ' + code + '\n' + tail(result.stderr, 800) });
      }
      resolve();
    });
  });

  if (result.ok) onLog({ level: 'info', msg: 'yt-dlp 完成: ' + result.output });
  return result;
}

/** 从 stderr 里猜失败原因，作为规则表 key（403/cloudflare/m3u8/需要登录等） */
function guessHint(stderr) {
  const s = String(stderr || '');
  const hits = [];
  if (/cloudflare|cf_clearance|bot fight|just a moment/i.test(s)) hits.push('CLOUDFLARE');
  if (/(^|[^0-9])403([^0-9]|$)/.test(s)) hits.push('HTTP403');
  if (/401|login|authenticate|premium/i.test(s)) hits.push('NEED_AUTH');
  if (/\.m3u8|hls|mpegurl/i.test(s)) hits.push('M3U8');
  if (/unable to download|no video formats|unsupported url/i.test(s)) hits.push('NO_FORMATS');
  if (/geo|country/i.test(s)) hits.push('GEO');
  return hits;
}

module.exports = { download, guessHint };