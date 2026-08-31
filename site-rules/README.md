# 站点规则库（脚本沉淀）

这里放「可复用的站点经验」，省 token 的关键一环：大模型每攻克一个新站/新问题，程序会把可复用脚本/配置自动写进
`userData/site-rules.json`，下次命中同站直接复用，不再调用大模型。

## 规则格式

```json
{
  "id": "唯一ID，如 ai-<host> 或 example-generic-hls",
  "host": "站点域名，如 example.com",
  "match": "用于匹配 URL 的正则字符串，如 example\\.com",
  "kind": "settings 或 script",
  "note": "一句话说明这条规则是干嘛的",
  "settings": { "referer": "...", "extraHeaders": {} },
  "script": "当 kind=script 时，一段只依赖 api 对象的 Node.js 脚本"
}
```

## 两类规则

- **settings 类**：纯配置（特殊 Referer / 请求头 / m3u8 正则），程序命中后直接套用，零脚本、零 token。
- **script 类**：AI 沉淀的最小可复用脚本，命中后交给「受限沙箱」执行。

## 脚本可用的 api（白名单）

```js
api.log(msg)                                // 打印日志到高级模式
api.http.get(url, {headers})                // -> {status, text}
api.http.getBuffer(url, {headers})          // -> Buffer
api.fs.writeFile(name, data) / readFile(name) / list() / exists(name)  // 只能落在下载目录
api.exec('ffmpeg' 或 'yt-dlp', [args])      // 只能跑这两个程序
api.downloadDir                             // 下载目录绝对路径
```

> 本目录下的 `*.example.json` 仅作格式示范；真正的规则由程序在运行中沉淀管理，手动改 `userData/site-rules.json` 同格式即可。