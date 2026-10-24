/* ============================================================
 * 视频嗅探下载器 - 后台 Service Worker
 * 职责：
 *  1. 通过 webRequest 嗅探所有网络视频请求（URL 后缀 + Content-Type 双通道）
 *  2. 按标签页维护嗅探结果（chrome.storage.session 持久化，SW 休眠不丢）
 *  3. 消息中枢：popup <-> offscreen 文档之间转发下载任务
 *  4. 按需注入 Referer 防盗链规则（declarativeNetRequest 会话规则）
 * ============================================================ */
'use strict';

/* ---------------- 载入纯逻辑库 ----------------
 * fmp4merge 用于识别分片文件里的轨道类型（视频轨/音频轨）并合并两轨。
 * sniffsig 用于在 URL 与 Content-Type 都不可靠时，按内容特征判定真实类型。
 * mediarole 用于判断一个 URL 是画面轨/声音轨还是音视频一体（URL 自带角色声明优先于响应头）。
 * Service Worker 为经典（非 module）类型，可直接用 importScripts 同步载入。 */
try {
  if (typeof importScripts === 'function') {
    if (typeof Fmp4Merge === 'undefined') importScripts('lib/fmp4merge.js');
    if (typeof SniffSig === 'undefined') importScripts('lib/sniffsig.js');
    if (typeof MediaRole === 'undefined') importScripts('lib/mediarole.js');
    if (typeof WebmMerge === 'undefined') importScripts('lib/webmmerge.js');
    /* hls.js 只为带凭证降级的 fetchSmart：部分 CDN 不回
       Access-Control-Allow-Credentials，带凭证的跨域请求会被 CORS 直接掐断，
      这里统一走「失败就换不带凭证重试」的那条路。 */
    if (typeof HLSKit === 'undefined') importScripts('lib/hls.js');
  }
} catch (e) {
  /* 载入失败时相关功能降级为不可用，不影响其他功能 */
}

/* 统一的取数入口：优先用 hls.js 的 fetchSmart（带凭证降级），
   库没载进来时退化成普通 fetch。 */
async function smartFetch(url, init) {
  init = init || {};
  if (typeof HLSKit !== 'undefined' && HLSKit && HLSKit.fetchSmart) return HLSKit.fetchSmart(url, init);
  const res = await fetch(url, init);
  return res;
}

/* 文件头探测结果缓存（同一会话内避免重复请求；URL 含时效签名，故不做持久化） */
const headCache = new Map();
const sigCache = new Map();     // 内容签名识别结果
const dropCache = new Set();    // 已确认「不是媒体」的地址，避免反复探测

/* ---------------- 常量 ---------------- */

const MEDIA_EXTS = ['m3u8', 'm3u', 'mpd', 'mp4', 'm4v', 'm4s', 'webm', 'flv', 'f4v', 'mkv', 'mov', 'avi', 'ts', 'ogv', '3gp', 'mpg', 'mpeg', 'wmv', 'qt',
  /* 音频后缀：抖音等站点的分离音轨可能是 .m4a/.mp3；也可能是独立音频文件 */
  'm4a', 'mp3', 'aac', 'opus', 'ogg', 'oga', 'flac', 'wav'];
