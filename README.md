# AI 视频下载器

给「不懂代码的人」用的 Windows 桌面视频下载器：**粘贴网址 → 点下载 → 得到完整视频文件**。
单用户自用，不碰多账号。Electron（内嵌 Chromium 过 Cloudflare）+ Vue3 + Node 后端，不依赖 Python。

> 仅供个人学习。

---

## 仓库地址

https://github.com/steelan9199/ai-download-everything

## 一句话原理：三层分工，严格省 token

| 角色 | 谁来做 | 花不花 token | 干什么 |
|---|---|---|---|
| 程序内置代码 | 本仓库里的确定性代码 | 免费、不限次 | 打开页面、拦截网络、抓 m3u8/分片、下载、合并、续传重试、查规则表、跑已沉淀脚本 |
| 人工的眼睛与手 | 你本人 | 免费、最快 | 看画面认内容、登录、点验证码、扫码、成人确认 |
| 大模型 | OpenAI 兼容接口 | **唯一烧 token** | 只在规则表/点选都搞不定、确实要「动脑写代码」时才按需调用，一次只解决一件最小的事 |

---

## 目录结构

```
ai-download-video/
├── package.json
├── README.md
├── electron/
│   ├── main.js                 # 主进程入口（含 --selfcheck 命令行自检）
│   ├── preload.js              # contextBridge 白名单桥（安全边界）
│   ├── ipc.js                  # IPC 注册 + 点选提问桥
│   ├── settings.js             # 设置持久化
│   ├── startup-check.js        # 启动自检（ffmpeg/yt-dlp/目录）
│   ├── core/                   # hls.js downloader.js ffmpeg.js http.js
│   ├── engines/                # ytdlp-engine.js browser-engine.js orchestrator.js
│   ├── knowledge/              # rules.js(错误码规则表) site-rules.js(站点规则库沉淀)
│   └── ai/                     # advisor.js(大模型顾问) sandbox.js(受限沙箱)
├── renderer/                   # Vue3 极简界面（index.html / app.js / styles.css）
├── site-rules/                 # 站点规则示例与说明
└── scripts/smoke-core.js       # 核心管线冒烟测试
```

---

## 环境要求

| 依赖 | 说明 | 验证 |
|---|---|---|
| Node.js ≥ 18 | 仅开发阶段需要 | `node -v` |
| ffmpeg | 分片合并/转封装/解密，**不内置，外置路径** | `ffmpeg -version` |
| yt-dlp.exe | 普通站主力下载引擎，**不内置** | `yt-dlp --version` |

> 本项目**绝不把二进制塞进包**。缺失时启动会弹「指引」，给出下载链接 + 安装命令 + 去填写路径入口。

---

## 快速开始

```powershell
cd D:\ai\ai-download-video
npm install
npm start
```

国内下载 Electron 慢时，先设镜像再装：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

### 安装 ffmpeg / yt-dlp（二者已在 PATH 里可跳过）

```powershell
# 管理员 PowerShell
winget install Gyan.FFmpeg
winget install yt-dlp.yt-dlp
```

装完如果程序没自动识别，在「设置」页里手动「浏览」填上 `ffmpeg.exe` 与 `yt-dlp.exe` 的完整路径即可。

---

## 配置

「设置」页集中配置，所有路径**手动填写 + 浏览**都支持：

- **下载目录**（必填）：默认 `~\Downloads\AI下载视频`，点「浏览」定位。
- **ffmpeg 路径 / yt-dlp.exe 路径**：留空 = 走系统 PATH 自动探测。
- **大模型 API Key / baseURL**：OpenAI 兼容接口，支持 OpenAI / DeepSeek / Kimi / 通义等，换 baseURL + key 即可。默认模型 `gpt-4o-mini`。**默认关闭自动调用**，只在「问 AI」按钮或异常兜底时触发。
- **临时授权本机全权**：默认关，作用域限本次任务，结束自动复位。

命令行自检（不看界面也能验证环境）：

```powershell
npm run selfcheck
```

---

## 使用

1. 粘贴网址 → 点「下载」。默认先走 yt-dlp 直下（覆盖绝大多数普通站）。
2. yt-dlp 失败 / 命中 Cloudflare、HLS 难站 → 自动切「浏览器拦截」：弹出内嵌 Chromium 窗口打开页面，自动点播放，后台抓 `.m3u8` 与分片。
3. 需要真人时，程序用**「点选 + 自定义补充」**问你一眼（例如「视频在播了吗：在播/转圈/报错/弹验证码」），点一下或补一句即可，不抛开放式填空。
4. 程序并发拉全部分片，交给 ffmpeg 合并，输出到「下载目录」。

### 高级模式

勾选「高级模式」可看到：

