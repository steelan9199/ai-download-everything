"use strict";
/**
 * 链接提取器：把用户「复制粘贴的一坨分享文案」洗净成一条能下载的网址。
 *
 * 设计原则（别改歪了）：
 * 1. 纯函数、零依赖、零网络请求 —— 确定性字符串处理，不花 token、不联网。
 * 2. 用 RFC 3986 字符集白名单抓候选，中文天然进不来（抖音「/复制此链接」无空格粘连的坑由此根治）。
 * 3. 站点规则只做「显示标签 + 排序」，绝不删改 URL 本身（删追踪参数可能破坏签名，导致下不了）。
 * 4. 拿不准就不动：一个都没识别到时返回 ok:false，调用方应保持输入框原样、不打扰用户。
 *
 * 覆盖：抖音（长链 modal_id / 短链 v.douyin.com）、快手、B站、YouTube 等主流站；其它站走通用兜底。
 * 加新站：往 SITE_RULES 里加一条即可，主逻辑不动。
 */

/** RFC 3986 允许的 URL 字符集（不含中文/全角）——中文自动成为天然边界 */
const URL_CHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
const URL_RE = new RegExp("https?://[" + URL_CHARS + "]+", "gi");

/** 非 ASCII 边界：CJK 汉字、假名、谚文、全角符号 —— 一律视为 URL 之外的正文 */
const CJK_OR_FULLWIDTH = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯！-｠]/;