const MEDIA_EXT_RE = /\.(m3u8|m3u|mpd|mp4|m4v|m4s|webm|flv|f4v|mkv|mov|avi|ts|ogv|3gp|mpg|mpeg|wmv|qt|m4a|mp3|aac|opus|ogg|oga|flac|wav)(?:$|[?#])/i;

const KIND_BY_EXT = {
  m3u8: 'hls', m3u: 'hls', mpd: 'dash',
  mp4: 'mp4', m4v: 'mp4', m4s: 'fmp4',
  webm: 'webm', flv: 'flv', f4v: 'flv', mkv: 'mkv', mov: 'mov', avi: 'avi',
  ts: 'ts', ogv: 'ogv', '3gp': '3gp', mpg: 'mpg', mpeg: 'mpg', wmv: 'wmv', qt: 'mov',
  m4a: 'audio', mp3: 'audio', aac: 'audio', opus: 'audio', ogg: 'audio', oga: 'audio', flac: 'audio', wav: 'audio'
};

/* 类型优先级（越大越“值得展示”），用于同一 URL 被多次捕获时保留更优类型
 * cand = 候选条目：URL 与响应头都判不出类型，等签名识别后再定性（故优先级最低）
 * audio = 纯音频（含 DASH 分离音轨，以及独立音频文件） */
const KIND_RANK = { hls: 100, dash: 90, audio: 85, mp4: 80, webm: 80, flv: 80, mkv: 80, mov: 80, avi: 70, '3gp': 60, ogv: 60, mpg: 60, wmv: 60, video: 40, ts: 30, fmp4: 30, cand: 1, blob: 0 };

const MAX_ITEMS_PER_TAB = 500;   // 每个标签页最多保留的嗅探条目
const MAX_TASKS = 20;            // 最多保留的下载任务记录

/* 嗅探 URL 过滤器（粗筛，真正判定在 classifyUrl 中做） */
const URL_PATTERNS = MEDIA_EXTS.map((e) => `*://*/*.${e}*`);

/* ---------------- 工具函数 ---------------- */

function normalizeKind(kind, ext) {
  if (kind === 'cand') return { kind: 'cand', ext: '' };   // 候选：等签名识别定性
  if (kind === 'blob') return { kind: 'blob', ext: '' };
  /* 通用类别（video/audio）：这里的 ext 只是从 Content-Type 推测的后缀建议，
     不能反过来把 kind 升级成具体容器类型 —— 否则无后缀的分离轨（如抖音
     video/mp4 的视频轨）会变成 "mp4" 类型，而 "mp4" 太常见、不在轨道探测范围内，
     探测不到角色就配不上对、合并不了。保持 "video" 让它进入待探测集合。 */
  if (kind === 'video' || kind === 'audio') return { kind, ext: ext || '' };
  if (KIND_BY_EXT[ext]) return { kind: KIND_BY_EXT[ext], ext };
  if (KIND_BY_EXT[kind]) return { kind: KIND_BY_EXT[kind], ext: ext || kind };
  return { kind: 'video', ext: ext || '' };
}

function classifyUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  if (!/^https?:/i.test(url)) return null;
  const m = MEDIA_EXT_RE.exec(url);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return { ext, kind: KIND_BY_EXT[ext] || 'video' };
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const h = headers.find((x) => x && x.name && x.name.toLowerCase() === name);
  return h ? String(h.value || '') : '';
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

/* audio/* Content-Type → 常用后缀（用于无后缀音频流的展示与命名）。
   认不出的子类型一律按 m4a 命名 —— audio/octet-stream 之类的怪值不能直接拿来当后缀。 */
function audioExtFromCt(ct) {
  const sub = (String(ct).split('/')[1] || '').replace(/;.*$/, '').trim().replace(/[^a-z0-9-]/g, '');
  if (sub === 'mp4' || sub === 'x-m4a' || sub === 'm4a') return 'm4a';
  if (sub === 'mpeg' || sub === 'mp3') return 'mp3';
  if (sub === 'x-aac' || sub === 'aac') return 'aac';
  if (sub === 'webm' || sub === 'ogg' || sub === 'opus' || sub === 'wav' || sub === 'x-wav' ||
      sub === 'flac' || sub === 'x-flac' || sub === 'oga') return sub.replace(/^x-/, '');
  return 'm4a';
}

/* 分片 URL 上常带「整份资源的大小」参数（YouTube 的 clen）。
   分片响应的 Content-Length 只是这一片，展示成整轨体积会严重误导。 */
function fullSizeOf(url) {
  const m = /[?&](?:clen|size|contentlength|content_length)=(\d+)/i.exec(url);
  return m ? parseInt(m[1], 10) : 0;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------- 嗅探结果存取（serialize 每个 tab 的写操作，避免竞态） ---------------- */

const tabChains = new Map();

function record(tabId, item) {
  const prev = tabChains.get(tabId) || Promise.resolve();
  const next = prev.then(() => recordNow(tabId, item)).catch(() => {});
  tabChains.set(tabId, next);
}

async function recordNow(tabId, item) {
  /* 分片参数归一：YouTube 会把一条轨切成多个 range 请求
     （…&range=0-999999、…&range=1000000-1999999&rn=1&rbuf=…）。
     这些 URL 指向同一份资源，不归一会把一条轨嗅探成几十个条目 —— 列表爆炸，
     而且单独下载其中一条只能拿到前 1MB。统一归到「去掉分片参数」的地址上，
     该地址也正是下载时该用的地址（CDN 在无 range 参数时返回完整文件）。 */
  if (typeof MediaRole !== 'undefined') {
    const stripped = MediaRole.stripSliceParams(item.url);
    if (stripped !== item.url) {
      item = Object.assign({}, item, {
        url: stripped,
        size: fullSizeOf(item.url),   // 分片的 Content-Length 不可信；无 clen 时记 0（未知）
        slice: true
      });
    }
  }

  const key = 'tab:' + tabId;
  const got = await chrome.storage.session.get(key);
  const data = got[key] || { pageUrl: '', items: {} };

  if (!data.pageUrl) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.url && /^https?:/i.test(t.url)) data.pageUrl = t.url;
    } catch (e) { /* 标签页可能已关闭 */ }
  }

  const exist = data.items[item.url];
  if (exist) {
    const newKind = normalizeKind(item.kind, item.ext);
    if ((KIND_RANK[newKind.kind] || 0) > (KIND_RANK[exist.kind] || 0)) {
      exist.kind = newKind.kind;
      exist.ext = newKind.ext || exist.ext;
    }
    if (!exist.size && item.size) exist.size = item.size;
    if (!exist.ref && item.ref) exist.ref = item.ref;
    if (!exist.role && item.role) exist.role = item.role;
    await chrome.storage.session.set({ [key]: data });
    return;
  }

  data.items[item.url] = {
    url: item.url,
    kind: (normalizeKind(item.kind, item.ext)).kind,
    ext: (normalizeKind(item.kind, item.ext)).ext,
    size: item.size || 0,
    time: Date.now(),
    ref: item.ref || '',
    role: item.role || '',        // URL 自带的角色声明（画面轨/声音轨/一体），空表示未知
    slice: !!item.slice,          // 该条目由分片 URL 归一而来
    source: item.source || 'net'
  };

  /* 超出上限时优先清理分片类（ts/fmp4）最旧条目 */
  const all = Object.values(data.items);
  if (all.length > MAX_ITEMS_PER_TAB) {
    all.sort((a, b) => (KIND_RANK[a.kind] || 0) - (KIND_RANK[b.kind] || 0) || a.time - b.time);
    const removeCount = all.length - MAX_ITEMS_PER_TAB;
    for (let i = 0; i < removeCount; i++) delete data.items[all[i].url];
  }

  await chrome.storage.session.set({ [key]: data });
  notifyPopup({ type: 'MEDIA_UPDATED', tabId });
}

