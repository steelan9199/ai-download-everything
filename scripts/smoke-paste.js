"use strict";
/**
 * 粘贴净化端到端冒烟：验证「渲染层 preload 桥 → IPC → 主进程 link-extractor」全链路，
 * 并用真实 ClipboardEvent 打进输入框，检查「粘贴即净化」的交互契约。
 *
 *   node node_modules/electron/cli.js scripts/smoke-paste.js
 *
 * 守的是这类回归：preload 桥漏改（本项目历史上 preload.js / preload.cjs 双份并存过）、
 * IPC 通道名改错、execCommand 写入失败、多链接时污染了输入框。
 * 纯逻辑断言看 scripts/test-link-extractor.js（不依赖 Electron，更快）。
 */
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "../electron/ipc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const CASES = [
  {
    name: "抖音分享文案（真实脏数据）",
    text: "9.48 NJi:/ 04/27 :3pm V@Y.md 跨界小吃 1-5合集：我家的小吃店能穿越到古代？ # AI漫剧 # 原创动画 # 漫剧 # 二次元  https://v.douyin.com/UE-lb0mo4So/ 复制此链接，打开Dou音搜索，直接观看视频！",
    want: "https://v.douyin.com/UE-lb0mo4So/",
    wantCount: 1,
  },
  {
    name: "抖音地址栏长链",
    text: "https://www.douyin.com/jingxuan?modal_id=7661228096569249066",
    want: "https://www.douyin.com/jingxuan?modal_id=7661228096569249066",
    wantCount: 1,
  },
  {
    name: "多链接 → 触发点选",
    text: "镜像 https://mirror.example.com/a/b 原站 https://v.douyin.com/AbCdEfG/ 备用 https://youtu.be/xYz123",
    wantCount: 3,
  },
  {
    name: "纯文本 → 零命中不打扰",
    text: "今天天气不错，我随便写了点字",
    wantOk: false,
  },
];

app.whenReady().then(async () => {
  let win = null;
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  register(() => win);

  let fail = 0;

  try {
    await win.loadFile(path.join(root, "renderer", "index.html"));

    const bridge = await win.webContents.executeJavaScript("typeof window.api.extractLinks");
    if (bridge === "function") {
      console.log("✅ preload 桥已挂载 window.api.extractLinks");
    } else {
      console.log("❌ preload 桥没挂上，typeof = " + bridge);
      fail++;
    }

    for (const c of CASES) {
      const r = await win.webContents.executeJavaScript(
        "window.api.extractLinks(" + JSON.stringify(c.text) + ")"
      );
      const errs = [];
      if (c.wantOk === false && r.ok !== false) errs.push("应零命中，实际 ok=" + r.ok);
      if (c.wantCount != null && r.count !== c.wantCount) errs.push("链接数应为 " + c.wantCount + "，实际 " + r.count);
      if (c.want != null && r.primary !== c.want) errs.push("结果应为 " + c.want + "，实际 " + r.primary);
      if (errs.length) {
        fail++;
        console.log("❌ " + c.name);
        errs.forEach((e) => console.log("     " + e));
      } else {
        console.log("✅ " + c.name + " → " + (r.primary || "(无)"));
      }
    }
    // —— 真实粘贴路径：构造 ClipboardEvent 打进输入框，看 Vue 的 onPaste 是否按契约工作 ——
    const pasteInto = (text) =>
      win.webContents.executeJavaScript(
        `(async () => {
          const input = document.querySelector('.url-input');
          input.focus();
          input.select();
          const dt = new DataTransfer();
          dt.setData('text', ${JSON.stringify(text)});
          input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 400));
          return { value: input.value, picker: !!document.querySelector('.lp-box') };
        })()`
      );

    const dirty =
      "9.48 NJi:/ 04/27 :3pm V@Y.md 跨界小吃 1-5合集 # AI漫剧  https://v.douyin.com/UE-lb0mo4So/ 复制此链接，打开Dou音搜索，直接观看视频！";
    const one = await pasteInto(dirty);
    if (one.value === "https://v.douyin.com/UE-lb0mo4So/") {
      console.log("✅ 单链接粘贴 → 输入框只剩干净网址（零打断）");
    } else {
      fail++;
      console.log("❌ 单链接粘贴失败，输入框 = " + JSON.stringify(one.value));
    }

    // 框里先放脏东西，再粘一次，验证是「整框替换」而不是拼接
    const two = await pasteInto(dirty + " 另一条 https://v.douyin.com/ZzZzZ/ 完");
    if (two.value && two.value.startsWith("https://") && two.value.indexOf(" ") === -1) {
      console.log("✅ 多链接粘贴 → 弹出候选列表，等你点选（当前值未被污染：" + two.value + "）");
    } else {
      fail++;
      console.log("❌ 多链接粘贴异常，输入框 = " + JSON.stringify(two.value));
    }
    if (two.picker) console.log("✅ 候选弹层已渲染");
    else { fail++; console.log("❌ 候选弹层没渲染出来"); }

  } catch (e) {
    fail++;
    console.log("❌ 冒烟异常：" + ((e && e.stack) || e));
  }

  console.log(fail === 0 ? "\n✅ 端到端链路全通" : "\n❌ 失败 " + fail + " 项");
  app.exit(fail === 0 ? 0 : 1);
});
