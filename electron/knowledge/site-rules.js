'use strict';
/**
 * 站点规则库（脚本沉淀，最省 token 的关键一环）
 * 大模型每攻克一个新站/新问题，把可复用的「脚本 + 设置」存进来；
 * 下次命中同站直接复用，不再调大模型。
 * 规则分两类：
 *  - settings 类：纯配置（特殊 Referer、Cookie 名、m3u8 正则等），程序直接套用；
 *  - script  类：AI 沉淀的最小可复用脚本，交给 sandbox 执行。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 内置示例（只作格式示范，不针对任何具体站点）
const BUILTIN = [
  {
    id: 'example-generic-hls',
    host: 'example.com',
    match: 'example\\.com',
    kind: 'settings',
    note: '示例：某站 m3u8 需要自定义 Referer 才能 200',
    settings: { referer: 'https://example.com/', extraHeaders: {} }
  }
];

function rulesFile() {
  try {
    if (app && app.getPath && app.getPath('userData')) return path.join(app.getPath('userData'), 'site-rules.json');
  } catch (_) { /* ignore */ }
  return path.join(os.tmpdir(), 'ai-video-downloader-site-rules.json');
}

function load() {
  let user = [];
  try { user = JSON.parse(fs.readFileSync(rulesFile(), 'utf8')); } catch (_) { /* 无文件 */ }
  return [...BUILTIN, ...(Array.isArray(user) ? user : [])];
}

/** 按 URL 匹配命中规则（match 是正则字符串，逐条测） */
function matchRule(url, rules = null) {
  const list = rules || load();
  for (const r of list) {
    if (!r.match) continue;
    try { if (new RegExp(r.match, 'i').test(url)) return r; } catch (_) { /* 忽略坏正则 */ }
  }
  return null;
}

/** 沉淀一条规则（AI 攻克后调用），写入 userData，持久化复用 */
function sediment(rule) {
  const list = load();
  const existing = list.findIndex((r) => r.id === rule.id);
  const userRules = list.filter((r) => !BUILTIN.some((b) => b.id === r.id));
  if (existing >= 0) userRules[existing] = rule; else userRules.push(rule);
  fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
  fs.writeFileSync(rulesFile(), JSON.stringify(userRules, null, 2), 'utf8');
  return rule;
}

module.exports = { load, matchRule, sediment, rulesFile, BUILTIN };