/* ---------------- 候选条目：URL 与响应头都判不出类型时，先记下来待定性 ---------------- */

/* 这些 Content-Type 不足以判定类型（真实媒体常被这样返回），需要看内容才能定性 */
const UNRELIABLE_CT_RE = /^(text\/plain|text\/html|application\/octet-stream|binary\/octet-stream|application\/json|application\/x-www-form-urlencoded|)$/;

/* URL 里出现这些词，说明它很可能是一份流地址（清单或分片） */
const SUSPECT_URL_RE = /(m3u8|m3u(?![\da-z])|\bmpd\b|manifest|playlist|playurl|videoplayback|hls|dash|\/stream|\/vod\/|live\/|master\.)/i;

/* 体积达到这个数的"类型不明"响应也值得当候选看一眼。
   不少站点把视频/分片塞进 application/octet-stream，URL 又是一串防盗链签名、
   没有任何关键词，只能靠"够大"把它捞回来，再由内容签名定性。
   阈值取 256 KB：正常脚本 / JSON / 字体都远小于它，而 240p 的 6 秒分片也有 ~375 KB。 */
const LARGE_BINARY_BYTES = 256 * 1024;

function isSuspectStream(url, ct, type, len) {
  if (typeof url !== 'string' || !/^https?:/i.test(url) || url.length > 2048) return false;
  if (dropCache.has(url)) return false;
  if (MEDIA_EXT_RE.test(url)) return false;                                   // 后缀已足够判定
  if (type && !/xmlhttprequest|media|other|object/.test(type)) return false;   // 只关心可能承载媒体的请求
  if (!UNRELIABLE_CT_RE.test(ct || '')) return false;
  /* type=media 是浏览器明确认定「这是媒体资源」的强信号（<video>/<audio>/MSE 发起的请求），
     此时即使 URL 完全不含流特征词（抖音分离轨就是这样：一串签名参数、无后缀），也值得记为候选 */
  if (type === 'media') return true;
  if (SUSPECT_URL_RE.test(url)) return true;
  /* 大块二进制：兜住"URL 无特征 + Content-Type 不明 + 非 media 类型"的漏网之鱼 */
  return (len || 0) >= LARGE_BINARY_BYTES;
}

/* 记为候选（优先级最低，一旦有真类型会立刻被覆盖） */
function recordCandidate(tabId, url, size, ref) {
  record(tabId, { url, ext: '', kind: 'cand', size: size || 0, ref: ref || '', source: 'guess' });
}

/* 删除一个已确认非媒体的条目，并记住它，避免回溯扫描反复上报 */
function dropItem(tabId, url) {
  if (dropCache.size > 800) dropCache.clear();
  dropCache.add(url);
  const prev = tabChains.get(tabId) || Promise.resolve();
  const next = prev.then(async () => {
    const key = 'tab:' + tabId;
    const got = await chrome.storage.session.get(key);
    const data = got[key];
    if (!data || !data.items || !data.items[url]) return;
    delete data.items[url];
    await chrome.storage.session.set({ [key]: data });
  }).catch(() => {});
  tabChains.set(tabId, next);
}

let notifyTimer = null;
let notifyPending = false;
function notifyPopup(msg) {
  if (notifyTimer) { notifyPending = true; return; }
  const doSend = () => {
    notifyTimer = null;
    notifyPending = false;
    try {
      chrome.runtime.sendMessage({ target: 'popup', ...msg }).catch(() => {});
    } catch (e) { /* 无接收方 */ }
  };
  doSend();
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (notifyPending) doSend();
  }, 500);
}

/* ---------------- 网络嗅探：两步走 ---------------- */

/* 通道 1：URL 后缀匹配（onBeforeRequest，零开销预过滤） */
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId == null || d.tabId < 0) return;
    const c = classifyUrl(d.url);
    if (!c) return;
    record(d.tabId, {
      url: d.url,
      ext: c.ext,
      kind: c.kind,
      size: 0,
      ref: d.initiator || '',
      source: 'net'
    });
  },
  { urls: URL_PATTERNS }
);

