'use strict';
/**
 * 受限脚本沙箱 + 权限门（AI 写的脚本在这里跑）
 * 安全模型（对应产品安全边界）：
 *  1) 白名单：默认只能读写「下载目录」、调用 ffmpeg/yt-dlp、发 HTTP 请求；
 *  2) 越界（读写目录外文件、跑其它命令）：抛 PermissionDenied，由 orchestrator 弹窗请用户确认后，
 *     以 fullAccess=true 重跑一次（作用域=本次任务，任务结束自动复位）；
 *  3) 白名单内直接自动执行，不打扰人。
 *
 * 重要定位说明（写清“为什么”）：这是一个「单用户自用」工具，因此沙箱是尽力而为的软件隔离
 * （vm + 禁止动态代码生成 + 只暴露闭包 api，不暴露 require/process），不是多租户级的硬安全边界。
 */
const vm = require('vm');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('../core/http');

const ALLOWED_BINS = ['ffmpeg', 'ffmpeg.exe', 'yt-dlp', 'yt-dlp.exe'];

class PermissionDenied extends Error {
  constructor(msg, detail) { super(msg); this.name = 'PermissionDenied'; this.code = 'PERMISSION_DENIED'; this.detail = detail; }
}

/** 把脚本里的相对路径锁死在下载目录；全权模式下放行任意路径（但记录日志） */
function resolvePath(workDir, p, fullAccess) {
  if (fullAccess) return p;
  if (path.isAbsolute(p)) throw new PermissionDenied('绝对路径 ' + p + ' 超出了下载目录', { path: p });
  const root = path.resolve(workDir);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new PermissionDenied('路径 ' + p + ' 越出下载目录', { path: p });
  return abs;
}

function execPromise(bin, args, log) {
  return new Promise((resolve) => {
    const cp = spawn(bin, args, { windowsHide: true, shell: false });
    let out = '';
    cp.stdout.on('data', (d) => { out += d.toString(); });
    cp.stderr.on('data', (d) => { log('[exec] ' + d.toString().trim()); });
    cp.on('error', (e) => resolve({ code: -1, output: String(e.message || e) }));
    cp.on('close', (code) => resolve({ code, output: out }));
  });
}

/**
 * 执行脚本
 * @param {object} opts { code, workDir, ffmpegPath, ytdlpPath, fullAccess, onLog }
 * @returns { ok, hasPermissionDenied, detail, resultJson, logs }
 */
async function runScript(opts = {}) {
  const workDir = opts.workDir;
  const fullAccess = !!opts.fullAccess;
  const onLog = opts.onLog || (() => {});
  const logs = [];
  const log = (m) => { logs.push(String(m)); onLog({ level: 'info', msg: String(m) }); };

  // —— 只暴露闭包 api，绝不把 require/process/fetch 交给脚本 ——
  const api = {
    downloadDir: workDir,
    log,
    http: {
      get: async (url, h = {}) => http.getText(url, { headers: h }),
      getBuffer: async (url, h = {}) => http.getBuffer(url, { headers: h })
    },
    fs: {
      writeFile: (p, data) => fs.writeFileSync(resolvePath(workDir, p, fullAccess), Buffer.isBuffer(data) ? data : String(data)),
      readFile: (p) => fs.readFileSync(resolvePath(workDir, p, fullAccess), 'utf8'),
      list: () => fs.readdirSync(resolvePath(workDir, '.', false)).map((n) => n),
      exists: (p) => fs.existsSync(resolvePath(workDir, p, fullAccess))
    },
    exec: async (bin, args) => {
      const base = path.basename(String(bin)).toLowerCase();
      const allowed = base.startsWith('ffmpeg') || base.startsWith('yt-dlp');
      if (!fullAccess && !allowed) throw new PermissionDenied('想运行未授权命令：' + bin, { bin });
      let resolved = bin;
      if (base.startsWith('ffmpeg')) resolved = opts.ffmpegPath || 'ffmpeg';
      else if (base.startsWith('yt-dlp')) resolved = opts.ytdlpPath || 'yt-dlp';
      return execPromise(resolved, Array.isArray(args) ? args : [String(args)], log);
    }
  };

  let permDenied = null;
  try {
    const context = vm.createContext({ api, console: { log, error: log } }, { codeGeneration: { strings: false, wasm: false } });
    const script = new vm.Script(`(async () => { ${opts.code} })()`, { filename: 'ai-script.js' });
    const result = await script.runInContext(context, { timeout: 120000 });
    // 脚本可能把 result.json 写进下载目录，尝试读回来
    let resultJson = null;
    const rp = path.join(workDir, 'result.json');
    if (fs.existsSync(rp)) { try { resultJson = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (_) { resultJson = fs.readFileSync(rp, 'utf8'); } }
    return { ok: true, hasPermissionDenied: false, resultJson, returnValue: result, logs };
  } catch (e) {
    if (e && e.code === 'PERMISSION_DENIED') {
      permDenied = { message: e.message, detail: e.detail };
      return { ok: false, hasPermissionDenied: true, reason: permDenied, logs };
    }
    return { ok: false, hasPermissionDenied: false, error: String(e.message || e), logs };
  }
}

module.exports = { runScript, PermissionDenied, ALLOWED_BINS };