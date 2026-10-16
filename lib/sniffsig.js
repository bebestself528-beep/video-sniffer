/* ============================================================
 * 视频嗅探下载器 - 内容签名识别
 *
 * 用途：当 URL 后缀与响应头 Content-Type 都不可靠时，只靠这两者会漏掉资源。
 *       典型场景：
 *         · m3u8 清单被以 text/plain 返回（不少站点这么干），URL 又不带后缀；
 *         · 动态接口返回的流地址（/getPlayUrl?id=...），任何后缀特征都没有；
 *         · 直接用 <embed> 播放的裸流。
 *       此时拉取响应开头的几 KB 字节，按「内容特征」判断它到底是什么。
 *
 * 纯逻辑模块，不依赖任何 Chrome API：Service Worker 与 Node 中均可运行。
 * 挂载为全局：SniffSig
 * ============================================================ */
(function (root) {
  'use strict';

  const SCAN_LIMIT = 4096;   // 特征只在前 4KB 内找，避免大文件白扫

  function toU8(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer) return new Uint8Array(buf);
    return new Uint8Array(0);
  }

  function ascii(u8, off, len) {
    if (off < 0 || off + len > u8.length) return '';
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]);
    return s;
  }

  function indexOfAscii(u8, needle, limit) {
    const end = Math.min(u8.length, limit == null ? SCAN_LIMIT : limit) - needle.length;
    for (let i = 0; i <= end; i++) {
      let hit = true;
      for (let k = 0; k < needle.length; k++) {
        if (u8[i + k] !== needle.charCodeAt(k)) { hit = false; break; }
      }
      if (hit) return i;
    }
    return -1;
  }

  /* ---------------- 文本类清单：HLS(.m3u8) / DASH(.mpd) ---------------- */

  function sniffText(u8) {
    const head = ascii(u8, 0, Math.min(u8.length, 2048));
    /* 剥掉 UTF-8 BOM：这里按 latin1 逐字节转字符，所以它是 EF BB BF 三个字符 */
    const body = head.replace(/^\uFEFF/, '').replace(/^\u00EF\u00BB\u00BF/, '').trimStart();

    /* JSON 响应里也常出现流地址字符串，但它本身不是清单，直接排除 */
    if (/^[\[{]/.test(body)) return null;

    if (/^#EXTM3U/i.test(body)) {
      const master = /#EXT-X-STREAM-INF/i.test(head);
      return {
        ok: true, kind: 'hls', ext: 'm3u8', label: 'HLS 播放列表',
        detail: master ? 'master 清单（含清晰度）' : 'media 清单', sig: '#EXTM3U'
      };
    }
    if (/#EXT-X-(TARGETDURATION|MEDIA-SEQUENCE|VERSION|KEY|MAP|BYTERANGE|ENDLIST)/i.test(head)) {
      return { ok: true, kind: 'hls', ext: 'm3u8', label: 'HLS 播放列表', detail: '缺少 #EXTM3U 头但含 HLS 标签', sig: 'EXT-X' };
    }
    if (/<MPD[\s>]/i.test(head) || /urn:mpeg:dash:schema:mpd/i.test(head)) {
      return { ok: true, kind: 'dash', ext: 'mpd', label: 'DASH 清单', detail: 'MPD', sig: '<MPD' };
    }
    if (/^\s*<[\?a-z!]/i.test(body) && /(<Period|<AdaptationSet|<Representation)/i.test(head)) {
      return { ok: true, kind: 'dash', ext: 'mpd', label: 'DASH 清单', detail: 'MPD（未声明命名空间）', sig: 'AdaptationSet' };
    }
    return null;
  }

  /* ---------------- MPEG-TS：靠 0x47 同步字节的固定间隔判定 ---------------- */

  function sniffTs(u8) {
    const limit = Math.min(u8.length - 396, 1400);
    for (let i = 0; i <= limit; i++) {
      if (u8[i] !== 0x47) continue;
      /* 标准 188 字节包：连续三个同步字节即可确认 */
      if (u8[i + 188] === 0x47 && u8[i + 376] === 0x47) {
        return { ok: true, kind: 'ts', ext: 'ts', label: 'TS 分片', detail: 'MPEG-TS（188 字节包）', sig: '0x47×188' };
      }
      /* 192 字节包（部分机顶盒/录制流） */
      if (u8[i + 192] === 0x47 && u8[i + 384] === 0x47) {
        return { ok: true, kind: 'ts', ext: 'ts', label: 'TS 分片', detail: 'MPEG-TS（192 字节包）', sig: '0x47×192' };
      }
    }
    return null;
  }

  /* ---------------- 主入口 ---------------- */

  function classify(buf) {
    const u8 = toU8(buf);
    if (u8.length < 8) return { ok: false, error: '数据过短，无法识别' };

    /* 1. 文本清单（优先级最高：m3u8/mpd 都是纯文本） */
    const text = sniffText(u8);
    if (text) return text;

    /* 2. ISO BMFF 家族（MP4 / fMP4） */
    const box0 = ascii(u8, 4, 4);
    const brand = ascii(u8, 8, 4);
    if (box0 === 'ftyp' || box0 === 'styp' || box0 === 'moof' || box0 === 'moov' || box0 === 'sidx') {
      const hasMoof = box0 === 'moof' || indexOfAscii(u8, 'moof') >= 0;
      const hasMoov = box0 === 'moov' || indexOfAscii(u8, 'moov') >= 0;
      const brandTag = /^[\x20-\x7e]{4}$/.test(brand) ? brand : '';
      const isDash = /^(dash|msdh|msix)$/i.test(brandTag);
      if (hasMoof && !hasMoov) {
        return {
          ok: true, kind: 'fmp4', ext: 'm4s', label: 'fMP4 分片/轨道',
          detail: 'moof' + (brandTag ? ' · ' + brandTag : ''), sig: 'ftyp+moof'
        };
      }
      return {
        ok: true, kind: 'mp4', ext: 'mp4', label: 'MP4 文件',
        detail: [brandTag, hasMoov ? 'moov' : '', isDash ? 'DASH' : ''].filter(Boolean).join(' · '), sig: 'ftyp'
      };
    }

    /* 3. 其它容器魔数 */
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
      return { ok: true, kind: 'webm', ext: 'webm', label: 'WebM / Matroska', detail: 'EBML', sig: '1A45DFA3' };
    }
    if (ascii(u8, 0, 3) === 'FLV') {
      return { ok: true, kind: 'flv', ext: 'flv', label: 'FLV', detail: '', sig: 'FLV' };
    }
    if (ascii(u8, 0, 4) === 'OggS') {
      return { ok: true, kind: 'ogv', ext: 'ogv', label: 'Ogg', detail: '', sig: 'OggS' };
    }
    if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'AVI ') {
      return { ok: true, kind: 'avi', ext: 'avi', label: 'AVI', detail: '', sig: 'RIFF/AVI' };
    }

    /* 4. TS（放在最后：它靠重复的 0x47，需要多字节确认，避免误判） */
    const ts = sniffTs(u8);
    if (ts) return ts;

    /* 5. ID3 前导：HLS 的 TS 分片常这么开（KEYFORMAT 带 ID3 时间戳） */
    if (ascii(u8, 0, 3) === 'ID3') {
      return { ok: true, kind: 'ts', ext: 'ts', label: 'TS 分片', detail: 'ID3 前导（HLS 分片常见）', sig: 'ID3' };
    }

    return { ok: false, error: '未匹配到已知媒体特征' };
  }

  root.SniffSig = {
    classify,
    /* 便于测试与调试 */
    _internal: { sniffText, sniffTs, ascii, indexOfAscii }
  };
})(typeof self !== 'undefined' ? self : globalThis);