/* 通道 2：Content-Type 匹配（onHeadersReceived，捕获无后缀 / 动态流地址） */
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId == null || d.tabId < 0) return;
    const ct = headerValue(d.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
    const len = parseInt(headerValue(d.responseHeaders, 'content-length'), 10) || 0;

    let kind = null, ext = '';

    /* URL 里站点自己声明的角色（&mime=audio%2Fmp4、itag=140、media-audio-und-mp4a…）。
       可信度高于 Content-Type —— 抖音与部分 CDN 会把音频轨也标成 video/mp4，
       此时只有 URL 的声明能告诉我们「这条其实是声音」。 */
    const urlRole = typeof MediaRole !== 'undefined' ? MediaRole.roleFromUrl(d.url) : null;

    if (/mpegurl/.test(ct)) {
      kind = 'hls'; ext = 'm3u8';
    } else if (/dash\+xml/.test(ct)) {
      kind = 'dash'; ext = 'mpd';
    } else if (ct === 'video/mp2t') {
      kind = 'ts'; ext = 'ts';
    } else if (ct.startsWith('video/') || (ct === 'application/octet-stream' && MEDIA_EXT_RE.test(d.url))) {
      const c = classifyUrl(d.url);
      if (c) { kind = c.kind; ext = c.ext; }
      else if (urlRole === 'audio') {
        kind = 'audio'; ext = audioExtFromCt(ct) || 'm4a';
      } else if (ct.startsWith('video/')) {
        kind = 'video'; ext = (ct.split('/')[1] || '').replace(/[^a-z0-9]/g, '');
      }
    } else if (ct.startsWith('audio/')) {
      /* 纯音频响应：DASH 分离音轨（抖音等站点，URL 通常无后缀）、独立音频文件。
         过去这里被忽略，导致「视频轨能抓到、配套音轨抓不到」——合并时自然就没声音。 */
      const c = classifyUrl(d.url);
      if (c) { kind = c.kind; ext = c.ext; }
      else { kind = 'audio'; ext = audioExtFromCt(ct); }
    } else if (urlRole && UNRELIABLE_CT_RE.test(ct || '')) {
      /* 响应头判不出类型，但 URL 自己写明了角色（如 &mime=audio%2Fwebm 配
         application/octet-stream）→ 直接定性，省掉一次内容探测 */
      kind = urlRole === 'audio' ? 'audio' : 'video';
      ext = urlRole === 'audio' ? audioExtFromCt(ct) : '';
    }

    if (kind) {
      record(d.tabId, {
        url: d.url,
        ext,
        kind,
        size: len,
        ref: d.initiator || '',
        role: urlRole || '',
        source: 'net'
      });
      return;
    }

    /* 响应头判不出类型（如 m3u8 被以 text/plain 返回），但 URL 像流地址
       → 记为候选，稍后由 popup 触发按内容签名定性（见 PROBE_KIND） */
    if (isSuspectStream(d.url, ct, d.type, len)) {
      recordCandidate(d.tabId, d.url, len, d.initiator || '');
    }
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

/* ---------------- 标签页生命周期 ---------------- */

/* 整页导航（status=loading 且带 url）时清空该标签页旧结果；SPA 内 URL 变化不清空 */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'loading' && info.url) {
    const key = 'tab:' + tabId;
    await chrome.storage.session.set({ [key]: { pageUrl: info.url, items: {} } });
    notifyPopup({ type: 'MEDIA_UPDATED', tabId });
  } else if (info.url && !/^https?:/i.test(info.url)) {
    const key = 'tab:' + tabId;
    await chrome.storage.session.remove(key);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('tab:' + tabId).catch(() => {});
});

/* ---------------- Referer 防盗链规则（declarativeNetRequest 会话规则） ---------------- */

async function allocRuleId() {
  const got = await chrome.storage.session.get('dnrNext');
  const next = (got.dnrNext || 10000) + 1;
  await chrome.storage.session.set({ dnrNext: next });
  return next;
}

/*
 * 取出一条「轨」涉及的全部地址。一条轨有两种形态：
 *   - 字符串：单个文件，或一份清单（HLS）
 *   - { parts: [...], initUrl }：一串分片（DASH 的多数形态）
 * popup 侧的 DASH 轨就是后者，跨多个 CDN 域名时每个都要单独加防盗链规则。
 */
function specUrls(spec) {
  if (!spec) return [];
  if (typeof spec === 'string') return [spec];
  if (Array.isArray(spec)) return spec.slice();
  const out = [];
  if (spec.url) out.push(spec.url);
  if (spec.initUrl) out.push(spec.initUrl);
  if (Array.isArray(spec.parts)) out.push.apply(out, spec.parts);
  return out;
}

function firstSpecUrl(spec) {
  return specUrls(spec)[0] || '';
}

/* 对一组地址里出现过的每个域名都装上防盗链规则（同一域名只装一次） */
async function ensureHostRules(urls, ref) {
  const seen = new Set();
  for (const u of urls || []) {
    if (!u) continue;
    const h = safeHost(u);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    await ensureHostRule(u, ref);
  }
}

