"use strict";
/**
 * 主进程入口
 *  - 正常模式：创建窗口（preload 隔离）+ 注册 IPC；
 *  - --selfcheck 模式：命令行自检 ffmpeg/yt-dlp/下载目录并打印 JSON 后退出（供 CI/快速排障）。
 */
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as runSelfCheck } from "./startup-check.js";
import { register } from "./ipc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isSelfCheck = process.argv.includes("--selfcheck");

if (isSelfCheck) {
  app.whenReady().then(() => {
    const r = runSelfCheck();
    console.log(JSON.stringify(r, null, 2));
    app.exit(r.allReady ? 0 : 1);
  });
} else {
  let win = null;
  const getWin = () => win;

  function createWindow() {
    win = new BrowserWindow({
      width: 600,
      height: 760,
      minWidth: 480,
      minHeight: 560,
      title: "AI 视频下载器",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  app.whenReady().then(() => {
    createWindow();
    register(getWin);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // 拦截「自定义协议 / 外部 App」跳转：抖音等网页会尝试 location.href = 'douyin://…'
  // 去唤起外部应用，Windows 没装对应 App 时就会弹「获取打开此链接的应用」。这里静默吞掉，
  // 只放行 http(s)，既不弹框、也不让页面真的跳出去。
  app.on("web-contents-created", (_event, contents) => {
    const isWeb = (u) => /^https?:\/\//i.test(String(u || ""));
    // 任意层级（主页面 + 内嵌 iframe 子页面）发起的「自定义协议」跳转都拦掉
    contents.on("will-frame-navigate", (details) => {
      if (!isWeb(details.url)) details.preventDefault();
    });
    contents.on("will-navigate", (event, url) => {
      if (!isWeb(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isWeb(url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) =>
      isWeb(url) ? { action: "allow" } : { action: "deny" },
    );
  });
}