/** 尾随的 ASCII 标点（URL 里合法，但出现在末尾多半是中文句子的标点） */
const TAIL_ASCII = /[.,;:!?'"`*]/;
/** 尾随的闭合括号：只剥「多出来的那个」，配对的要留（如带括号的维基 URL） */
const TAIL_BRACKET = { ")": "(", "]": "[", "}": "{", ">": "<" };

/**
 * 站点规则表：只影响「候选列表里显示什么名字、排第几」，不改 URL。
 * 顺序即权重，越靠前越优先（score 由下标推导，避免手写魔法数字）。
 *
 * host 配的是解析后的完整 hostname（含 www，用 $ 锚尾，防 douyin.com.evil.com 这类钓鱼域）；
 * path 可选，配的是 pathname + search；host 必须命中，path 有则也必须命中。
 */
const SITE_RULES = [
  // —— 抖音：长链带真实 aweme_id 最优先；短链需 302 跳转（引擎层负责，这里不动）——
  { id: "douyin-long", label: "抖音视频（完整链接）", host: /douyin\.com$/i, path: /(modal_id=|\/video\/)/i },
  { id: "douyin-share", label: "抖音分享短链", host: /^v\.douyin\.com$/i },
  { id: "douyin", label: "抖音", host: /douyin\.com$/i },
  // —— 快手：内置适配器能吃短链和 short-video 页 ——
  { id: "kuaishou-share", label: "快手分享短链", host: /^v\.kuaishou\.com$/i },
  { id: "kuaishou", label: "快手", host: /kuaishou\.com$/i },
  // —— 其它主流站 ——
  { id: "bilibili", label: "哔哩哔哩", host: /bilibili\.com$/i, path: /\/(video|bangumi|list)\//i },
  { id: "youtube-short", label: "YouTube 短链", host: /^youtu\.be$/i },
  { id: "youtube", label: "YouTube", host: /youtube\.com$/i, path: /\/(watch|shorts|playlist)/i },
  { id: "twitter", label: "X / Twitter", host: /(^|\.)(twitter|x)\.com$/i, path: /\/status\//i },
  { id: "weibo", label: "微博", host: /weibo\.com$/i },
  { id: "xiaohongshu", label: "小红书", host: /xiaohongshu\.com$/i },
  { id: "iqiyi", label: "爱奇艺", host: /iqiyi\.com$/i },
  { id: "vimeo", label: "Vimeo", host: /vimeo\.com$/i },
  { id: "tiktok", label: "TikTok", host: /tiktok\.com$/i },
];

/** 候选列表最多展示几条，防止整页文案塞爆 UI */
const MAX_LINKS = 8;

/**
 * 清洗单条候选 URL 的尾巴。
 * @param {string} raw 正则抓出来的原始候选
 * @returns {string} 洗净后的 URL
 */
function trimTail(raw) {
  let s = String(raw || "");

  // 1) 非 ASCII 边界截断：正则已天然排除，这里兜住意外漏进来的情况
  const m = s.match(CJK_OR_FULLWIDTH);
  if (m && m.index != null) s = s.slice(0, m.index);

  // 2) 循环剥离尾部垃圾字符（剥完可能露出新的垃圾，所以要 while）
  let changed = true;
  while (changed && s.length > 0) {
    changed = false;
    const last = s.slice(-1);

    if (TAIL_ASCII.test(last)) {
      s = s.slice(0, -1);
      changed = true;
      continue;
    }

    const open = TAIL_BRACKET[last];
    if (open) {
      const countOf = (ch) => s.split(ch).length - 1;
      // 闭合括号比开括号多 → 这个闭合括号不是 URL 自己的，剥掉
      if (countOf(last) > countOf(open)) {
        s = s.slice(0, -1);
        changed = true;
      }
    }
  }

  return s;
}

/** 抽取主机名（去 www、转小写），失败返回空串 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_) {
    return "";
  }
}

/**
 * 按站点规则表匹配标签与排序权重（越靠前权重越高）。
 * 用 URL 解析结果做匹配，而不是在整串 URL 上跑正则 —— 否则协议头的 // 会让边界判断翻车
 * （例：https://v.douyin.com/x 里 v.douyin.com 前面是斜杠，配 `(^|\.)` 永远命中不了）。
 * @param {string} url
 * @param {string} host 去 www 后的主机名，仅作兜底显示
 */
function classify(url, host) {
  let hostname = "";
  let pathAndQuery = url;
  try {
    const u = new URL(url);
    hostname = u.hostname.toLowerCase();
    pathAndQuery = u.pathname + u.search;
  } catch (_) {
    hostname = host;
  }

  for (let i = 0; i < SITE_RULES.length; i++) {
    const rule = SITE_RULES[i];
    if (!rule.host.test(hostname)) continue;
    if (rule.path && !rule.path.test(pathAndQuery)) continue;
    return { site: rule.id, label: rule.label, score: 1000 - i * 10 };
  }

  // 通用兜底：给个可读的主机名，权重最低
  return { site: "generic", label: host || hostname || "未知站点", score: 100 };
}

/**
 * 从一段任意文本里提取所有可下载的链接。
 *
 * @param {string} text 用户粘贴进来的原始文本
 * @param {{ allowBare?: boolean, max?: number }} [opts]
 *        allowBare: 是否额外识别没写 http(s):// 的裸域名（默认关闭，误判率高）
 * @returns {{ ok: boolean, count: number, links: Array<{url:string,host:string,site:string,label:string,score:number}>, primary: string|null, cleaned: boolean, raw: string }}
 */
export function extractLinks(text, opts) {
  const options = opts || {};
  const max = options.max || MAX_LINKS;
  const raw = String(text == null ? "" : text);

  const found = [];
  const seen = new Set();

  const push = (u) => {
    const url = trimTail(u);
    if (!url || url.length < 12) return; // 太短的（如 https://a.b）当噪声丢掉
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const host = hostOf(url);
    const info = classify(url, host);
    found.push({ url, host, site: info.site, label: info.label, score: info.score });
  };

  // 1) 主通道：http(s) 链接
  const re = new RegExp(URL_RE.source, "gi");
  let m;
  while ((m = re.exec(raw)) !== null) push(m[0]);

  // 2) 可选通道：裸域名（默认关闭；仅在上面一无所获时才试）
  if (options.allowBare && found.length === 0) {
    const hits = raw.match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?/gi) || [];
    for (const h of hits) push("https://" + h.replace(/^[./]+/, ""));
  }

  // 3) 排序：站点权重优先，同权重保持原文出现顺序（Array.sort 在 V8 中是稳定排序）
  found.sort((a, b) => b.score - a.score);

  const links = found.slice(0, max);
  const primary = links.length > 0 ? links[0].url : null;

  return {
    ok: links.length > 0,
    count: links.length,
    links,
    primary,
    // 是否真的「洗干净了」：只有一条且和原文完全一致 → 没洗，别打扰用户
    cleaned: links.length === 1 ? primary !== raw.trim() : links.length > 1,
    raw,
  };
}

/**
 * 快捷入口：只要一条链接（命令行 / 下载前兜底清洗用）。
 * 拿不准就原样返回，绝不猜。
 * @param {string} text
 * @returns {string}
 */
export function pickFirstUrl(text) {
  const r = extractLinks(text);
  if (!r.ok) return String(text == null ? "" : text).trim();
  return r.primary;
}

export default { extractLinks, pickFirstUrl };
