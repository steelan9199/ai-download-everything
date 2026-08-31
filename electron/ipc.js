'use strict';
/**
 * IPC 注册：把「渲染层 ↔ 主进程」的通道串起来。
 * 关键设计：orchestrator 需要向用户「点选提问」（askUser），这里用一个 pendingQuestions 表
 * 把提问推给渲染层，等用户点选回填后再 resolve，让下载流程能「暂停等真人答复」。
 */
const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const startupCheck = require('./startup-check');
const orchestrator = require('./engines/orchestrator');
const advisor = require('./ai/advisor');

function register(getWin) {
  const state = { cancelToken: null, pendingQuestions: new Map(), seq: 0 };

  ipcMain.handle('settings:get', () => settings.load());
  ipcMain.handle('settings:save', (_e, patch) => settings.save(patch || {}));
  ipcMain.handle('selfcheck', () => startupCheck.run());
  ipcMain.handle('open-external', (_e, url) => { if (url) shell.openExternal(String(url)); return true; });
  ipcMain.handle('shell:reveal', async (_e, p) => {
    if (!p) return { ok: false, error: '路径为空' };
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) { const err = await shell.openPath(p); return { ok: !err, error: err || null }; }
      // 文件：在资源管理器里高亮选中它
      shell.showItemInFolder(p);
      return { ok: true, error: null };
    } catch (_) {
      // 路径本身不存在：退而打开它的父目录（例如文件已被移动/改名）
      const dir = path.dirname(p);
      if (fs.existsSync(dir)) { const err = await shell.openPath(dir); return { ok: !err, error: err || null }; }
      return { ok: false, error: '路径无效：' + p };
    }
  });

  ipcMain.handle('dialog:pick-folder', async () => {
    const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pick-file', async (_e, title) => {
    const r = await dialog.showOpenDialog(getWin(), { title: title || '选择文件', properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('ai:ask', async (_e, payload) => {
    const msg = payload && payload.message;
    const system = payload && payload.system;
    return advisor.ask(String(msg || ''), { system });
  });

  ipcMain.handle('download:start', async (_e, payload) => {
    const url = payload && payload.url;
    const engine = payload && payload.engine ? payload.engine : 'auto';
    if (!url) return { ok: false, error: '请输入网址' };

    const cfg = settings.load();
    const check = startupCheck.run();
    // 环境自检不过：直接把「指引」返回给 UI，绝不装死
    if (!check.ffmpeg.found || !check.ytdlp.found || !check.downloadDir.ok) {
      return { ok: false, error: '运行环境还没就绪', check };
    }

    state.cancelToken = { cancelled: false };
    const tools = { ffmpegPath: check.ffmpeg.path, ytdlpPath: check.ytdlp.path };

    const askUser = (q) => new Promise((resolve) => {
      const id = 'q' + (++state.seq);
      state.pendingQuestions.set(id, resolve);
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('question', { questionId: id, prompt: q.prompt, options: q.options || [] });
    });

    const onEvent = (ev) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('event', ev); };

    const result = await orchestrator.download({ url, engine, settings: cfg, tools, askUser, onEvent, onLog: onEvent, cancelToken: state.cancelToken });

    // 任务结束：临时全权自动复位（作用域=本次任务）
    if (cfg.fullAccess) settings.save({ fullAccess: false });
    return result;
  });

  ipcMain.on('download:cancel', () => { if (state.cancelToken) state.cancelToken.cancelled = true; });

  ipcMain.on('dialog:answer', (_e, payload) => {
    const resolve = state.pendingQuestions.get(payload && payload.questionId);
    if (resolve) {
      state.pendingQuestions.delete(payload.questionId);
      resolve({ choice: payload.choice, custom: payload.custom || '' });
    }
  });
}

module.exports = { register };