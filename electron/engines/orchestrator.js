'use strict';
/**
 * 下载调度中枢（orchestrator）
 * 串起产品核心流程：
 *   ① yt-dlp 直下（普通站） → ② 浏览器拦截（难站） → ③ 规则表/规则库 → ④ 人点选 → ⑤ AI 按需写脚本
 * 它自己不下载，只做「决策 + 路由」，把活派给各引擎，把异常按「先查表→再请人→再 AI」的顺序消化。
 */
const fs = require('fs');
const path = require('path');
const ytdlpEngine = require('./ytdlp-engine');
const { BrowserInterceptEngine } = require('./browser-engine');
const rules = require('../knowledge/rules');
const siteRules = require('../knowledge/site-rules');
const advisor = require('../ai/advisor');
const sandbox = require('../ai/sandbox');

/**
 * 统一入口
 * @param {object} opts {
 *   url, engine('auto'|'ytdlp'|'browser'),
 *   settings, tools:{ffmpegPath, ytdlpPath},
 *   askUser({id,prompt,options})->Promise<{choice,custom}>,
 *   onEvent, onLog
 * }
 */
async function download(opts) {
  const { url, engine = 'auto', settings, tools, askUser, onEvent = () => {}, onLog = () => {} } = opts;
  const downloadDir = settings.downloadDir;

  // ① 先查站点规则库：命中已沉淀脚本就复用，零 token
  const rule = siteRules.matchRule(url);
  if (rule && rule.kind === 'script' && rule.script) {
    onEvent({ type: 'status', msg: '命中站点规则库，复用已沉淀脚本（不调大模型）' });
    return runAiScript({ code: rule.script, downloadDir, tools, settings, askUser, onLog, onEvent, isSavedRule: true });
  }

  const useYtdlp = engine === 'auto' || engine === 'ytdlp';
  const useBrowser = engine === 'auto' || engine === 'browser';

  // ② yt-dlp 先试（覆盖绝大多数普通站）
  if (useYtdlp) {
    onEvent({ type: 'status', msg: '先用 yt-dlp 直接下载……' });
    const r = await ytdlpEngine.download(url, {
      ytdlpPath: tools.ytdlpPath, outputDir: downloadDir,
      onProgress: (p) => onEvent({ type: 'progress', percent: p.percent, speed: p.speed, eta: p.eta }),
      onLog
    });
    if (r.ok) return { ok: true, output: r.output, engineUsed: 'yt-dlp' };

    const rl = rules.resolve(r.hint || []);
    if (rl.advice) onEvent({ type: 'guidance', msg: rl.advice });
    if (useBrowser) return tryBrowser(url, opts, r.hint || []);
    return { ok: false, error: `yt-dlp 失败：${rl.advice || '未知原因'}` };
  }

  if (useBrowser) return tryBrowser(url, opts, []);

  return { ok: false, error: '无效引擎：' + engine };
}

/** ② 浏览器拦截引擎 */
async function tryBrowser(url, opts, hint) {
  const { settings, tools, askUser, onEvent, onLog } = opts;
  const eng = new BrowserInterceptEngine({
    partition: 'persist:download-browser',
    downloadDir: settings.downloadDir,
    ffmpegPath: tools.ffmpegPath,
    concurrency: (settings.download || {}).concurrency || 6,
    cancelToken: opts.cancelToken,
    onEvent, askUser, onLog
  });
  try {
    const out = await eng.run(url);
    return { ok: true, output: out, engineUsed: 'browser' };
  } catch (e) {
    eng.close();
    return resolveFailure(url, e, opts);
  }
}

/** ③④⑤ 失败兜底：诊断摘要 → 请人点选 → 按需 AI 写脚本 → 纯人工指引 */
async function resolveFailure(url, err, opts) {
  const { askUser, onEvent, onLog, settings, tools, downloadDir } = opts;
  const msg = String(err && (err.message || err));
  const diagnostic = `URL: ${url}\n出错信息: ${msg}`;
  onEvent({ type: 'diagnostic', msg: diagnostic });

  // 再查一次规则表（浏览器阶段的 403/会话过期等）
  const hint = ytdlpEngine.guessHint(msg);
  const rl = rules.resolve(hint);
  if (rl && rl.advice) onEvent({ type: 'guidance', msg: rl.advice });

  // 请人「看一眼」，点选 + 自定义补充（不抛开放式填空）
  const ans = await askUser({
    id: 'diagnose',
    prompt: '下载没成功。请看一眼窗口/页面，选一个最接近的情况（也可点「其他」补充一两句）：',
    options: [
      { value: 'retry', label: '刚才网络卡了 / 页面没加载完' },
      { value: 'login', label: '需要登录、或验证码没点过' },
      { value: 'play', label: '视频没播放起来' },
      { value: 'ai', label: '都试过了，让 AI 帮忙写脚本重试' }
    ]
  });

  const extra = ans.custom ? ('\n用户补充：' + ans.custom) : '';
  if (ans.choice === 'ai') return aiRescue(url, diagnostic + extra, opts);
  if (ans.choice === 'retry' || ans.choice === 'login' || ans.choice === 'play') {
    return { ok: false, needRetry: true, error: '请回到窗口完成（登录 / 播放 / 刷新）后，再点一次下载。' };
  }
  // 其它：转纯人工指引
  return { ok: false, error: '试了内置办法没成功，建议：用「猫抓/F12」复制 .m3u8 链接粘给程序，或配置 API Key 让 AI 诊断。' };
}

