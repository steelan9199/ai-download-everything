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

// 安全网：主进程偶发的异步异常只记日志、不弹「A JavaScript error occurred
// in the main process」崩溃框。典型场景：Electron 31 的已知竞态
// "Render frame was disposed before WebFrameMain could be accessed"
//（electron/electron#39068，33.1 起修复）——抖音这类页面 iframe 频繁创建/销毁时，
// 事件参数里的 frame 已被释放，Electron 内部在执行我们的回调之前就抛异常，
// 回调里 try/catch 接不住。注册我们自己的处理器后，Electron 不再弹默认错误框。
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err && err.stack ? err.stack : err);
});

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
    // 注意：这里【不要】监听 will-frame-navigate。Electron 31 下，子 frame 在事件
    // 派发前被销毁时，Electron 内部构造 WebFrameMain 参数会直接抛
    // "Render frame was disposed before WebFrameMain could be accessed"
    //（electron/electron#39068，33.1 起修复），异常发生在我们的回调执行之前，
    // 回调内 try/catch 无法捕获，抖音页大量广告/登录 iframe 频繁创建销毁必现。
    // 外部协议唤起 App 只可能由主框架跳转或 window.open 触发（iframe 跳转自定义
    // 协议会被 Chromium 直接取消，不弹系统框），下面两层已足够覆盖。
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
