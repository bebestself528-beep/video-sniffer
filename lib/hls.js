/* ============================================================
 * 视频嗅探下载器 - HLS(m3u8) 解析与下载核心
 * 纯逻辑模块，不依赖任何 Chrome API：
 *   - 在 offscreen 文档中运行（浏览器环境）
 *   - 在 Node 中运行（单元测试）
 * 挂载为全局：HLSKit
 * ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- 基础工具 ---------------- */

  function resolveUrl(uri, base) {
    try { return new URL(uri, base).href; } catch (e) { return uri; }
  }

  function unquote(s) {
    if (!s) return s;
    s = String(s).trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
    return s;
  }

  function parseAttrs(str) {
    const out = {};
    const re = /([A-Za-z0-9_-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      out[m[1].toUpperCase()] = unquote(m[2]);
    }
    return out;
  }

  function parseByteRange(str) {
    const m = /^(\d+)(?:@(\d+))?/.exec(String(str).trim());
    if (!m) return null;
    return {
      length: parseInt(m[1], 10),
      offset: m[2] != null ? parseInt(m[2], 10) : null
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isTsData(buf) {
    if (!buf || buf.byteLength < 1) return false;
    if (buf[0] !== 0x47) return false;
    return buf.byteLength < 188 || buf[188] === 0x47;
  }

  function sniffExt(bytes) {
    if (!bytes || bytes.byteLength < 12) return '';
    /* fMP4 / ISO BMFF：offset 4 处是 'ftyp' */
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'mp4';
    /* WebM / Matroska：EBML 头 */
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
    if (isTsData(bytes)) return 'ts';
    return '';
  }

  /* ---------------- m3u8 解析 ---------------- */

  /*
   * 返回：
   *  master: { kind:'master', variants:[…], mediaGroups:[…], audioGroups:[…] }
   *  media : { kind:'media', segments:[…], initSegment,
   *            isLive, totalDuration, targetDuration }
   *
   * master 的 audioGroups 只含「有独立 URI」的音频组 —— 主流 HLS 用
   *   #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",URI="audio/index.m3u8"
   *   #EXT-X-STREAM-INF:BANDWIDTH=…,AUDIO="aac"
   * 把声音从画面里拆出去，画面 variant 本身不含声音。不解析它就只能下到无声视频。
   */
  function parsePlaylist(text, baseUrl) {
    if (typeof text !== 'string') throw new Error('播放列表内容为空');
    text = text.replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('不是有效的 m3u8 播放列表');

    const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
    if (isMaster) {
      const variants = [];
      const mediaGroups = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];

        /* 备用轨道声明：音频组 / 字幕 / 副视角，可带独立 URI */
        if (l.startsWith('#EXT-X-MEDIA')) {
          const a = parseAttrs(l.slice(l.indexOf(':') + 1));
          mediaGroups.push({
            type: (a.TYPE || '').toUpperCase(),
            groupId: a['GROUP-ID'] || '',
            name: a.NAME || '',
            language: a.LANGUAGE || '',
            uri: a.URI ? resolveUrl(unquote(a.URI), baseUrl) : '',
            channels: a.CHANNELS || '',
            isDefault: a.DEFAULT === 'YES',
            autoselect: a.AUTOSELECT === 'YES',
            forced: a.FORCED === 'YES'
          });
          continue;
        }

        if (!l.startsWith('#EXT-X-STREAM-INF')) continue;
        const attrs = parseAttrs(l.slice(l.indexOf(':') + 1));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        const uri = lines[j];
        if (!uri) continue;
        variants.push({
          url: resolveUrl(uri, baseUrl),
          bandwidth: parseInt(attrs.BANDWIDTH, 10) || 0,
          resolution: attrs.RESOLUTION || '',
          codecs: attrs.CODECS || '',
          name: attrs.NAME || '',
          frameRate: attrs['FRAME-RATE'] || '',
          audioGroupId: attrs.AUDIO || '',
          subtitleGroupId: attrs.SUBTITLES || '',
          audioOnly: !attrs.RESOLUTION
        });
        i = j;
      }
      if (!variants.length) throw new Error('主播放列表中没有找到清晰度信息');

      /* 只保留有独立 URI 的音频组：没有 URI 说明声音是复用在 variant 内部的 */
      const audioGroups = mediaGroups.filter((g) => g.type === 'AUDIO' && g.uri);
      return { kind: 'master', variants, mediaGroups, audioGroups };
    }

    /* 媒体播放列表：按行顺序处理后一个分片 URI 之前的标签状态
       （EXTINF / EXT-X-BYTERANGE / EXT-X-KEY 等可交错出现，按顺序生效） */
    let seq = 0;
    let isLive = true;
    let targetDuration = 0;
    let initSegment = null;
    let totalDuration = 0;
    let pendingKey = null;
    let pendingRange = null;
    let pendingDuration = null;
    const segments = [];

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#')) {
        if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
          seq = parseInt(l.slice(l.indexOf(':') + 1), 10) || 0;
        } else if (l.startsWith('#EXT-X-ENDLIST')) {
          isLive = false;
        } else if (l.startsWith('#EXT-X-TARGETDURATION')) {
          targetDuration = parseFloat(l.slice(l.indexOf(':') + 1)) || 0;
        } else if (l.startsWith('#EXT-X-KEY')) {
          const a = parseAttrs(l.slice(l.indexOf(':') + 1));
          if (a.METHOD && a.METHOD !== 'NONE') {
            pendingKey = {
              method: a.METHOD,
              uri: a.URI ? resolveUrl(unquote(a.URI), baseUrl) : null,
              iv: a.IV || null
            };
          } else {
            pendingKey = null;
          }
        } else if (l.startsWith('#EXT-X-MAP')) {
          const a = parseAttrs(l.slice(l.indexOf(':') + 1));
          if (a.URI) {
            initSegment = {
              url: resolveUrl(unquote(a.URI), baseUrl),
              byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null
            };
          }
        } else if (l.startsWith('#EXT-X-BYTERANGE')) {
          pendingRange = parseByteRange(l.slice(l.indexOf(':') + 1));
        } else if (l.startsWith('#EXTINF')) {
          pendingDuration = parseFloat(l.slice(l.indexOf(':') + 1)) || 0;
        }
        continue;
      }

      /* 非 # 开头 = 分片地址 */
      const segUrl = resolveUrl(l, baseUrl);
      if (pendingRange && pendingRange.offset == null) {
        /* BYTERANGE 缺省 offset 时，续用同一文件上一分片的结束位置 */
        const prev = segments[segments.length - 1];
        if (prev && prev.byterange && prev.url === segUrl) {
          pendingRange.offset = prev.byterange.offset + prev.byterange.length;
        } else {
          pendingRange.offset = 0;
        }
      }
      segments.push({
        url: segUrl,
        duration: pendingDuration || 0,
        key: pendingKey ? Object.assign({}, pendingKey) : null,
        byterange: pendingRange,
        seq: seq + segments.length
      });
      totalDuration += pendingDuration || 0;
      pendingRange = null;
      pendingDuration = null;
    }

    if (!segments.length) throw new Error('播放列表中没有找到分片（可能是空列表或直播尚未开始）');

    const methods = {};
    segments.forEach((s) => { if (s.key) methods[s.key.method] = true; });
    const keyMethods = Object.keys(methods);

    return {
      kind: 'media',
      segments,
      initSegment,
      isLive,
      totalDuration,
      targetDuration,
      keyMethods
    };
  }

  /* ---------------- 分片下载（含 AES-128 解密 / BYTERANGE / 重试） ---------------- */

  function sequenceIV(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq >>> 0);
    return iv;
  }

  function hexToBytes(hex) {
    const h = String(hex).replace(/^0[xX]/, '');
    const out = new Uint8Array(Math.floor(h.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  const KEY_CACHE = new Map();

  /* 解密 +（必要时）去掉 PKCS#7 填充。
     HLS 规范要求整个分片用 AES-128-CBC 加密并做 PKCS#7 填充（RFC 8216 §5.2）。

     坑在于**运行环境已经替我们去了一次填充**：实测 Chrome 与 Node 的
     crypto.subtle.decrypt 都是「密文 48 B 进、明文 32 B 出」（实测见
     test/e2e_hls_aes.mjs 的填充行为探针）。若再无条件下手去掉，就会二次裁剪 ——
     把明文末尾 1~16 个字节静默吃掉，且只在「明文正好以小字节结尾」时暴露
     （分片是二进制，约 6%），表现为极难复现的偶发损坏。

     判据用长度：解密输出比输入短，说明环境已经去过填充，我们不再动手；
     只有环境原样返回（规范如此，但实测实现普遍会去）时才自己动手，
     并且校验「最后 pad 个字节全部等于 pad」，避免把末尾恰好形似填充的数据误删。 */
  async function aes128Decrypt(data, keyBytes, iv) {
    const ck = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, data));
    if (plain.length !== data.length) return plain;   // 环境已去填充
    if (plain.length >= 16 && plain.length % 16 === 0) {
      const pad = plain[plain.length - 1];
      if (pad >= 1 && pad <= 16 && pad <= plain.length) {
        let valid = true;
        for (let i = plain.length - pad; i < plain.length; i++) {
          if (plain[i] !== pad) { valid = false; break; }
        }
        if (valid) return plain.subarray(0, plain.length - pad);
      }
    }
    return plain;
  }

  async function fetchBytes(url, opts) {
    opts = opts || {};
    const init = Object.assign({ credentials: 'include', cache: 'no-store' }, opts.init || {});
    /* 请求超时保护（默认 45 秒），避免个别 CDN 卡死导致任务永久挂起 */
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      const to = AbortSignal.timeout(opts.timeout || 45000);
      if (opts.signal && AbortSignal.any) init.signal = AbortSignal.any([opts.signal, to]);
      else init.signal = opts.signal || to;
    } else if (opts.signal) {
      init.signal = opts.signal;
    }
    const res = await fetch(url, init);
    if (!res.ok && res.status !== 206) {
      throw new Error('HTTP ' + res.status + ' (' + url.slice(0, 120) + ')');
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async function getKeyBytes(keyInfo, signal) {
    const cached = KEY_CACHE.get(keyInfo.uri);
    if (cached) return cached;
    const p = fetchBytes(keyInfo.uri, { signal }).then((bytes) => {
      if (!bytes.byteLength) throw new Error('解密密钥内容为空');
      return bytes;
    });
    KEY_CACHE.set(keyInfo.uri, p);
    try {
      return await p;
    } catch (e) {
      KEY_CACHE.delete(keyInfo.uri);
      throw e;
    }
  }

  async function fetchSegment(seg, signal) {
    let data;
    if (seg.byterange && seg.byterange.offset != null) {
      const end = seg.byterange.offset + seg.byterange.length - 1;
      data = await fetchBytes(seg.url, {
        signal,
        init: { headers: { Range: 'bytes=' + seg.byterange.offset + '-' + end } }
      });
      /* 服务器不支持 Range 时手动切片 */
      if (data.byteLength === 0) throw new Error('BYTERANGE 响应为空');
      if (data.byteLength > seg.byterange.length && data.byteLength >= seg.byterange.offset + seg.byterange.length) {
        data = data.slice(seg.byterange.offset, seg.byterange.offset + seg.byterange.length);
      }
    } else {
      data = await fetchBytes(seg.url, { signal });
    }

    if (seg.key) {
      if (seg.key.method === 'AES-128') {
        const kb = await getKeyBytes(seg.key, signal);
        const iv = seg.key.iv ? hexToBytes(seg.key.iv) : sequenceIV(seg.seq);
        data = await aes128Decrypt(data, kb, iv);
      } else if (seg.key.method) {
        throw new Error('不支持的加密方式：' + seg.key.method + '（可能是 DRM 版权保护内容，无法下载）');
      }
    }
    return data;
  }

  /*
   * 下载全部媒体分片。
   * 返回 { initParts:[Uint8Array], segments:[Uint8Array（按序）], totalBytes }
   */
  async function downloadAll(media, opts) {
    opts = opts || {};
    const concurrency = Math.max(1, Math.min(16, opts.concurrency || 6));
    const signal = opts.signal;
    const onProgress = opts.onProgress;

    const initParts = [];
    if (media.initSegment) {
      initParts.push(await fetchBytes(media.initSegment.url, { signal }));
    }

    const total = media.segments.length;
    const results = new Array(total);
    let index = 0;
    let done = 0;
    let bytes = initParts.reduce((a, b) => a + b.byteLength, 0);

    async function worker() {
      for (;;) {
        if (signal && signal.aborted) throw new DOMException('已取消', 'AbortError');
        const i = index++;
        if (i >= total) return;
        const seg = media.segments[i];
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            results[i] = await fetchSegment(seg, signal);
            lastErr = null;
            break;
          } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            lastErr = e;
            if (attempt < 3) await sleep(400 * attempt);
          }
        }
        if (lastErr) throw new Error('分片 ' + (i + 1) + '/' + total + ' 下载失败：' + lastErr.message);
        done++;
        bytes += results[i].byteLength;
        if (onProgress) onProgress({ done, total, bytes });
      }
    }

    const workers = [];
    const n = Math.min(concurrency, total);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);

    return { initParts, segments: results, totalBytes: bytes };
  }

  /* ---------------- TS -> MP4 转封装（依赖 mux.js） ---------------- */

  function transmuxTsToMp4(muxjs, buffers) {
    if (!muxjs || !muxjs.mp4 || !muxjs.mp4.Transmuxer) throw new Error('转封装组件不可用');
    const transmuxer = new muxjs.mp4.Transmuxer();
    let init = null;
    const parts = [];
    transmuxer.on('data', (segment) => {
      if (!init && segment.initSegment) init = segment.initSegment;
      if (segment.data && segment.data.byteLength) parts.push(segment.data);
    });
    for (const buf of buffers) transmuxer.push(buf);
    transmuxer.flush();
    if (!init || !parts.length) throw new Error('转封装失败：没有产生有效输出');
    return [init].concat(parts.map((p) => new Uint8Array(p.buffer || p, p.byteOffset || 0, p.byteLength)));
  }

  /* ---------------- 导出 ---------------- */

  root.HLSKit = {
    resolveUrl,
    parseAttrs,
    parseByteRange,
    parsePlaylist,
    downloadAll,
    fetchBytes,
    fetchSegment,
    aes128Decrypt,
    sequenceIV,
    hexToBytes,
    isTsData,
    sniffExt,
    transmuxTsToMp4,
    sleep
  };
})(typeof self !== 'undefined' ? self : globalThis);