- 引擎切换（yt-dlp / 浏览器拦截 / AI 脚本）
- 诊断摘要（状态码 + 出错 URL + 一句可能原因）
- 大模型调用次数、脚本执行日志、权限状态
- 「问 AI」按钮 / 临时全权开关

---

## 关键场景怎么兜住

- **Cloudflare 403 / Bot Fight Mode**：内嵌 Chromium 真实指纹 + 持久化 profile 复用 Cookie（`cf_clearance`）。
- **HLS 直播滑窗（只漏几秒、无 EXT-X-ENDLIST）**：程序持续刷新 playlist 拿全部分段；两条路径——
  - **边播边存（实时）**：浏览器播到哪抓到哪，最稳妥但要等播放走完；
  - **破解定位/会话参数全速抓**：拿到 Cookie/请求头后并发直拉全部分段，快但依赖会话有效。
- **AES-128 加密流**：自动下 key，本地化 m3u8 后交给 ffmpeg 一步解密+合并。
- **断点续传 / 失败重试 / 多线程 / >1GB**：按分片粒度续传、指数退避重试、并发下载、原子落盘。

---

## 错误处理顺序（先查表 → 再请人 → 再 AI）

1. 出错了先查**错误码规则表** + **站点规则库**（本地、即时应答）：命中直接按沉淀方案执行。
2. 查不到 → 生成极短「诊断摘要」，**请你点选**眼前情况。
3. 点选仍无解 → 才调大模型，在**受限白名单**内写一个最小脚本去抓取/验证，成功后**自动沉淀进规则库**。
4. 大模型也搞不定 → 转纯人工指引，不无限循环烧 token。

---

## AI 脚本安全边界

- **默认白名单**：AI 脚本只能读写「下载目录」、调用 ffmpeg / yt-dlp.exe、发 HTTP 请求。越界动作一律拦截并弹窗请用户确认。
- **临时授权本机全权**：默认关、作用域限本次任务、任务结束自动复位；高级模式里会提示「当前已临时全权」。
- **执行确认**：白名单内自动执行不打扰；越界/全权先弹确认再执行。
- **脚本沉淀**：AI 每攻克一个新站，脚本存进站点规则库，下次同站直接复用、不再调大模型。
- 说明：这是**单用户自用**工具，沙箱是尽力而为的软件隔离（`vm` + 禁止动态代码生成 + 只暴露闭包 api），不是多租户级硬边界。

---

## Demo 验证

### 1）核心管线冒烟（不碰 Cloudflare 的纯链路验证）

```powershell
node scripts/smoke-core.js
```

它会：解析一段含 AES 的 m3u8 → 下载真实公测流的播放列表 → 并发下分段 → ffmpeg 合并 → 报出时长/体积。
通过即说明「抓流→合并」核心链路是通的。

### 2）Cloudflare + HLS 难站端到端自测

1. `npm start` 启动；确保「设置」里 ffmpeg、yt-dlp 可用。
2. 粘贴目标站播放页 URL → 下载。程序自动切浏览器拦截，弹出内嵌窗口。
3. 若弹验证码/登录/成人确认，在窗口里点一下；程序问「播了吗」时点选。
4. 若 403 持续：回到窗口刷新/重新过验证让 `cf_clearance` 更新，或按提示用「猫抓 / F12」复制一条 `.m3u8`（或 Copy as cURL）粘进来重试。
5. 成功后可在高级模式看到「抓到 m3u8 → 分片数 → ffmpeg 合并 → 产物路径」日志。

> 目标站可能含不适宜内容，请仅在你有权访问、且以个人学习为目的时自测。

---

## 打包成 exe

用 `electron-builder`（按需安装）：

```powershell
npm i -D electron-builder
```

`package.json` 增加：

```json
{
  "build": {
    "appId": "com.personal.ai-video-downloader",
    "win": { "target": "portable" },
    "files": ["electron/**", "renderer/**", "site-rules/**", "package.json"]
  },
  "scripts": { "dist": "electron-builder --win" }
}
```

```powershell
npm run dist
```

产物在 `dist/`。**注意**：`portable`/安装包里仍**不内置 ffmpeg / yt-dlp**，让用户在设置里指向本机已装的二进制。

---

## 常见问题

- **启动白屏**：确认已 `npm install`（`node_modules/vue` 存在）。
- **点了下载没反应**：看「设置」页顶部是否提示环境缺失，按横幅指引装 ffmpeg/yt-dlp 或填路径。
- **yt-dlp 403**：切「浏览拦截」引擎，或在窗口里过验证刷新 Cookie。
- **只下到几秒**：直播滑窗，用猫抓复制具体画质 `.m3u8` 粘给程序重试。
- **问 AI 报「没配 API Key」**：去设置页填 baseURL + Key。

---

## 许可

MIT。仅个人学习使用。
