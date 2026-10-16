/* ============================================================
 * 视频嗅探下载器 - 内容脚本
 * 职责：
 *   1. 扫描页面 DOM 中的 <video>/<source> 元素，把视频地址上报给后台；
 *   2. 回溯浏览器的性能时间线（PerformanceResourceTiming），把「本次页面加载
 *      已经发生过的」媒体请求补报给后台。
 *
 * 为什么需要第 2 件事：网络层嗅探只能看见「扩展开始观测之后」发生的请求。
 * Service Worker 会休眠、扩展可能是在页面加载完之后才被启用/重载，这些情况下
 * 早先发出的请求就永久错过了。而浏览器自己记录了当前文档加载过的每一个子资源，
 * 读这份时间线可以把它们补回来（这也是「不播放也能看到资源」的关键一步）。
 * ============================================================ */
(function () {
  'use strict';

  const EXT_RE = /\.(m3u8|m3u|mpd|mp4|m4v|m4s|webm|flv|f4v|mkv|mov|avi|ts|ogv|3gp|mpg|mpeg|wmv|qt|m4a|mp3|aac|opus|ogg|oga|flac|wav)(?:$|[?#])/i;

  /* URL 里出现这些词，说明它很可能是一份流地址（清单或分片）—— 与后台保持同一套词表 */
  const SUSPECT_RE = /(m3u8|m3u(?![\da-z])|\bmpd\b|manifest|playlist|playurl|videoplayback|hls|dash|\/stream|\/vod\/|live\/|master\.)/i;

  /* 这些发起者不可能是视频（图片/样式/脚本/字体/上报），回溯时直接跳过 */
  const SKIP_INITIATOR = { img: 1, css: 1, script: 1, font: 1, link: 1, beacon: 1, iframe: 1, ping: 1, csp_report: 1 };

  const MAX_REPORT = 120;      // 单次上报上限
  const MAX_CAND = 12;         // 其中「候选」（需后台按内容定性）的上限，避免噪音
  const reported = new Set();  // 本次页面已上报过的地址，避免重复

  function absolute(u) {
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  }

  function detectKind(url) {
    const m = EXT_RE.exec(url || '');
    if (m) return m[1].toLowerCase();
    return 'video';
  }

  /* ---------------- 通道 A：DOM 扫描 ---------------- */

  function scanDom() {
    const found = [];
    const seen = new Set();

    function push(rawUrl) {
      if (!rawUrl || typeof rawUrl !== 'string') return;
      if (rawUrl.startsWith('data:')) return;
      if (rawUrl.startsWith('blob:')) {
        if (!seen.has('blob')) { seen.add('blob'); found.push({ url: 'blob', kind: 'blob', blob: true }); }
        return;
      }
      const abs = absolute(rawUrl);
      if (!abs || !/^https?:/i.test(abs)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      reported.add(abs);
      found.push({ url: abs, kind: detectKind(abs) });
    }

    try {
      document.querySelectorAll('video').forEach((v) => {
        if (v.currentSrc) push(v.currentSrc);
        const srcAttr = v.getAttribute('src');
        if (srcAttr) push(srcAttr);
        v.querySelectorAll('source').forEach((s) => push(s.getAttribute('src')));
      });
      /* 音频元素：DASH 分离音轨 / 独立音频也值得抓（与页面上的视频配对） */
      document.querySelectorAll('audio').forEach((a) => {
        if (a.currentSrc) push(a.currentSrc);
        const srcAttr = a.getAttribute('src');
        if (srcAttr) push(srcAttr);
        a.querySelectorAll('source').forEach((s) => push(s.getAttribute('src')));
      });
      document.querySelectorAll('source[src]').forEach((s) => {
        const t = s.getAttribute('type') || '';
        if (t.startsWith('video') || t.startsWith('audio') || EXT_RE.test(s.getAttribute('src') || '')) push(s.getAttribute('src'));
      });
      document.querySelectorAll('embed[src], object[data]').forEach((el) => {
        const u = el.getAttribute('src') || el.getAttribute('data');
        if (u && EXT_RE.test(u)) push(u);
      });
    } catch (e) { /* ignore */ }

    return found;
  }

  /* ---------------- 通道 B：性能时间线回溯 ---------------- */

  function scanPerformance() {
    if (!window.performance || typeof performance.getEntriesByType !== 'function') return [];
    let entries = [];
    try { entries = performance.getEntriesByType('resource') || []; } catch (e) { return []; }

    const out = [];
    let cand = 0;
    for (let i = 0; i < entries.length && out.length < MAX_REPORT; i++) {
      const e = entries[i];
      const name = e && e.name;
      if (!name || typeof name !== 'string' || !/^https?:/i.test(name)) continue;
      if (name.length > 2048 || reported.has(name)) continue;
      if (SKIP_INITIATOR[e.initiatorType || '']) continue;

      const size = e.transferSize || e.decodedBodySize || 0;

      if (EXT_RE.test(name)) {
        reported.add(name);
        out.push({ url: name, kind: detectKind(name), size });
        continue;
      }
      /* 不带后缀、但 URL 像流地址 → 作为候选上报，由后台拉前几 KB 按内容定性 */
      if (cand < MAX_CAND && SUSPECT_RE.test(name)) {
        reported.add(name);
        cand++;
        out.push({ url: name, kind: 'cand', size });
      }
    }
    return out;
  }

  /* ---------------- 上报 ---------------- */

  function send(type, items) {
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({
        target: 'background',
        type,
        items,
        pageUrl: location.href
      }).catch(() => {});
    } catch (e) { /* 扩展更新后 context 可能失效 */ }
  }

  function scan() {
    send('DOM_MEDIA', scanDom());
    send('PERF_MEDIA', scanPerformance());
  }

  /* 节流调度 */
  let timer = null;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(scan, delay || 800);
  }

  scan();
  window.addEventListener('DOMContentLoaded', () => schedule(300), { once: true });
  window.addEventListener('load', () => schedule(500), { once: true });
  document.addEventListener('loadedmetadata', () => schedule(400), true);
  document.addEventListener('play', () => schedule(400), true);

  /* 仅当新增节点可能包含视频元素时才重扫，避免动态页面高频扫描 */
  try {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const tag = n.tagName;
          if (tag === 'VIDEO' || tag === 'SOURCE' || tag === 'EMBED' || tag === 'OBJECT' ||
              (n.querySelector && n.querySelector('video,source,embed,object'))) {
            schedule(1000);
            return;
          }
        }
      }
    });
    if (document.documentElement) {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (e) { /* ignore */ }

  /* popup 触发的重新扫描。
     force=true 时清掉「已上报」缓存再扫一遍：用户点 ⟳ 或清空列表后再扫时，
     必须能把性能时间线里的条目重新报上去，否则列表一旦清空就再也刷不回来了。 */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'DOM_SCAN') {
      if (msg.force) reported.clear();
      scan();
      sendResponse({ ok: true });
    }
  });
})();
