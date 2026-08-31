'use strict';
/**
 * 错误码 → 处理方案「规则表」（本地、免费、即时应答，不花 token）
 * 出错先查这里：命中就直接用沉淀好的做法执行，避免动不动就拉大模型。
 * 每个条目决定：要不要切引擎、给什么大白话指引、要不要反问用户（点选）。
 */
const RULES = [
  {
    id: 'CLOUDFLARE',
    match: (hints) => hints.includes('CLOUDFLARE'),
    engine: 'browser',
    advice: '这个站有 Cloudflare 反爬，普通直连会被挡。已改用电浏览器（内嵌 Chromium）打开，通常会自己通过人机校验；若弹出验证，你在窗口里点一下即可。',
    fix: ['用内嵌浏览器打开页面并复用 Cookie（cf_clearance）', '过验证后让视频播放，程序自动拦截 m3u8']
  },
  {
    id: 'HTTP403',
    match: (hints) => hints.includes('HTTP403'),
    engine: 'browser',
    advice: '服务器返回 403（拒绝访问），多半是防盗链或反爬。已切到浏览器拦截，若还 403，多半是会话 Cookie 过期。',
    fix: ['浏览器里刷新页面/重新过验证，让 Cookie 更新', '或用「猫抓/F12」手工复制一条 m3u8 链接粘给程序']
  },
  {
    id: 'M3U8',
    match: (hints) => hints.includes('M3U8'),
    engine: 'browser',
    advice: '这是 HLS 视频（m3u8 分片）。若普通工具只抓到几秒，通常是「直播式滑窗」防盗链，程序会持续刷新 playlist 拿全部分段。',
    fix: ['自动按内置逻辑并发抓取全部分段并 ffmpeg 合并', '拿不全时用猫抓复制具体画质的 m3u8 链接重试']
  },
  {
    id: 'NEED_AUTH',
    match: (hints) => hints.includes('NEED_AUTH'),
    engine: 'browser',
    advice: '这视频需要先登录（或会员）。请在窗口里登录后，再点播放让程序抓到流。',
    fix: ['在内嵌浏览器窗口里完成登录/验证', '登录后重新点下载']
  },
  {
    id: 'NO_FORMATS',
    match: (hints) => hints.includes('NO_FORMATS'),
    engine: 'browser',
    advance: 'yt-dlp 在这个页面找不到可下载的视频流。可能 URL 是列表页/需要登录，或该站太特殊。'
  },
  {
    id: 'BIN',
    match: (hints) => hints.includes('BIN'),
    engine: null,
    advice: 'yt-dlp.exe 打不开，检查一下设置页里填的路径对不对，或是否已安装。',
    fix: ['设置页里「浏览」找到 yt-dlp.exe', '或在管理员 PowerShell 里执行 winget install yt-dlp.yt-dlp']
  },
  {
    id: 'DIR',
    match: (hints) => hints.includes('DIR'),
    engine: null,
    advice: '下载目录写不进去，换个有权限的目录。',
    fix: ['设置页里改下载目录到其它磁盘/文件夹']
  },
  {
    id: 'GEO',
    match: (hints) => hints.includes('GEO'),
    engine: 'browser',
    advice: '该视频有地区限制，可能只能看到部分。试试浏览器里能否播。',
    fix: ['浏览器窗口里看能否播放', '不能播就说明当前网络无法访问']
  }
];

/** 按 yt-dlp 给出的 hints 找到第一条命中的规则 */
function find(hints = []) {
  return RULES.find((r) => r.match(hints)) || null;
}

/**
 * 拿到规则后的「下一步」编排：给 orchestrator 一个统一结构
 * @returns { engine, advice, fix, ask }
 */
function resolve(hints) {
  const r = find(hints);
  if (!r) return { engine: 'browser', advice: null, fix: null, ask: null, ruleId: null };
  return { engine: r.engine, advice: r.advice, fix: r.fix, ask: r.ask || null, ruleId: r.id };
}

module.exports = { RULES, find, resolve };