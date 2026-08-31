'use strict';
/**
 * HLS (m3u8) 解析模块（纯代码）
 * 负责三件事：
 *  1) 解析 playlist：区分 master/子流、拿分段 URI、识别「没有 EXT-X-ENDLIST」的直播滑窗、版本/媒体序号/时长；
 *  2) 解析 EXT-X-KEY（AES-128）与 EXT-X-MAP（fMP4 初始化分片）；
 *  3) 相对 URL 解析 + AES-128-CBC 解密（供裸分段兜底路径使用；正常路径交给 ffmpeg 解密）。
 */
const crypto = require('crypto');

/** 解析 attribute-list（形如 METHOD=AES-128,URI="key.bin",IV=0x...），URI 可能带引号/逗号 */
function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, v.length - 1);
    out[m[1]] = v;
  }
  return out;
}

function parseKey(val) {
  const attrs = parseAttrs(val);
  if (!attrs.METHOD || attrs.METHOD === 'NONE') return null;
  return {
    method: attrs.METHOD,
    uri: attrs.URI || null,
    // HLS 规范：无 IV 时用「媒体序号」作 IV；解析阶段先存显式 IV，序号 IV 在本地化时再算
    iv: attrs.IV ? Buffer.from(attrs.IV.replace(/^0x/i, ''), 'hex') : null
  };
}

function parseMap(val) {
  const attrs = parseAttrs(val);
  return attrs.URI ? { uri: attrs.URI } : null;
}

/** 主函数：解析 m3u8 文本为结构化对象 */
function parsePlaylist(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  const out = {
    version: null,
    targetDuration: null,
    playlistType: null,
    mediaSequence: 0,
    endList: false,       // 有无 EXT-X-ENDLIST —— false = 直播滑窗
    isMaster: false,
    playlists: [],        // master 子流
    segments: [],         // 媒体分段
    map: null,            // 当前有效初始化分片
    raw: String(text)
  };
  let currentKey = null;
  let currentMap = null;
  let pendingStreamInfo = null;
  let pendingDuration = null;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#')) {
      const idx = line.indexOf(':');
      const tag = idx >= 0 ? line.slice(0, idx) : line;
      const val = idx >= 0 ? line.slice(idx + 1).trim() : '';
      if (tag === '#EXT-X-VERSION') out.version = val;
      else if (tag === '#EXT-X-TARGETDURATION') out.targetDuration = parseFloat(val);
      else if (tag === '#EXT-X-PLAYLIST-TYPE') out.playlistType = val;
      else if (tag === '#EXT-X-MEDIA-SEQUENCE') out.mediaSequence = parseInt(val, 10) || 0;
      else if (tag === '#EXT-X-ENDLIST') out.endList = true;
      else if (tag === '#EXT-X-STREAM-INF') { out.isMaster = true; pendingStreamInfo = parseAttrs(val); }
      else if (tag === '#EXT-X-KEY') currentKey = parseKey(val);
      else if (tag === '#EXT-X-MAP') { currentMap = parseMap(val); if (currentMap) out.map = currentMap; }
      else if (tag === '#EXTINF') pendingDuration = parseFloat(val) || null;
      // 其余 tag（DISCONTINUITY 等）忽略，交给 ffmpeg 处理
    } else if (out.isMaster) {
      out.playlists.push({ uri: line, attrs: pendingStreamInfo || {} });
      pendingStreamInfo = null;
    } else {
      const seq = out.mediaSequence + out.segments.length;
      out.segments.push({ uri: line, seq, duration: pendingDuration, key: currentKey, map: currentMap });
      pendingDuration = null;
    }
  }
  return out;
}

/** 相对 URI 解析为绝对 URL（基于播放列表地址） */
function resolveUri(baseUrl, uri) {
  if (/^https?:\/\//i.test(uri)) return uri;
  return new URL(uri, baseUrl).toString();
}

function isMasterPlaylist(parsed) {
  return parsed.isMaster || parsed.playlists.length > 0;
}

/** 从 master 子流里选码率最高的一路（普通人是「要最清晰」，直接选带宽最高） */
function pickBestVariant(parsed) {
  const list = parsed.playlists.slice().sort((a, b) => (parseInt(b.attrs.BANDWIDTH, 10) || 0) - (parseInt(a.attrs.BANDWIDTH, 10) || 0));
  return list[0] || null;
}

/** AES-128-CBC 解密一段（裸分段兜底路径用） */
function aesDecrypt(encrypted, key, iv) {
  const k = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
  const decipher = crypto.createDecipheriv('aes-128-cbc', k, iv || Buffer.alloc(16));
  decipher.setAutoPadding(false); // TS 分段可能非整块，关自动填充按原样输出
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/** 按 HLS 规范用 mediaSequence 生成缺省 IV（16 字节大端） */
function sequenceIV(seq) {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(seq >>> 0, 12);
  return b;
}

module.exports = { parsePlaylist, parseAttrs, parseKey, parseMap, resolveUri, isMasterPlaylist, pickBestVariant, aesDecrypt, sequenceIV };