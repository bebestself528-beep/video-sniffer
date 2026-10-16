/* ============================================================
 * 视频嗅探下载器 - 媒体角色识别（纯逻辑，不依赖任何 Chrome API）
 *   - 在 Service Worker / offscreen 文档 / popup 中运行（浏览器环境）
 *   - 在 Node 中运行（单元测试）
 * 挂载为全局：MediaRole
 *
 * 【为什么需要它】
 * 判断一个媒体 URL 是「画面轨」「声音轨」还是「音视频一体」，是音视频
 * 分离类站点能否正确合并的关键。抖音无声事件证明了两件事：
 *   1. 只靠 Content-Type 不够 —— 抖音两条轨的 CT 都是 video/mp4；
 *   2. 只靠路径关键词也不够 —— YouTube 所有轨的路径都是 /videoplayback。
 * 所以这里按「可信度分层」收集信号，谁能判定就用谁，都判不出就诚实返回
 * null（宁可判不出，也不要误判 —— 误判会把两条画面轨配成一对）。
 *
 * 信号可信度（高 → 低）：
 *   ① URL query 里站点自己声明的类型（&mime=audio%2Fmp4、&type=audio）
 *   ② YouTube 的 itag 编号
 *   ③ URL 路径/文件名里的角色词（media-audio-und-mp4a、xxx-video-only.m4s）
 *   ④ Content-Type（audio/* 与 video/*）—— 由调用方传入，见 roleFromCt
 * ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- ① URL query 里的显式类型声明 ---------------- */

  /* 站点会在这些 query 参数里写资源类型。值必须是明确的 audio/video，否则不判。
     注意 sparams=...,mime,... 这类「参数名清单」不会命中，因为键名不在此列。 */
  const ROLE_QUERY_KEYS = [
    'mime', 'mimetype', 'mime_type', 'mediatype', 'media_type',
    'contenttype', 'content_type', 'streamtype', 'stream_type',
    'filetype', 'file_type', 'type', 'format', 'media', 'kind'
  ];

  /* 从一个参数值里读出角色。返回 'audio' | 'video' | null */
  function roleFromValue(v) {
    if (v == null) return null;
    let s = String(v).trim().toLowerCase();
    if (!s || s.length > 120) return null;
    /* 少数站点会双重编码（%252F）—— 再解一次 */
    if (s.indexOf('%') >= 0) {
      try { s = decodeURIComponent(s).toLowerCase(); } catch (e) { /* 保持原值 */ }
    }
    const hasAudio = /(?:^|[^a-z0-9])audio(?:[^a-z0-9]|$)/.test(s);
    const hasVideo = /(?:^|[^a-z0-9])video(?:[^a-z0-9]|$)/.test(s);
    if (hasAudio && !hasVideo) return 'audio';
    if (hasVideo && !hasAudio) return 'video';
    return null;
  }

  function roleFromQuery(url) {
    const qAt = url.indexOf('?');
    if (qAt < 0) return null;
    const hashAt = url.indexOf('#', qAt);
    const q = url.slice(qAt + 1, hashAt >= 0 ? hashAt : url.length);
    if (!q) return null;

    /* 手写解析：URLSearchParams 会规范化编码，可能破坏带签名的 URL；
       这里只是读取，保持原样更重要。 */
    const parts = q.split('&');
    for (const kv of parts) {
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const k = kv.slice(0, eq).toLowerCase();
      if (ROLE_QUERY_KEYS.indexOf(k) < 0) continue;
      const role = roleFromValue(kv.slice(eq + 1));
      if (role) return role;
    }
    return null;
  }

  /* ---------------- ② YouTube itag ---------------- */

  /* 只收录「确定是独立轨」的 itag。收录范围之外一律返回 null，
     因为把普通渐进式 itag 误判成独立轨会造成错误的配对。 */
  const ITAG_VIDEO_ONLY = {
    133: 1, 134: 1, 135: 1, 136: 1, 137: 1, 138: 1, 160: 1,
    242: 1, 243: 1, 244: 1, 247: 1, 248: 1, 264: 1, 271: 1, 272: 1, 278: 1,
    298: 1, 299: 1, 302: 1, 303: 1, 308: 1, 313: 1, 315: 1,
    330: 1, 331: 1, 332: 1, 333: 1, 334: 1, 335: 1, 336: 1, 337: 1,
    394: 1, 395: 1, 396: 1, 397: 1, 398: 1, 399: 1, 400: 1, 401: 1, 402: 1
  };
  const ITAG_AUDIO_ONLY = {
    139: 1, 140: 1, 141: 1, 171: 1, 172: 1,
    249: 1, 250: 1, 251: 1, 256: 1, 258: 1
  };
  /* 旧式渐进式（音视频一体）—— 用于明确「这不是分离轨」 */
  const ITAG_MUXED = {
    5: 1, 6: 1, 17: 1, 18: 1, 22: 1, 34: 1, 35: 1, 36: 1, 37: 1, 38: 1,
    43: 1, 44: 1, 45: 1, 46: 1, 59: 1, 78: 1, 82: 1, 83: 1, 84: 1, 85: 1,
    91: 1, 92: 1, 93: 1, 94: 1, 95: 1, 96: 1, 100: 1, 101: 1, 102: 1
  };

  function itagOf(url) {
    const m = /[?&]itag=(\d{1,3})(?:&|#|$)/.exec(url);
    return m ? parseInt(m[1], 10) : 0;
  }

  function roleFromItag(url) {
    const it = itagOf(url);
    if (!it) return null;
    if (ITAG_VIDEO_ONLY[it]) return 'video';
    if (ITAG_AUDIO_ONLY[it]) return 'audio';
    if (ITAG_MUXED[it]) return 'muxed';
    return null;
  }

  /* ---------------- ③ 路径 / 文件名里的角色词 ---------------- */

  /* 词边界用「非字母数字」界定，避免 provider 里的 vid、audience 里的 aud 被误命中。
     容器/编码名也一并收录：avc1/hvc1/hevc/vp9/av01 是画面，opus/vorbis/aac 是声音。 */
  const AUDIO_TOKEN_RE = /(?:^|[^a-z0-9])(?:audio|aud|aac|opus|vorbis|m4a|mp3|adts)(?:[^a-z0-9]|$)/i;
  const VIDEO_TOKEN_RE = /(?:^|[^a-z0-9])(?:video|avc1|avc|hvc1|hevc|h264|h265|vp9|vp09|av01|av1)(?:[^a-z0-9]|$)/i;

  /* 页面类地址不做路径判定（避免把播放页 /video/BVxxx 当成视频轨） */
  const PAGE_EXT_RE = /\.(?:html?|php|aspx?|jsp|do|action|shtml)(?:$|[?#])/i;

  /* 路径形态闸门：只有「目录形态」或「文件形态」才允许做路径判定。
     目的是拦住播放页地址——B站 https://www.bilibili.com/video/BV1xx411c7mD
     的父目录就叫 video，不设闸门就会被误判成一条视频轨。
       · 目录形态：路径以 / 结尾，最后一段本身就是「文件名」
         （抖音 …/media-video-avc1/），此时取最后一段
       · 文件形态：最后一段带扩展名（…/dash/audio/seg1.m4s），此时取最后两段
     两种都不是（无扩展名也不以 / 结尾）→ 判不出，交给文件头探测。 */
  function pathShape(pathname) {
    const segs = pathname.split('/').filter(Boolean);
    const dirStyle = /\/$/.test(pathname);
    const last = segs[segs.length - 1] || '';
    const fileStyle = /\.[a-z0-9]{1,5}$/i.test(last);
    if (dirStyle) return '/' + (segs[segs.length - 1] || '') + '/';
    if (fileStyle) return segs.slice(-2).join('/');
    return '';
  }

  function roleFromPath(url) {
    if (PAGE_EXT_RE.test(url)) return null;
    let scope;
    try {
      scope = pathShape(new URL(url).pathname);
    } catch (e) {
      scope = pathShape(url);
    }
    if (!scope) return null;
    const hasAudio = AUDIO_TOKEN_RE.test(scope);
    const hasVideo = VIDEO_TOKEN_RE.test(scope);
    if (hasAudio && !hasVideo) return 'audio';
    if (hasVideo && !hasAudio) return 'video';
    return null;
  }

  /* ---------------- ④ Content-Type ---------------- */

  function roleFromCt(ct) {
    const c = String(ct || '').split(';')[0].trim().toLowerCase();
    if (!c || c === 'application/octet-stream' || c === 'text/plain' || c === 'text/html') return null;
    if (c.indexOf('audio/') === 0) return 'audio';
    if (c.indexOf('video/') === 0) return 'video';
    return null;
  }

  /* ---------------- 对外主入口 ---------------- */

  /*
   * 判断 URL 的角色。
   * 返回 'video' | 'audio' | 'muxed' | null
   *   video —— 只有画面（需要与音频轨配对）
   *   audio —— 只有声音
   *   muxed —— 音视频一体（无需配对，直接下载即可）
   *   null  —— 判不出（调用方应落回「读文件头」的探测路径）
   */
  function roleFromUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    if (url.length > 4096) return null;

    const byQuery = roleFromQuery(url);
    if (byQuery) return byQuery;

    const byItag = roleFromItag(url);
    if (byItag) return byItag;

    return roleFromPath(url);
  }

  /* 综合 URL 与响应头。URL 的显式声明优先于 CT ——
     抖音/部分 CDN 会把音频轨也标成 video/mp4，此时 URL 更可信。 */
  function roleOf(url, ct) {
    const byUrl = roleFromUrl(url);
    if (byUrl) return byUrl;
    return roleFromCt(ct);
  }

  /* ---------------- 分片参数处理（同一资源的第 N 片归一） ----------------
   * YouTube 把一条轨切成多个 range 请求：
   *   ...&range=0-999999
   *   ...&range=1000000-1999999&rn=1&rbuf=123456
   * 这些 URL 指向同一份资源，却会被嗅探成 N 个条目 —— 列表爆炸、
   * 而且单独下载其中一条只能拿到前 1MB。去掉这些参数即得完整资源
   * （googlevideo 等 CDN 在无 range 参数时返回完整文件）。 */
  /* 只收录「去掉它才等于同一份资源」的参数。
     sq/bytes/start/end 之类故意不收：它们在直播分片、时间区间等场景下会指向不同的
     内容，误删会把本该分开的资源合并掉。 */
  const SLICE_PARAMS = ['range', 'rn', 'rbuf', 'bytestart', 'byteend'];

  function isSliceParam(k) {
    return SLICE_PARAMS.indexOf(String(k).toLowerCase()) >= 0;
  }

  /* 去掉分片参数，得到「同一逻辑资源」的地址（同时用于去重与下载） */
  function stripSliceParams(url) {
    const hashAt = url.indexOf('#');
    const hash = hashAt >= 0 ? url.slice(hashAt) : '';
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const qAt = base.indexOf('?');
    if (qAt < 0) return url;

    const head = base.slice(0, qAt + 1);
    const q = base.slice(qAt + 1);
    const parts = q.split('&');
    const kept = parts.filter((kv) => {
      const eq = kv.indexOf('=');
      return !isSliceParam(eq >= 0 ? kv.slice(0, eq) : kv);
    });
    if (kept.length === parts.length) return url;
    return head + kept.join('&') + hash;
  }

  /* 读出分片范围，仅用于诊断展示 */
  function sliceOf(url) {
    const m = /[?&]range=([^&#]*)/i.exec(url);
    return m ? m[1] : '';
  }

  /* 去重键：去掉分片参数后的地址 */
  function dedupKeyOf(url) {
    return stripSliceParams(url);
  }

  /* ---------------- 导出 ---------------- */

  root.MediaRole = {
    roleFromUrl,
    roleFromQuery,
    roleFromItag,
    roleFromPath,
    roleFromValue,
    roleFromCt,
    roleOf,
    itagOf,
    stripSliceParams,
    dedupKeyOf,
    sliceOf,
    isSliceParam,
    SLICE_PARAMS
  };
})(typeof self !== 'undefined' ? self : globalThis);
