# 爱奇艺视频下载 · 上下文交接文档

> ✅ **已解决（2026-09-03）**：爱奇艺 sports 播放页下载已跑通并沉淀。最终方案见文末「## 10. 最终方案（已落地）」。
> 本文档其余部分保留为排障过程记录，供维护者理解方案由来；新会话无需再按第 6 节剧本排查。

> 目的：把「爱奇艺（sports.iqiyi.com 短视频/分享页）下载失败」的排查进度交接给下一个 AI 会话。
> **给下一个 AI 的最高原则：不要自己闭门跑探针、不要长时间自己分析。每一步都设计成「让用户做一个简单动作 → 用户回报客观事实 → 你只根据事实做最小改动」。** 原因：爱奇艺广告 40\~120 秒，无头/短探针只能抓到广告；人眼 3 秒能确认的事，AI 猜 10 分钟也可能猜错，还烧 token。

***

## 1. 任务目标

用户粘贴链接 `https://qy.net/32JRS5h-e0?vfrm=pcw_album_auto`，点下载，未成功。目标：让本项目（Electron + yt-dlp + 浏览器拦截）能把这个视频完整下载下来。

这是一条**免费、无 DRM、允许下载**的爱奇艺体育短视频（92 秒），不是付费大片，理论上一定能下到。

## 2. 已确认的事实（无需再查，直接采信）

环境（用户机器已就绪）：yt-dlp `2026.08.19`、ffmpeg `6.1.1`、Node `v22.16.0`、electron 在 `node_modules` 里。

链接跳转链：

1. `https://qy.net/32JRS5h-e0?...` → 302 → `https://m.iqiyi.com/mp/sharePlay.html?tvid=1548681443102000&...`
2. → 301 → `https://www.iqiyi.com/playShare.html?tvid=1548681443102000&...`
3. 视频信息接口（GET，带 Referer: <https://www.iqiyi.com/> 即可）：
   `https://pcw-api.iqiyi.com/video/video/baseinfo/1548681443102000`
   返回 JSON 关键字段：

   - `vid`: `785720d9691864b9e49281f1bbd8ae1c`

   - `tvId` / `albumId`: `1548681443102000`

   - `playUrl` / `albumUrl`: `https://sports.iqiyi.com/resource/pcw/play/giqcbm8h24`（真正的播放页，React 单页应用）

   - `bossStatus: "FREE"`、`downloadAllowed: true`、`supportedDrmTypes: []`、`durationSec: 92`、`videoType: "RUGC"`

已排除的路（不要再试）：

- yt-dlp 对 `playShare.html` 报 `[iqiyi] Can't find any video`；对 `sports.iqiyi.com/resource/pcw/play/...` 报 `Unsupported URL`（只命中 generic 提取器）。**yt-dlp 当前版本搞不定这个播放页。**

- 手动拼爱奇艺取流接口 `cache.video.iqiyi.com/jp/tmts/...` 只返回空壳 `var tvInfoJs=`——签名参数（`qd_k`/`qd_sc`/`qd_tm` 等）由页面 JS 生成，手拼不可行。

- 播放页 HTML 本身（curl 抓到的）只有 2.6KB 的 React 壳，视频数据全靠 JS 运行后调接口，**静态抓页没有任何媒体地址**。

## 3. 关键技术发现（Electron 真实窗口探针实测）

探针脚本：`references/iqiyi-probe.cjs`（可直接 `node_modules/electron/dist/electron.exe references/iqiyi-probe.cjs` 重跑，会弹真实窗口）。
原始结果：`references/iqiyi-probe-result.json`。探针只跑了约 35 秒，**当时广告还没播完**。

1. **没有 m3u8。** 播放器用 MSE：页面里 `<video>.src` 是 `blob:https://sports.iqiyi.com/<uuid>`，视频数据是播放器通过 XHR/fetch 拉分片后喂给 MSE 的。
2. **正片是** **`.ts`** **分片，按字节范围请求**，形如：

   ```
   https://bscdncnc.inter.71edge.com/videos/v1ts/20260902/73/61/8fda48425b6071a14b6b7b2793d8e589.ts?start=0&end=1238016&contentlength=1238016&...&qd_tvid=1548681443102000&qd_index=vod&bid=500&...
   ```

   - 同一路径、不同 `start`/`end` 就是不同分片（实测 end 递进：`1238016 → 14314496 → 27334656 → 35715864`，每段约 13MB）。

   - 同一文件也有 `pcw-data.video.iqiyi.com/videos/v1ts/...` 源。

   - 签名参数 `qd_k`/`qd_sc`/`qd_tm` 在已观测的多个分片间**相同**（疑似文件级/会话级签名，复用待验证——见第 6 节，让人验证，不要自己猜）。
