# 拦截网页「自定义协议 / 打开 App」弹窗

> 适用：程序内嵌 Chromium 打开网页（典型：抖音 `www.douyin.com`）时，弹出 Windows 系统弹窗，提示
> 「获取打开此链接的应用。你的电脑没有可打开此链接的应用，请尝试在 Microsoft Store 中查找兼容应用」。
> 弹窗右下角有一个蓝色「浏览 Microsoft Store」按钮；文字里有时会带出具体协议名（例如 `'bytedance'`）。

## 现象特征

- 通常**不是**一打开页面就弹，而是「视频/页面加载后延迟一两秒」才弹——因为它是页面里的一段**延时脚本**触发的。
- 弹窗会抢走网页窗口焦点，甚至导致正在播放的视频**暂停**（是弹窗抢焦点所致，源头堵掉即可解）。
- 属于 **Windows 系统弹窗**，不是网页自己画的 HTML 弹层。

## 根因

网页想「唤起外部 App」，实现方式是发起一次到「自定义协议（custom scheme）」的跳转，形如：

- `bytedance://…`
- `snssdk1128://…`
- `snssdk://…`

Windows 里没有能处理该协议的 App，操作系统就弹出「获取打开此链接的应用」。

**Electron 的关键坑**：这类跳转不一定发生在「主页面（main frame）」，抖音是从「内嵌 iframe 子页面」发起的。
而 `will-navigate` 事件**只管主 frame**，拦不住 iframe 里的跳转——所以第一版只加 `will-navigate` 是无效的，必须补 `will-frame-navigate`（Electron 25+，覆盖主 frame + 所有子 frame）。

## 处理方案（两层，均已落地）

### 1）主进程：全局拦截任何 frame 的非 http(s) 跳转

文件：`electron/main.js`，在 `app.on("web-contents-created", …)` 里统一挂：

- `will-frame-navigate`：主 frame + iframe 子 frame，非 `http(s)` 一律 `preventDefault()`（关键，覆盖 iframe）。
- `will-navigate`：兼容旧写法，主 frame，同上。
- `will-redirect`：服务端 302 重定向到非 http(s)，同上。
- `setWindowOpenHandler`：`window.open` 到非 http(s) → `{ action: "deny" }`。

统一**只放行 `http(s)`**，其余协议（`bytedance://` 等）全部静默吞掉。

### 2）浏览器引擎：把已知深链 scheme 注册成空处理器

文件：`electron/engines/browser-engine.js`，在 `run()` 里对浏览器引擎自己用的那个 partition 的 session 注册：

```js
// this.ses = session.fromPartition("persist:download-browser")
for (const scheme of ["bytedance", "snssdk1128", "snssdk"]) {
  ses.protocol.handle(scheme, () => new Response(null, { status: 204 }));
}
```

这样该 scheme 在「协议层」就被直接消化（返回 204 空响应），Windows 根本没机会弹框。

> 注意：必须注册在**浏览器引擎用的那个 partition session**（`persist:download-browser`）上，
> 不是 Electron 默认 session，否则登录 Cookie/自定义 handler 会对不上。

## 新 scheme 出现时怎么扩展

1. 看弹窗文字里带出的协议名（例如 `'xxx'`），把它加进 `browser-engine.js` 里那个 scheme 列表即可。
2. 如果协议名不明、或不走这里，先确认 `will-frame-navigate` 已覆盖（它拦所有 frame）。
   若仍漏，再逐个排查触发通道：main frame / iframe / `window.open` / 服务端 302 重定向，对应补拦截。

## 涉及文件

- `electron/main.js`
- `electron/engines/browser-engine.js`

## 下次遇到「弹框」的排查顺序

1. **先分清是系统弹窗还是网页 HTML 弹层**：
   - 系统弹窗：文字带「获取打开此链接的应用 / Microsoft Store」+ 右下角蓝色按钮 → 走本文方案。
   - 网页自己弹的「打开 App」横幅/遮罩 → 那是页面 DOM，要走「注入 CSS/JS 隐藏」，与本文方案无关（另一码事）。
2. 系统弹窗 → 看文字里的协议名，加进 scheme 拦截列表 + 确认 `will-frame-navigate` 覆盖。
3. 顺带观察弹窗是否导致视频暂停/黑屏：多半是它抢焦点所致，源头堵掉即自愈。