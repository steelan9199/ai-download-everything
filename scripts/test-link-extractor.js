"use strict";
/**
 * 链接提取器自测：用真实世界脏文案做断言，命令行跑，不依赖 Electron。
 *   node scripts/test-link-extractor.js
 */
import { extractLinks, pickFirstUrl } from "../electron/core/link-extractor.js";

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log("  ✅ " + name);
  } else {
    fail++;
    console.log("  ❌ " + name);
    console.log("     期望: " + JSON.stringify(expected));
    console.log("     实际: " + JSON.stringify(actual));
  }
}

console.log("\n【1】抖音分享文案（用户真实样本：中文紧跟 URL）");
const douyinShare =
  "9.48 NJi:/ 04/27 :3pm V@Y.md 跨界小吃 1-5合集：我家的小吃店能穿越到古代？ # AI漫剧 # 原创动画 # 漫剧 # 二次元  https://v.douyin.com/UE-lb0mo4So/ 复制此链接，打开Dou音搜索，直接观看视频！";
{
  const r = extractLinks(douyinShare);
  check("识别出 1 条", r.count, 1);
  check("洗净为短链", r.primary, "https://v.douyin.com/UE-lb0mo4So/");
  check("站点标签", r.links[0].label, "抖音分享短链");
  check("确实发生了清洗", r.cleaned, true);
}

console.log("\n【2】抖音分享文案（无空格，中文直接粘在 URL 尾巴上）");
{
  const r = extractLinks("超好看 https://v.douyin.com/UE-lb0mo4So/复制此链接，打开Dou音搜索");
  check("中文被截断", r.primary, "https://v.douyin.com/UE-lb0mo4So/");
}

console.log("\n【3】浏览器地址栏长链（modal_id）");
{
  const long = "https://www.douyin.com/jingxuan?modal_id=7661228096569249066";
  const r = extractLinks(long);
  check("原样保留 query", r.primary, long);
  check("站点标签", r.links[0].label, "抖音视频（完整链接）");
  check("纯网址不算被清洗", r.cleaned, false);
}

console.log("\n【4】B站带追踪参数（不删参数，删了可能破坏签名）");
{
  const u = "https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999.0.0";
  const r = extractLinks("【神仙剪辑】" + u + " 快来看");
  check("完整保留", r.primary, u);
  check("站点标签", r.links[0].label, "哔哩哔哩");
}

console.log("\n【5】多链接 → 弹列表场景（抖音排前面）");
{
  const r = extractLinks("镜像 https://mirror.example.com/a/b 原站 https://v.douyin.com/AbCdEfG/ 备用 https://youtu.be/xYz123");
  check("识别 3 条", r.count, 3);
  check("抖音优先", r.links[0].site, "douyin-share");
  check("需用户点选", r.cleaned, true);
}

console.log("\n【6】重复链接去重");
{
  const r = extractLinks("https://v.douyin.com/AbC/ 和 https://v.douyin.com/AbC/ 是同一个");
  check("去重后 1 条", r.count, 1);
}

console.log("\n【7】标点 / 括号 / 引号包裹");
check("句号结尾", pickFirstUrl("链接是 https://v.douyin.com/AbC/。"), "https://v.douyin.com/AbC/");
check("单引号包裹", pickFirstUrl("'https://v.douyin.com/AbC/'"), "https://v.douyin.com/AbC/");
check("书名号包裹", pickFirstUrl("《https://v.douyin.com/AbC/》"), "https://v.douyin.com/AbC/");
check("多余右括号", pickFirstUrl("(https://v.douyin.com/AbC/)"), "https://v.douyin.com/AbC/");
check("配对的括号保留", pickFirstUrl("https://en.wikipedia.org/wiki/X_(Y)"), "https://en.wikipedia.org/wiki/X_(Y)");

console.log("\n【8】快手 / YouTube");
check("快手短链", extractLinks("分享 https://v.kuaishou.com/1a2B3c 快来看").links[0].label, "快手分享短链");
check("YouTube 短链", extractLinks("https://youtu.be/dQw4w9WgXcQ").links[0].label, "YouTube 短链");

console.log("\n【9】零命中兜底：一个链接都没有 → 不动、不打扰");
{
  const r = extractLinks("今天天气不错，我随便写了点字");
  check("ok=false", r.ok, false);
  check("primary=null", r.primary, null);
  check("原样返回不猜", pickFirstUrl(" 纯文本 "), "纯文本");
}

console.log("\n【10】裸域名默认不识别（防误判），开开关才吃");
check("默认关闭", extractLinks("www.douyin.com/video/123").ok, false);
check("开关打开", extractLinks("www.douyin.com/video/123", { allowBare: true }).primary, "https://www.douyin.com/video/123");

console.log("\n———————————————————————");
console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