3. **广告是** **`.f4v`，特征完全不同**，形如：

   ```
   https://alicoccdncnc-hb.inter.71edge.com/videos/other/20260205/35/86/9c26....f4v?...&range=0-9000&...&qd_tvid=&qd_p=&qd_k=...
   ```

   - 路径是 `/videos/other/`（正片是 `/videos/v1ts/`）；后缀 `.f4v`；**`qd_tvid`** **为空**；日期目录是旧日期（广告素材）。

   - **广告/正片判定规则（可直接写进代码）：** URL 含 `/videos/v1ts/` 且 `.ts` 且 `qd_tvid` 非空 = 正片；`/videos/other/` 或 `.f4v` 或 `qd_tvid` 为空 = 广告，丢弃。
4. 探针 35 秒内已抓到 5 个正片 `.ts`（start=0 起，累计约 35MB），而页面 `<video>` 时长显示 36 秒（广告）。**推测：广告播放期间，播放器已在预加载正片分片。** 这意味着也许不用等广告播完就能拿到正片数据——但必须由人确认（见第 6 节）。

## 4. 现有程序代码现状（`electron/engines/browser-engine.js`）

- 网络拦截挂在 `session.fromPartition("persist:download-browser")` 上：

  - `onBeforeRequest`：抓 `.m3u8`（爱奇艺没有）→ 落空；抓 `.(ts|m4s|mp4|key)` 后缀进 `segUrls`（**`.ts`** **能抓到，正片分片会进这个池子**）。

  - `onHeadersReceived`：按 content-type 抓媒体进 `mediaCandidates`。`.ts` 响应是 `application/octet-stream`，而 `isLikelyMedia()` 对 octet-stream 只认抖音特征（`looksLikeMediaUrl`），**所以** **`.ts`** **分片不会进 mediaCandidates**；广告 `.f4v` 同样不进。

- 没有 m3u8 时走 `fallbackEdgePlay(segUrls, ctx)`「边播边存」：把浏览器**实际请求过**的 `.ts` URL 全部重拉一遍合并。

  - 问题 A：**不区分广告/正片**——目前 `.f4v` 广告压根没被抓（后缀不在正则里），算侥幸；但如果广告也用 `.ts`，就会混进合并结果。需要加第 3.3 节的过滤规则。

  - 问题 B：边播边存只能拿到「播放器已经请求过」的分片。92 秒正片如果没缓冲完，分片就不全。需要人把正片播完/拖一遍进度条，或走第 6 节的「枚举字节范围主动拉全片」。

  - 问题 C：合并时 `segUrls` 按捕获顺序编号，爱奇艺分片 URL 自带 `start` 字节偏移，**应按** **`start`** **参数排序**而不是捕获顺序，否则可能顺序错乱。

- 内置浏览器窗口刚加了**地址栏（可改网址、后退/前进/刷新）**，壳页面是 `electron/browser-shell.html`，页面在同分区 `<webview>` 里；自动点播放/抓页面媒体作用在 webview 的 guest webContents 上。人可以在窗口里直接操作。

## 5. 对用户猜测的裁定

用户猜测：「只能在视频已经播放之后再去抓视频数据。」

**基本正确，且应作为工作假设**：MSE 模式下数据是播放器播放/缓冲时才发出网络请求的，不播放就没有分片可抓。补充一点：实测广告期间正片分片可能已被预加载（第 3.4 节），所以「广告播完」不一定是必要条件，但「播放器开始加载正片」是必要条件。**到底预加载了多少、不看广告行不行——让人看一眼就知道，不要 AI 自己跑长探针等广告。**

## 6. 给下一个 AI 的人机协作剧本（严格按此节奏，省 token）