/** ⑤ AI 兜底：问大模型 → 受限沙箱跑脚本 → 成功后沉淀进规则库 */
async function aiRescue(url, context, opts) {
  const { settings, tools, downloadDir, askUser, onEvent, onLog } = opts;
  const aiCfg = settings.ai || {};
  if (!aiCfg.apiKey) return { ok: false, error: '还没配置大模型 API Key，去「设置」页填一下再重试。', engineUsed: 'ai' };

  const host = safeHost(url);
  onEvent({ type: 'status', msg: '正在连大模型分析（按需，只问这一次）……' });

  const ai = await advisor.ask(advisor.buildScriptPrompt({ url, host, diagnostic: context, userDesc: '' }), {
    system: '你是下载器的诊断脚本助手。只输出一段 ```javascript 代码或 SOLUTION_IMPOSSIBLE，不要解释。'
  });
  if (!ai.ok) return { ok: false, error: ai.error, engineUsed: 'ai' };

  const code = extractCode(ai.text);
  if (!code) return { ok: false, error: '大模型判断无法自动解决，请走人工：用猫抓复制 m3u8 链接重试。', engineUsed: 'ai' };

  onEvent({ type: 'status', msg: '拿到脚本，正在受限沙箱里执行……' });
  const res = await runAiScript({ code, downloadDir, tools, settings, askUser, onLog, onEvent });

  if (res.ok) {
    // 脚本沉淀：下次同站直接复用，不再烧 token
    siteRules.sediment({ id: 'ai-' + host, host, match: escapeRegExp(host), kind: 'script', script: code, note: 'AI 自动沉淀 ' + new Date().toISOString() });
    return { ok: true, output: res.output, engineUsed: 'ai', aiCalls: advisor.getCallCount() };
  }
  return { ok: false, error: res.error || 'AI 脚本未成功产出结果', engineUsed: 'ai', aiCalls: advisor.getCallCount() };
}

/** 在受限沙箱里跑一段脚本（站点规则库/AI 共用），处理越界授权 */
async function runAiScript({ code, downloadDir, tools, settings, askUser, onLog, onEvent }) {
  const run = (fullAccess) => sandbox.runScript({
    code, workDir: downloadDir, ffmpegPath: tools.ffmpegPath, ytdlpPath: tools.ytdlpPath,
    fullAccess, onLog
  });

  let res = await run(!!settings.fullAccess);
  if (res.hasPermissionDenied) {
    onEvent({ type: 'guidance', msg: '脚本想越界：' + res.reason.message + ' —— 需要你临时授权（仅本次任务）。' });
    const g = await askUser({
      id: 'grant-full',
      prompt: 'AI 脚本想执行超出白名单的动作：' + (res.reason.message || '') + '\n是否临时授权本机全权（本次任务有效，结束自动恢复）？',
      options: [{ value: 'grant', label: '临时授权，继续执行' }, { value: 'deny', label: '拒绝，中止' }]
    });
    if (g.choice !== 'grant') return { ok: false, error: '已拒绝越界授权，任务中止' };
    res = await run(true);
  }
  if (!res.ok) return { ok: false, error: res.error || res.reason?.message || '脚本执行失败' };

  const output = pickOutput(res.resultJson, downloadDir);
  if (!output) return { ok: false, error: '脚本跑完了但没写下明确产物，请看下载目录。' };
  return { ok: true, output, logs: res.logs };
}

function pickOutput(rj, dir) {
  if (rj && typeof rj === 'object') {
    for (const k of ['output', 'file', 'filepath', 'path', 'video', 'result']) {
      const p = rj[k];
      if (typeof p === 'string' && fs.existsSync(p)) return p;
    }
  }
  // 兜底：下载目录里最近 5 分钟内新生成的媒体文件
  const exts = ['.mp4', '.mkv', '.webm', '.ts', '.mp3', '.m4a'];
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!exts.includes(path.extname(f).toLowerCase())) continue;
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (Date.now() - st.mtimeMs < 5 * 60 * 1000 && (!best || st.mtimeMs > best.mtimeMs)) best = full;
    }
  } catch (_) { /* ignore */ }
  return best;
}

function extractCode(text) {
  const m = /```(?:javascript|js)?\s*([\s\S]*?)```/.exec(text);
  if (m) return m[1].trim();
  if (/SOLUTION_IMPOSSIBLE/i.test(text)) return null;
  return text.trim();
}

function safeHost(url) { try { return new URL(url).host; } catch (_) { return url; } }

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildDiagnostic(url, msg) { return `URL: ${url}\n错误: ${msg}`; }

module.exports = { download, buildDiagnostic };