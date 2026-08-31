'use strict';
/**
 * 主进程入口
 *  - 正常模式：创建窗口（preload 隔离）+ 注册 IPC；
 *  - --selfcheck 模式：命令行自检 ffmpeg/yt-dlp/下载目录并打印 JSON 后退出（供 CI/快速排障）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const startupCheck = require('./startup-check');
const { register } = require('./ipc');

const isSelfCheck = process.argv.includes('--selfcheck');

if (isSelfCheck) {
  app.whenReady().then(() => {
    const r = startupCheck.run();
    console.log(JSON.stringify(r, null, 2));
    app.exit(r.allReady ? 0 : 1);
  });
} else {
  let win = null;
  const getWin = () => win;

  function createWindow() {
    win = new BrowserWindow({
      width: 600, height: 760,
      minWidth: 480, minHeight: 560,
      title: 'AI 视频下载器',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  app.whenReady().then(() => {
    createWindow();
    register(getWin);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}