**规则：每次只让用户做一个动作、回报一个客观事实；用点选式问题（程序里有** **`askUser`** **点选桥），不要让用户写长答案。用户回报前，不要改代码、不要跑探针。**

**第 1 步｜让人用真实程序跑一遍（拿最真实的一手反馈）**
请用户：`npm start` → 设置页确认 ffmpeg/yt-dlp 正常 → 粘贴原始链接 `https://qy.net/32JRS5h-e0?vfrm=pcw_album_auto` → 勾选高级模式 → 点下载。
请用户回报（点选）：

- 内置浏览器窗口里出现了什么？① 爱奇艺广告在播 ② 正片在播 ③ 报错/验证码/登录 ④ 页面空白

- 广告大概多少秒？（让用户等广告播完、正片开始播放，期间不用操作）

- 高级模式日志里：有没有出现「抓到 m3u8」？「edge-play / 分片」类日志出现时分片数量大概多少？

- 最终：下载成功了吗？产物文件时长多少秒、能不能播、内容是正片还是广告？

**第 2 步｜根据反馈分支**

- 如果产物是广告或时长只有几十秒：说明边播边存抓到的分片不全/混了广告。进入第 3 步。

- 如果报错/没抓到任何分片：请用户在内置浏览器里**等广告播完、正片开始播放后，把进度条从开头拖到末尾拖一遍**（强制播放器请求全部分片），然后回报日志里分片数量有无增加。

- 如果用户那边页面要求登录/验证码：让用户在窗口里手动完成（这正是「人工的眼睛与手」的设计用途），完成后回报。

**第 3 步｜让用户帮忙取一条「正片分片」铁证（只需 1 次，30 秒）**
请用户在内置浏览器窗口正片播放时按 F12（若窗口里 F12 无效，就让用户用系统 Chrome 打开同一个播放页 `https://sports.iqiyi.com/resource/pcw/play/giqcbm8h24`）→ Network → 过滤 `v1ts` 或 `.ts` → 右键任意一条 → Copy → **Copy as cURL**，粘回来。
AI 拿到后只做两件事（不反复请求）：

- 确认 URL 符合第 3.2 节正片特征；

- 对比两条不同分片的 cURL：`qd_k`/`qd_sc`/`qd_tm` 是否相同、是否只有 `start`/`end`/`range` 不同。

  - 若签名相同 → 「字节范围枚举主动拉全片」可行（第 7 节改动 C），这是最稳的全速方案。

  - 若签名随分片变化 → 放弃枚举，老老实实边播边存 + 让人拖进度条。

**第 4 步｜做最小代码改动 → 请用户再跑一遍验证**（改动清单见第 7 节，一次只改必要的）。

## 7. 候选代码改动（拿到第 6 步反馈后再动手，不要提前改）

- 改动 A（几乎必做）：`browser-engine.js` 的 `segUrls` 收集处加广告过滤——只保留含 `/videos/v1ts/` 或（`.ts` 且 `qd_tvid` 非空）的 URL；`/videos/other/`、`.f4v`、`qd_tvid=` 为空的丢弃。并对爱奇艺分片按 URL 的 `start` 参数数值排序后再合并。

- 改动 B（边播边存兜底增强）：检测到爱奇艺分片但长时间无新增时，点选提示用户「请把视频进度条从头拖到尾，让分片加载完」，而不是直接用不全的分片合并。

- 改动 C（仅当第 3 步证实签名可复用）：写一个爱奇艺专用「字节范围枚举」下载器——以第一条 `.ts` URL 为模板，按 `contentlength`/`end` 步进构造后续 `start`/`end` 并发拉取，直到覆盖总大小（总大小线索：最后一段 `end` 值或接口信息），交 ffmpeg  concat 合并。成功后按项目约定**沉淀进站点规则库**（`electron/knowledge/site-rules.js`），下次爱奇艺零分析直接复用。

- 改动 D（可选，产品向）：点选问题里增加「现在是广告还是正片」的选项，让人一句话区分，比 AI 猜 URL 更可靠。

## 8. 注意事项

- 内置浏览器分区 `persist:download-browser` 会复用 Cookie/Cookie 清关状态；爱奇艺这个视频 FREE，预计不需要登录。

