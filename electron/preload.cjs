"use strict";
/**
 * preload 桥：用 contextBridge 只暴露白名单 API，渲染层碰不到 Node 能力（安全边界）。
 * 渲染层只通过 window.api 与主进程通信。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // —— 设置 / 自检 ——
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  selfCheck: () => ipcRenderer.invoke("selfcheck"),
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),
  pickFile: (title) => ipcRenderer.invoke("dialog:pick-file", title),

  // —— 下载 ——
  startDownload: (payload) => ipcRenderer.invoke("download:start", payload),
  cancelDownload: () => ipcRenderer.send("download:cancel"),

  // —— 大模型 ——
  aiAsk: (payload) => ipcRenderer.invoke("ai:ask", payload),

  // —— 点选式问题回填 ——
  answerQuestion: (payload) => ipcRenderer.send("dialog:answer", payload),

  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  revealFile: (p) => ipcRenderer.invoke("shell:reveal", p),

  // —— 订阅主进程推送（event / question 两个通道）——
  on: (channel, cb) => {
    if (!["event", "question"].includes(channel)) return () => {};
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
