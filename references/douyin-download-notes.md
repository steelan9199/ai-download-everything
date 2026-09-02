# 抖音下载排障记录（已解决，2026-09-03 实战验证）

验证样本：`https://v.douyin.com/HeZa_vy3gRY/`（13分29秒 · 1920x1080 · hvc1 画面流 + 独立声音流），
成品带声音、完整落盘。

## 现象

1. yt-dlp 必失败：`ERROR: [Douyin] 7661228096569249066: Fresh cookies (not necessarily logged in) are needed`（退出码 1）。
2. 浏览器引擎抓到了 2 条媒体直链（画面 + 声音），探测也成功（13分29秒 / 1920x1080），
   但一开始下载画面流，内嵌浏览器窗口就自动关闭、主界面报「下载没成功」。
3. 控制台关键报错：
   `ERROR:network_service_network_delegate.cc(290)] Cancelling request to <douyinvod 直链> with invalid referrer https://v.douyin.com/HeZa_vy3gRY/`

## 两个根因

### ① 直链下载被 Chromium 掐断：invalid referrer

直链下载原走 `downloadViaNet`（Electron `net.request`），请求头里的 Referer 是**短链**
`https://v.douyin.com/HeZa_vy3gRY/`。Chromium 认为该来源非法，在 network delegate 层直接取消请求，
于是下载 0 字节就失败。

> 影响面：任何「用户粘的是短链、程序拿短链当 Referer」的站点都会踩这个坑。

### ② 60 秒全局超时

`downloadViaNet` 从 `net.request` 创建时就启动 60s 倒计时，只在 response/error/finish 时清除。
本样本约 150MB，即使不被取消，60s 也必超时中断。

## 两处修复（browser-engine.js）

1. **`downloadToTemp` 主路径改用 Node 原生流式下载**（复用 `kuaishou-engine.js` 的 `streamDownload`）：
   Range 断点续传 + 退避重试 + **无整体超时**，且完全不走 Chromium 网络栈；
   Node 侧失败才回退 `downloadViaNet`（此时 Referer 已修好，作兜底）。
2. **Referer 归一**：新增 `normalizeReferer()`，短链域映射主域
   （`v.douyin.com` → `https://www.douyin.com/`），`buildHeaders` 统一走它。
3. **Cookie 按落地页取**：`collectContext` 优先用内嵌浏览器当前 URL（短链 302 后的 www 域），
   短链域取不到 www 的 Cookie。

## 复用结论（下次遇到抖音直接照做，别再排查）

- 抖音是**画面 / 声音两条独立签名直链**，没有 m3u8；`media-video-*`（可能 hvc1/H.265）+ `media-audio-*`。
- 直链下载**只能走 Node 原生栈**，别退回 Electron `net.request` 当主路径。
- 直链带签名有效期：失败重跑要**重新播放一次**刷新签名（浏览器窗口别先关）。
- 登录弹窗可以直接关掉，不影响播放与抓取。
- hvc1（H.265）画面流 + m4a 声音流用 `ffmpeg -c copy` 合成正常，无需重编码。
- 站点规则库已内置 `douyin-av-split`（`forceEngine: "browser"`），命中后跳过 yt-dlp 那次必败尝试。