- 主进程 + 浏览器引擎两层已静默拦截自定义协议弹窗（`bytedance://` 之类），爱奇艺暂无此问题，若冒出新协议弹窗见 `references/block-external-protocol-popups.md`。

- 合并产物用 ffmpeg concat `.ts`（同编码直接 copy 即可，参考 `electron/core/ffmpeg.js` 现有 `mergePlaylist`）。

- 验证最终产物的客观标准：**时长 ≈ 92 秒、画面是正片内容（不是广告）、有声音**。让用户播放确认，不要 AI 自己猜。

## 9. 附件

- `references/iqiyi-probe.cjs`：Electron 真实窗口探针（弹窗口、自动播放、截获 m3u8/分片/媒体地址，结果写 `iqiyi-probe-result.json`）。重跑命令：
  `node_modules\electron\dist\electron.exe references\iqiyi-probe.cjs`
  注意：它只等约 35 秒；要等广告播完请把脚本里的循环时长改大（但优先按第 6 节让人操作，而不是加长探针）。

- `references/iqiyi-probe-result.json`：35 秒探针的完整截获结果（含正片/广告 URL 样本）。

## 10. 最终方案（已落地，2026-09-03 用户实测通过）

**根因**：爱奇艺播放器用 MSE，把**同一个 `.ts` 文件按字节区间**（同一 CDN 路径、不同 `start`/`end` 参数）分段拉取后喂给 SourceBuffer，全程无 m3u8。旧逻辑把这些字节区间当独立分片丢给 ffmpeg m3u8/concat 合并，而区间中段从 TS 包中间开始、不是独立可解文件，所以 ffmpeg 报 `Invalid data found when processing input`。另外 `pcw-data.video.iqiyi.com` 同名 `.ts` 路径返回的是 JSON 调度响应（CDN 节点列表），被误当成分片。

**已落地改动**（全部确定性代码，不花 token）：

1. `electron/engines/browser-engine.js`
   - `isIqiyiScheduler()`：剔除 `pcw-data.video.iqiyi.com`（返回 JSON，非媒体）。
   - `isIqiyiAd()`：剔除广告（`/videos/other/`、`.f4v`、`qd_tvid` 为空）。
   - `iqiyiByteRangeMerge()`：识别 `/videos/v1ts/` → 按 `start` 排序重拉 → 逐文件校验开头（`{`/`<` 开头的 JSON/HTML 错误响应丢弃）→ **原始字节拼接**成完整 TS → ffprobe 时长校验（短于页面 `<video>` 时长 85% 判为分片不全，提示拖进度条）→ remux 成 mp4。
   - `getPageDuration()`：读页面 `<video>.duration` 作为完整性校验基准。
   - 关键节点（切引擎、捕获计数、等待确认、拼接、时长）全部打日志；点选弹框可点外部收起（底部浮条召回）。
2. `electron/core/ffmpeg.js`：新增 `remuxTs()`——TS 直封 mp4 先 `-c copy`；AAC 流缺采样率字段导致直封失败时，自动 `-c:v copy -c:a aac -ar 48000`（只重编码音频，视频不重编码）。
3. `electron/knowledge/site-rules.js` + `orchestrator.js`：新增内置规则 `iqiyi-byte-range-ts`（匹配 `iqiyi.com|qy.net`，`forceEngine: "browser"`），命中后编排器直接跳过必败的 yt-dlp，进入浏览器引擎（用户显式手选 yt-dlp 时尊重选择）。

**实测结果**：5 段字节区间拼接 35,715,864 字节，整片 92 秒（页面 93 秒），h264 720×1280 + AAC，能播、有声、正片。签名 `qd_k`/`qd_sc`/`qd_tm` 在同一次播放会话内各区间相同，故按捕获到的区间重拉全部成功；若日后签名过期，重拉会拿到 JSON 错误响应，程序会明确提示回窗口刷新重放。

**使用方式**：粘贴 `qy.net` 短链或 `sports.iqiyi.com` 播放页 → 下载 → 弹浏览器窗口后**把进度条从头拖到尾拖一遍**（逼播放器请求全部字节区间）→ 点「已经在播放了」→ 点「直接试边播边存」。规则库命中后连 yt-dlp 失败这一步都不再出现。

