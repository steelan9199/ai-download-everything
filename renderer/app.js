'use strict';
/**
 * 渲染层逻辑（Vue 3 全局构建，无打包器）
 * 只有「普通人也看得懂」的交互：粘贴网址 → 下载 → 看进度条；
 * 需要人时弹「点选 + 自定义补充」，需要大模型时点「问 AI」。
 */
const { createApp } = Vue;

createApp({
  data() {
    return {
      tab: 'home',
      url: '',
      engine: 'auto',
      downloading: false,
      progress: 0,
      speed: '',
      eta: '',
      statusText: '',
      diagnostic: '',
      resultInfo: '',
      outputPath: '',
      downloadSuccess: false,
      aiCalls: 0,
      logs: [],
      aiQuestion: '',
      aiAnswer: '',
      aiBusy: false,
      advancedMode: false,
      savedTip: '',
      check: null,
      settings: { downloadDir: '', ffmpegPath: '', ytdlpPath: '', ai: { apiKey: '', baseURL: '', model: '', autoCall: false }, fullAccess: false },
      question: null,
      questionMinimized: false,
      customAnswer: ''
    };
  },
  methods: {
    async refresh() {
      this.settings = await window.api.getSettings();
      this.check = await window.api.selfCheck();
    },
    async saveSettings() {
      try {
        // Vue 的响应式代理对象无法被 Electron IPC 结构化克隆（会报 "An object could not be cloned" 并静默失败），先转成纯对象再发送
        const patch = JSON.parse(JSON.stringify(this.settings));
        await window.api.saveSettings(patch);
        this.savedTip = '已保存 ✓';
        this.check = await window.api.selfCheck();
      } catch (e) {
        this.savedTip = '保存失败：' + ((e && e.message) || e);
      }
      setTimeout(() => { this.savedTip = ''; }, 3000);
    },
    async browseDir() {
      const p = await window.api.pickFolder();
      if (p) this.settings.downloadDir = p;
    },
    async browseFile(key, title) {
      const p = await window.api.pickFile(title);
      if (p) this.settings[key] = p;
    },
    async startDownload() {
      if (!this.url) { this.statusText = '请先粘贴一个网址'; return; }
      this.downloading = true;
      this.progress = 0; this.speed = ''; this.eta = '';
      this.statusText = '准备下载…'; this.diagnostic = ''; this.resultInfo = ''; this.logs = [];
      this.outputPath = ''; this.downloadSuccess = false;
      const r = await window.api.startDownload({ url: this.url, engine: this.engine });
      this.downloading = false;
      this.progress = r.ok ? 100 : this.progress;
      if (r.ok) {
        this.statusText = '下载完成 ✓';
        this.downloadSuccess = true;
        this.outputPath = r.output || '';
        this.resultInfo = `成功（引擎：${r.engineUsed}）\n${r.output || ''}`;
        if (r.aiCalls) this.aiCalls = r.aiCalls;
      } else if (r.check) {
        this.statusText = r.error;
        this.askSelfCheck();
      } else {
        this.statusText = '没下成：' + (r.error || '未知原因');
        this.resultInfo = '失败（' + (r.engineUsed || 'auto') + '）';
        if (r.aiCalls) this.aiCalls = r.aiCalls;
      }
    },
    cancel() { window.api.cancelDownload(); this.statusText = '正在取消…'; },

    async openDownload() {
      const target = this.outputPath || this.settings.downloadDir;
      if (!target) { this.statusText = '找不到文件路径，请看「高级模式」的诊断信息'; return; }
      const res = await window.api.revealFile(target).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      const ok = res === true || (res && res.ok);
      if (!ok) this.statusText = '没能打开：' + ((res && res.error) || '未知原因') + '（路径 ' + target + '）';
    },

    async askAI() {
      const q = this.aiQuestion || this.diagnostic || '请帮我诊断当前下载问题';
      if (this.aiBusy) return;
      this.aiBusy = true;
      this.aiAnswer = '…思考中';
      const r = await window.api.aiAsk({ message: q, system: '你是视频下载器诊断助手，用大白话给出最短的可执行建议。' });
      this.aiBusy = false;
      this.aiCalls++;
      this.aiAnswer = r.ok ? r.text : ('出错：' + r.error);
    },

    // —— 主进程事件统一入口 ——
    onEvent(ev) {
      if (!ev) return;
      switch (ev.type) {
        case 'status': this.statusText = ev.msg; break;
        case 'guidance': this.statusText = ev.msg; this.pushLog('📌 ' + ev.msg); break;
        case 'progress':
          if (ev.done && ev.total) this.progress = Math.round((ev.done / ev.total) * 100);
          else if (ev.percent != null) this.progress = ev.percent;
          if (ev.speed) this.speed = ev.speed;
          if (ev.eta) this.eta = ev.eta;
          break;
        case 'diagnostic': this.diagnostic = ev.msg; break;
        case 'found-m3u8': this.pushLog('抓到 m3u8: ' + ev.url); break;
        case 'found-media': this.pushLog('抓到视频直链: ' + ev.url); break;
        case 'edge-play': this.pushLog('进入边播边存，共 ' + ev.count + ' 个分片'); break;
        case 'merge-start': this.statusText = '正在合并视频…'; this.pushLog('ffmpeg 合并 → ' + ev.file); break;
        case 'merge-done': this.statusText = '合并完成 ✓'; this.pushLog('完成: ' + ev.file); break;
        case 'direct-done': this.statusText = '下载完成 ✓'; this.pushLog('完成: ' + ev.file); break;
        case 'log': this.pushLog((ev.level === 'error' ? '❌ ' : '') + ev.msg); break;
        default: this.pushLog(JSON.stringify(ev)); break;
      }
    },
    onQuestion(q) {
      this.question = q;
      this.questionMinimized = false;
      this.customAnswer = '';
    },
    answer(choice) {
      const q = this.question;
      const custom = this.customAnswer || '';
      this.question = null;
      this.questionMinimized = false;
      window.api.answerQuestion({ questionId: q.questionId, choice, custom });
    },
    minimizeQuestion() {
      // 只是视觉收起：后端仍在等待该问题的答案，流程保持暂停
      this.questionMinimized = true;
    },
    restoreQuestion() {
      this.questionMinimized = false;
    },
    pushLog(s) {
      this.logs.push(s);
      if (this.logs.length > 200) this.logs = this.logs.slice(-200);
    },
    askSelfCheck() {
      this.tab = 'settings';
    }
  },
  async mounted() {
    window.api.on('event', (ev) => this.onEvent(ev));
    window.api.on('question', (q) => this.onQuestion(q));
    await this.refresh();
  }
}).mount('#app');