/*
 * 为「源站 host」设置会话规则：把发往该 CDN 域名请求的 Referer 设为页面地址、
 * 移除 Origin。用于绕过常见 CDN 防盗链（分段/播放列表 403 问题）。
 */
async function ensureHostRule(url, ref) {
  const host = safeHost(url);
  if (!host || !ref || !/^https?:/i.test(ref)) return;
  if (safeHost(ref) === host) return; // 同站无需处理
  try {
    const got = await chrome.storage.session.get('rules');
    const rules = got.rules || {};
    if (rules[host] && rules[host].ref === ref) return;

    const oldId = rules[host] ? rules[host].id : null;
    if (oldId != null) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [oldId] });
    }
    const id = await allocRuleId();
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: ref },
            { header: 'Origin', operation: 'remove' }
          ]
        },
        condition: {
          requestDomains: [host],
          resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
      }]
    });
    rules[host] = { id, ref };
    await chrome.storage.session.set({ rules });
  } catch (e) {
    /* 规则设置失败不阻塞下载 */
  }
}

async function clearAllRules() {
  try {
    const rs = await chrome.declarativeNetRequest.getSessionRules();
    if (rs && rs.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rs.map((r) => r.id) });
    }
    await chrome.storage.session.set({ rules: {} });
  } catch (e) { /* ignore */ }
}

chrome.runtime.onStartup.addListener(clearAllRules);
chrome.runtime.onInstalled.addListener(clearAllRules);

/* ---------------- 下载文件名修正 ----------------
 * 背景：跨上下文通过 downloads API 下载 blob URL 时，Chromium 会忽略 filename
 * 参数并用 UUID 命名。这里使用 onDeterminingFilename 事件在下载确定文件名时
 * 进行修正（该 API 若在未来的浏览器版本中不可用，注册会被安全跳过）。 */
const pendingDownloadNames = new Map();

try {
  if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      try {
        const rec = pendingDownloadNames.get(item.url);
        if (rec && Date.now() - rec.time < 5 * 60 * 1000) {
          pendingDownloadNames.delete(item.url);
          suggest({ filename: rec.filename, conflictAction: 'uniquify' });
        } else {
          suggest();
        }
      } catch (e) {
        try { suggest(); } catch (_) { /* ignore */ }
      }
    });
  }
} catch (e) { /* 该 API 在当前浏览器中不可用 */ }

function prunePendingNames() {
  const now = Date.now();
  for (const [k, v] of pendingDownloadNames) {
    if (now - v.time > 5 * 60 * 1000) pendingDownloadNames.delete(k);
  }
}

/* ---------------- offscreen 文档管理 ---------------- */

/* blob 下载确认：锚点方式下载后，offscreen 通过此机制确认下载已真实创建 */
const recentBlobDownloads = new Map();

try {
  if (chrome.downloads && chrome.downloads.onCreated) {
    chrome.downloads.onCreated.addListener((item) => {
      if (item && item.url && item.url.startsWith('blob:')) {
        recentBlobDownloads.set(item.url, Date.now());
      }
    });
  }
} catch (e) { /* ignore */ }

function pruneBlobDownloads() {
  const now = Date.now();
  for (const [k, v] of recentBlobDownloads) {
    if (now - v > 10 * 60 * 1000) recentBlobDownloads.delete(k);
  }
}

/* ---------------- 直接下载"失败自动回退" ----------------
 * 实测（Chrome 155）：downloads API 发起的请求不携带 Referer，
 * 且 declarativeNetRequest 的 modifyHeaders 规则不作用于这类请求
 * （扩展自身 fetch 的请求则可正常注入 Referer）。
 * 因此：downloads.download 启动的直链下载若因防盗链失败（SERVER_FORBIDDEN 等），
 * 自动回退到 offscreen 引擎：用扩展 fetch（带 Referer 规则）拉取文件再保存。
 * 监视器存于 storage.session，Service Worker 休眠后依然有效。 */
const DLWATCH_PREFIX = 'dlwatch:';

async function watchDownload(downloadId, info) {
  try {
    const got = await chrome.storage.session.get(null);
    const now = Date.now();
    const removeKeys = [];
    for (const k of Object.keys(got)) {
      if (k.startsWith(DLWATCH_PREFIX) && now - (got[k] && got[k].time || 0) > 30 * 60 * 1000) removeKeys.push(k);
    }
    if (removeKeys.length) await chrome.storage.session.remove(removeKeys);
    await chrome.storage.session.set({
      [DLWATCH_PREFIX + downloadId]: {
        url: info.url,
        filename: info.filename || '',
        name: info.name || 'file',
        time: now
      }
    });
  } catch (e) { /* ignore */ }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  try {
    if (!delta || delta.id == null) return;
    const state = delta.state && delta.state.current;
    if (!state || (state !== 'complete' && state !== 'interrupted')) return;
    const key = DLWATCH_PREFIX + delta.id;
    const got = await chrome.storage.session.get(key);
    const info = got[key];
    if (!info) return;
    await chrome.storage.session.remove(key);

    if (state === 'interrupted') {
      const err = (delta.error && delta.error.current) || '未知错误';
      /* 清理失败痕迹 */
      try { await chrome.downloads.removeFile(delta.id); } catch (e) { /* ignore */ }
      try { await chrome.downloads.erase({ id: delta.id }); } catch (e) { /* ignore */ }
      /* 回退到引擎下载 */
      try {
        await ensureOffscreen();
        const taskId = uid();
        await saveTask({
          id: taskId,
          url: info.url,
          name: info.name + '（自动重试）',
          status: 'running',
          phase: '等待回退下载',
          done: 0, total: 0, bytes: 0,
          startedAt: Date.now()
        });
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'FETCH_FILE',
          taskId,
          url: info.url,
          filename: info.filename || '',
          name: info.name
        });
        notifyPopup({ type: 'TASKS_UPDATED' });
      } catch (e) {
        /* 回退失败则记录错误任务 */
        const taskId = uid();
        await saveTask({
          id: taskId,
          url: info.url,
          name: info.name,
          status: 'error',
          phase: '失败',
          error: '直接下载失败（' + err + '），回退重试也未能启动：' + String((e && e.message) || e),
          startedAt: Date.now()
        });
        notifyPopup({ type: 'TASKS_UPDATED' });
      }
    }
  } catch (e) { /* ignore */ }
});

