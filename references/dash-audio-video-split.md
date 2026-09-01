# 音视频分离（DASH）站点下载：抖音等「画面/声音分开送」怎么下全

## 这是什么问题

某些站点（抖音网页版、以及类 DASH 架构的视频站）不把「一个完整 mp4」直接给你，而是把同一条视频拆成**多条独立流**：

| 流 | 内容 | 抓错时会得到 |
|---|---|---|
| 预览片段 | 约 10~11 秒、有画面的短视频 | 11 秒有声（其实只是预览） |
| 纯画面流 | 完整时长、只有画面、没有声音 | 2:02 无声 |
| 纯声音流 | 完整时长、只有声音、没有画面 | 2:02 纯音频（mp4 后缀却没画面） |

老版本只「抓第一条命中的媒体链接就落盘」，所以同一 URL 每次抓到哪条是哪条，三种结果随机出现。

## 根因

- 抖音/DASH 用的是「音视频分离」，画面轨道和声音轨道各是一条独立的 HTTP 直链（两者的 content-type 都可能是 `video/mp4`、`audio/mp4`，甚至 `application/octet-stream`）。
- **光看 URL 后缀或 content-type，无法可靠区分它是「画面」还是「声音」**——必须用 ffmpeg 真正读内容，数出里面有没有视频轨、有没有声音轨。

## 现在的处理流程

1. **收集**：浏览器网络拦截把 `video/*`、`audio/*`（以及 octet-stream 且 URL 像媒体的）统一收进一个候选池，`content-type` 只留作弱提示。
2. **探测**：下载前对每条候选流并行跑 `ffmpeg -i` 读头部，得到四项：时长、分辨率、`hasVideo`（有无画面轨）、`hasAudio`（有无声音轨）。
3. **分流**（以探测结果为准，不再信 URL 后缀）：
   - `hasVideo = true` → 归「画面」候选；
   - `hasAudio = true` 且 `hasVideo ≠ true` → 归「声音」候选，**绝不混进画面点选列表**（这一条修掉了「下成 mp4 却只有声音」的坑）。
4. **点选**：画面候选有多条时，弹「点选」列表，**按时长从长到短排序**，每条显示 `时长 · 分辨率 · 有无声音`；只有一条画面就直接自动选，不打扰用户。
5. **下载 + 合成**：下载选中的画面流 + 最长的一条声音流，`ffmpeg -i 画面 -i 声音 -c copy -movflags +faststart` 合成一个完整 mp4（不重编码，秒级无损）。画面流若已自带声音，则直接输出、不再合成。

## 关键代码位置

| 文件 | 函数 | 作用 |
|---|---|---|
| `electron/core/ffmpeg.js` | `probeMedia` | 读头部拿时长/分辨率/有无画面/有无声音 |
| `electron/core/ffmpeg.js` | `mergeAV` | 纯画面 + 纯声音合成一个 mp4 |
| `electron/engines/browser-engine.js` | `downloadAndMergeAV` | 分流 → 点选 → 下载 → 合成主流程 |
| `electron/engines/browser-engine.js` | `probeCandidates` / `askPickVideo` | 探测候选流、按时长排序点选 |
| `electron/engines/browser-engine.js` | `isLikelyMedia` / `ctKind` | 收集前的媒体粗筛与弱提示 |

## 边界与兜底

- 探测失败（个别 CDN 的 moov 在文件尾部导致读头部超时）：时长显示「未知」，仍可点选；页面 `video.duration` 等已解码数据存在时优先采用它。
- 只有声音、没有画面：直接存音频并明确提示。
- 有画面但没抓到独立声音流：输出纯画面并提示「可能无声音」（该站本就不分离时属正常）。