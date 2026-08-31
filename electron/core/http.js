"use strict";
/**
 * HTTP 请求封装（纯代码，不花 token）
 * 为什么单独封装：浏览器拦截引擎抓到的 m3u8 / 分片 / key，必须带上站点 Cookie（含 cf_clearance）、
 * Referer、User-Agent 重发，才能绕过 CDN 的来源校验与防盗链。用原生 https/http 模块，零额外依赖。
 */
import https from "node:https";
import http from "node:http";

/**
 * 发起一次请求，返回 {status, headers, body(Buffer)}。
 * 关键点：手动跟随 3xx 重定向（原生模块不自动跳，很多分片 URL 会跳一次 CDN）。
 */
export function requestBuffer(url, opts, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.request(
      url,
      {
        method: opts.method || "GET",
        headers: opts.headers || {},
        timeout: opts.timeoutMs || 20000,
      },
      (res) => {
        // 重定向跟随，最多 5 次，防止死循环
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirects >= 5)
            return reject(new Error("too many redirects: " + url));
          const next = new URL(res.headers.location, url).toString();
          // 跨协议/跨域重定向时保留 Cookie 之外的通用头，但 Referer 保持原站
          const headers = { ...(opts.headers || {}) };
          return resolve(
            requestBuffer(next, { ...opts, headers }, redirects + 1),
          );
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout: " + url)));
    req.on("error", reject);
    req.end();
  });
}

/** 拿二进制内容，非 2xx 直接抛错（带 status），供 downloader 做重试/失败判定 */
export async function getBuffer(url, opts = {}) {
  const r = await requestBuffer(url, opts);
  if (r.status >= 400) {
    const e = new Error(`HTTP ${r.status} for ${url}`);
    e.status = r.status;
    throw e;
  }
  return r.body;
}

/** 拿文本内容（m3u8 等），不因 4xx 抛错，调用方自行看 status 决定下一步 */
export async function getText(url, opts = {}) {
  const r = await requestBuffer(url, opts);
  return {
    status: r.status,
    text: r.body.toString("utf8"),
    headers: r.headers,
  };
}