let creatingOffscreen = null;

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  } catch (e) { /* 继续尝试创建 */ }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: '下载并合并视频分片，生成可保存到本地的文件'
    }).catch((e) => {
      if (!/single offscreen/i.test(String(e))) throw e;
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

/* ---------------- 任务存取 ---------------- */

async function getTasks() {
  const got = await chrome.storage.session.get('tasks');
  return got.tasks || {};
}

async function saveTask(task) {
  const tasks = await getTasks();
  tasks[task.id] = Object.assign({}, tasks[task.id], task);
  const list = Object.values(tasks);
  if (list.length > MAX_TASKS) {
    list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const finished = list.filter((t) => t.status !== 'running');
    while (Object.keys(tasks).length > MAX_TASKS && finished.length) {
      const victim = finished.shift();
      delete tasks[victim.id];
    }
  }
  await chrome.storage.session.set({ tasks });
  return tasks[task.id];
}

/* ---------------- 消息处理 ---------------- */

async function handleMessage(msg, sender) {
  switch (msg.type) {
    /* ---- popup 查询 ---- */
    case 'GET_TAB_MEDIA': {
      const key = 'tab:' + msg.tabId;
      const got = await chrome.storage.session.get(key);
      const data = got[key] || { pageUrl: '', items: {} };
      const items = Object.values(data.items).sort((a, b) => {
        const r = (KIND_RANK[b.kind] || 0) - (KIND_RANK[a.kind] || 0);
        return r !== 0 ? r : b.time - a.time;
      });
      return { items, pageUrl: data.pageUrl || '' };
    }
    case 'CLEAR_TAB': {
      const key = 'tab:' + msg.tabId;
      await chrome.storage.session.set({ [key]: { pageUrl: '', items: {} } });
      return { ok: true };
    }
    case 'GET_TASKS': {
      const tasks = await getTasks();
      return { tasks: Object.values(tasks).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)) };
    }
    case 'GET_SETTINGS_META': {
      return { ok: true };
    }

    /* ---- content script 上报 DOM 中的视频 ---- */
    case 'DOM_MEDIA': {
      const tabId = sender && sender.tab ? sender.tab.id : -1;
      if (tabId >= 0 && Array.isArray(msg.items)) {
        for (const it of msg.items.slice(0, 100)) {
          const norm = normalizeKind(it.kind, it.kind);
          record(tabId, {
            url: it.url,
            ext: /^blob:/.test(it.url) ? '' : (it.kind === 'blob' ? '' : it.kind),
            kind: /^blob:/.test(it.url) ? 'blob' : norm.kind,
            size: 0,
            ref: msg.pageUrl || '',
            source: 'dom'
          });
        }
      }
      return { ok: true };
    }

    /* ---- 内容脚本：性能时间线回溯（补报扩展开始观测之前就已发生的请求） ---- */
    case 'PERF_MEDIA': {
      const tabId = sender && sender.tab ? sender.tab.id : -1;
      if (tabId >= 0 && Array.isArray(msg.items)) {
        for (const it of msg.items.slice(0, 120)) {
          if (!it || typeof it.url !== 'string') continue;
          if (it.kind === 'cand') {
            recordCandidate(tabId, it.url, it.size || 0, msg.pageUrl || '');
            continue;
          }
          const norm = normalizeKind(it.kind, it.kind);
          record(tabId, {
            url: it.url,
            ext: norm.ext || it.kind,
            kind: norm.kind,
            size: it.size || 0,
            ref: msg.pageUrl || '',
            source: 'perf'
          });
        }
      }
      return { ok: true };
    }

    /* ---- popup：抓取播放列表文本（走后台以便附带 Referer 规则） ---- */
    case 'FETCH_TEXT': {
      await ensureHostRule(msg.url, msg.pageUrl);
      const res = await smartFetch(msg.url, {
        cache: 'no-store',
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(20000) : undefined
      });
      if (!res.ok) return { error: '获取播放列表失败：HTTP ' + res.status };
      const text = (await res.text()).replace(/^\uFEFF/, '');
      return { text };
    }

    /* ---- popup：启动 HLS 下载任务 ---- */
    case 'START_HLS': {
      await ensureOffscreen();
      await ensureHostRule(msg.url, msg.pageUrl || '');
      const taskId = uid();
      const task = {
        id: taskId,
        url: msg.url,
        name: msg.name || 'video',
        status: 'running',
        phase: '准备中',
        done: 0,
        total: 0,
        bytes: 0,
        startedAt: Date.now(),
        tabId: msg.tabId
      };
      await saveTask(task);
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'START_HLS',
        taskId,
        url: msg.url,
        name: msg.name || 'video',
        folder: msg.folder || '',
        format: msg.format || 'auto',
        concurrency: msg.concurrency || 6,
        saveMethod: msg.saveMethod || 'auto'
      });
      notifyPopup({ type: 'TASKS_UPDATED' });
      return { taskId, task };
    }

    /* ---- popup：取消任务 ---- */
    case 'CANCEL_TASK': {
      try {
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'CANCEL', taskId: msg.taskId });
      } catch (e) { /* offscreen 可能已关闭 */ }
      await saveTask({ id: msg.taskId, status: 'canceled', phase: '已取消' });
      notifyPopup({ type: 'TASKS_UPDATED' });
      return { ok: true };
    }

    /* ---- popup：直接下载普通文件 ---- */
    case 'DIRECT_DOWNLOAD': {
      await ensureHostRule(msg.url, msg.pageUrl || '');
      const downloadId = await chrome.downloads.download({
        url: msg.url,
        filename: msg.filename || undefined,
        conflictAction: 'uniquify',
        saveAs: false
      });
      /* 登记监视：若被防盗链拦截（403）等失败，自动回退到引擎下载（扩展 fetch 带 Referer） */
      await watchDownload(downloadId, { url: msg.url, filename: msg.filename || '', name: msg.name || (msg.filename ? msg.filename.replace(/^.*[\\/]/, '') : 'video') });
      return { downloadId };
    }

    /* ---- popup：探测分片文件的轨道类型（视频轨/音频轨） ----
     * DASH 站点把音视频拆成两条流，需要先读文件头判断谁是谁，
     * 才能在界面上提示"可以合并"并在下载时自动配对。 */
    case 'PROBE_HEADS': {
      const list = Array.isArray(msg.items) ? msg.items.slice(0, 24) : [];
      const out = {};
      await Promise.all(list.map(async (it) => {
        const url = it && it.url;
        if (!url || !/^https?:/i.test(url)) return;
        if (headCache.has(url)) { out[url] = headCache.get(url); return; }
        try {
          await ensureHostRule(url, it.pageUrl || msg.pageUrl || '');
          const res = await smartFetch(url, {
            headers: { Range: 'bytes=0-65535' },
            cache: 'no-store',
            signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined
          });
          if (!res.ok && res.status !== 206) { out[url] = { ok: false, error: 'HTTP ' + res.status }; return; }
          const buf = new Uint8Array(await res.arrayBuffer());
          let info = (typeof Fmp4Merge !== 'undefined' && Fmp4Merge)
            ? Fmp4Merge.classifyHead(buf)
            : { ok: false, error: 'no-lib' };
          /* fMP4 判不出来时再按 WebM/Matroska 试一次 —— YouTube 的 VP9/Opus 轨都是
             WebM，只按 ISO BMFF 判定会把它们整类漏掉（角色就只能靠 URL 声明兜底，
             拿不到分辨率/编解码信息，也确认不了容器能不能合并）。 */
          if ((!info || !info.ok) && typeof WebmMerge !== 'undefined' && WebmMerge && WebmMerge.isWebmHead(buf)) {
            info = WebmMerge.probe(buf);
          }
          headCache.set(url, info);
          out[url] = info;
        } catch (e) {
          out[url] = { ok: false, error: String((e && e.message) || e) };
        }
      }));
      return { heads: out };
    }

    /* ---- popup：对「候选」条目按内容签名定性（拉前 4KB 判断真实类型） ---- */
    case 'PROBE_KIND': {
      const list = Array.isArray(msg.items) ? msg.items.slice(0, 20) : [];
      const results = {};
      await Promise.all(list.map(async (it) => {
        const url = it && it.url;
        if (!url || !/^https?:/i.test(url)) return;

        const finish = (sig) => {
          results[url] = sig;
          const tabId = msg.tabId;
          if (sig && sig.ok && sig.kind) {
            /* 定性成功：覆盖候选条目（体积/时间等原有信息会保留） */
            if (tabId != null && tabId >= 0) {
              record(tabId, {
                url,
                ext: sig.ext || '',
                kind: sig.kind,
                size: 0,
                ref: it.pageUrl || msg.pageUrl || '',
                source: 'probe'
              });
            }
          } else if (tabId != null && tabId >= 0) {
            /* 确认不是媒体：直接从列表里去掉，并记住避免重探 */
            dropItem(tabId, url);
          }
        };

        if (sigCache.has(url)) { finish(sigCache.get(url)); return; }
        try {
          await ensureHostRule(url, it.pageUrl || msg.pageUrl || '');
          const res = await smartFetch(url, {
            headers: { Range: 'bytes=0-4095' },
            cache: 'no-store',
            signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(12000) : undefined
          });
          if (!res.ok && res.status !== 206) { finish({ ok: false, error: 'HTTP ' + res.status }); return; }
          const buf = new Uint8Array(await res.arrayBuffer());
          const sig = (typeof SniffSig !== 'undefined' && SniffSig)
            ? SniffSig.classify(buf)
            : { ok: false, error: 'no-lib' };
          sigCache.set(url, sig);
          finish(sig);
        } catch (e) {
          finish({ ok: false, error: String((e && e.message) || e) });
        }
      }));
      /* 等存储写入落地再回包，避免 popup 立刻重读时拿到的还是候选状态 */
      await (tabChains.get(msg.tabId) || Promise.resolve());
      notifyPopup({ type: 'MEDIA_UPDATED', tabId: msg.tabId });
      return { results };
    }

    /* ---- popup：音视频轨合并下载 ---- */
    case 'START_MERGE': {
      await ensureOffscreen();
      /* 两侧都可能是「一串分片」（DASH）—— 把涉及到的域名全部加上防盗链规则 */
      await ensureHostRules(specUrls(msg.videoSpec || msg.videoUrl), msg.pageUrl || '');
      await ensureHostRules(specUrls(msg.audioSpec || msg.audioUrl), msg.pageUrl || '');
      const taskId = uid();
      const task = {
        id: taskId,
        url: firstSpecUrl(msg.videoSpec || msg.videoUrl),
        name: msg.name || 'video',
        status: 'running',
        phase: '准备中（音视频合并）',
        done: 0,
        total: 2,
        bytes: 0,
        merged: true,
        startedAt: Date.now(),
        tabId: msg.tabId
      };
      await saveTask(task);
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'START_MERGE',
        taskId,
        videoUrl: typeof msg.videoUrl === 'string' ? msg.videoUrl : '',
        audioUrl: typeof msg.audioUrl === 'string' ? msg.audioUrl : '',
        videoSpec: msg.videoSpec || null,
        audioSpec: msg.audioSpec || null,
        name: msg.name || 'video',
        folder: msg.folder || '',
        saveMethod: msg.saveMethod || 'auto'
      });
      notifyPopup({ type: 'TASKS_UPDATED' });
      return { taskId, task };
    }

    /* ---- popup：单独下载一条多分片轨（DASH 音频轨） ---- */
    case 'START_PARTS': {
      await ensureOffscreen();
      const parts = Array.isArray(msg.parts) ? msg.parts.slice() : [];
      if (msg.initUrl) parts.unshift(msg.initUrl);
      if (!parts.length) return { error: '没有可下载的分片' };
      await ensureHostRules(parts, msg.pageUrl || '');
      const taskId = uid();
      const task = {
        id: taskId,
        url: parts[0],
        name: msg.name || 'audio',
        status: 'running',
        phase: '准备中',
        done: 0,
        total: parts.length,
        bytes: 0,
        startedAt: Date.now(),
        tabId: msg.tabId
      };
      await saveTask(task);
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'START_PARTS',
        taskId,
        parts,
        initUrl: '',
        ext: msg.ext || '',
        kind: msg.kind || '',
        name: msg.name || 'audio',
        folder: msg.folder || '',
        saveMethod: msg.saveMethod || 'auto'
      });
      notifyPopup({ type: 'TASKS_UPDATED' });
      return { taskId, task };
    }

    /* ---- offscreen：任务进度上报 ---- */
    case 'TASK_UPDATE': {
      const saved = await saveTask(msg.task);
      if (saved && (saved.status === 'done' || saved.status === 'error' || saved.status === 'canceled')) {
        /* 任务结束：清理不再需要的信息 */
      }
      notifyPopup({ type: 'TASKS_UPDATED' });
      return { ok: true };
    }

    /* ---- offscreen：确认 blob 下载是否已创建 ---- */
    case 'VERIFY_BLOB_DOWNLOAD': {
      pruneBlobDownloads();
      return { found: recentBlobDownloads.has(msg.blobUrl) };
    }

    /* ---- offscreen：兜底保存 blob ---- */
    case 'SAVE_BLOB': {
      prunePendingNames();
      pendingDownloadNames.set(msg.blobUrl, { filename: msg.filename || 'video.mp4', time: Date.now() });
      const downloadId = await chrome.downloads.download({
        url: msg.blobUrl,
        filename: msg.filename || undefined,
        conflictAction: 'uniquify',
        saveAs: false
      });
      return { downloadId };
    }

    default:
      return { error: '未知消息类型: ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target !== 'background') return;
  handleMessage(msg, sender)
    .then((r) => sendResponse(r || {}))
    .catch((e) => {
      try { sendResponse({ error: String((e && e.message) || e) }); } catch (_) { /* ignore */ }
    });
  return true;
});
