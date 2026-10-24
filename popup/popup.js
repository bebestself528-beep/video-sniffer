/* ============================================================
 * 视频嗅探下载器 - popup 界面逻辑
 * ============================================================ */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const DEFAULTS = { folder: '视频下载', format: 'auto', concurrency: 6 };

  let settings = Object.assign({}, DEFAULTS);
  let currentTab = null;
  let pageUrl = '';
  let items = [];
  let tasks = [];
  let filter = 'all';
  let variantOpenUrl = null; // 当前展开清晰度面板的资源

  /* ============================================================
   * 演示模式（README：仅用于商店截图与本地界面预览，不影响正常使用）
   * 打开方式：popup.html?state=demo[&tab=all|hls|file|seg|dom|tasks|settings][&variant=1][&dash=1][&scene=dash]
   * 演示数据全部为虚构示例地址（example.com），与任何真实网站无关。
   * ============================================================ */
  const QS = new URLSearchParams(location.search);
  const IS_DEMO = QS.get('state') === 'demo';
  const DEMO_TAB = QS.get('tab') || 'all';
  const DEMO_VARIANT = QS.get('variant') === '1';
  const DEMO_DASH = QS.get('dash') === '1';
  const DEMO_SCENE = QS.get('scene') || '';
  const HAS_CHROME = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  const DEMO_PAGE_URL = 'https://player.example.com/watch/demo-video';

  const DEMO_ITEMS = [
    { kind: 'hls', url: 'https://vod.example.com/hls/movie/master.m3u8', time: Date.now() - 96000, source: 'request' },
    { kind: 'hls', url: 'https://vod.example.com/hls/live/channel/index.m3u8', time: Date.now() - 94000, source: 'request' },
    { kind: 'mp4', url: 'https://media.example.com/files/opening_4k.mp4', size: 24641536, time: Date.now() - 93000, source: 'request' },
    { kind: 'webm', url: 'https://media.example.com/files/bonus_clip.webm', size: 5242880, time: Date.now() - 91000, source: 'request' },
    { kind: 'dash', url: 'https://vod.example.com/dash/stream.mpd', time: Date.now() - 90000, source: 'request' },
    { kind: 'video', url: 'https://media.example.com/embed/player_video_1080p.mp4', time: Date.now() - 88000, source: 'dom' },
    { kind: 'blob', url: 'blob:https://player.example.com/9f8a1c2e-mse-source', time: Date.now() - 87000, source: 'dom' },
    { kind: 'fmp4', url: 'https://vod.example.com/dash/movie-1-30080.m4s', size: 133169152, time: Date.now() - 86000, source: 'request' },
    { kind: 'fmp4', url: 'https://vod.example.com/dash/movie-1-30280.m4s', size: 24117248, time: Date.now() - 85000, source: 'request' },
    { kind: 'ts', url: 'https://vod.example.com/hls/movie/seg_000042.ts', size: 1048576, time: Date.now() - 84000, source: 'request' },
    { kind: 'ts', url: 'https://vod.example.com/hls/movie/seg_000043.ts', size: 1048576, time: Date.now() - 83000, source: 'request' },
    { kind: 'ts', url: 'https://vod.example.com/hls/movie/seg_000044.ts', size: 1048576, time: Date.now() - 82000, source: 'request' }
  ];

  /* 演示场景：模拟不同站点的嗅探结果，仅用于商店截图与回归测试 */
  const DEMO_SCENES = {
    /* DASH 站点：画面与声音是两条独立流 */
    dash: [
      { kind: 'dash', url: 'https://vod.example.com/dash/stream.mpd', time: Date.now() - 92000, source: 'request' },
      { kind: 'fmp4', url: 'https://vod.example.com/dash/movie-1-30080.m4s', size: 133169152, time: Date.now() - 91000, source: 'request' },
      { kind: 'fmp4', url: 'https://vod.example.com/dash/movie-1-30280.m4s', size: 24117248, time: Date.now() - 90000, source: 'request' }
    ],
    /* 抖音形态：分离轨无后缀（video/mp4 视频轨 + audio/mp4 音轨），两条 URL 路径结构完全不同 */
    douyin: [
      { kind: 'video', url: 'https://vod.example.com/tos-cn-ve-15/oQv001/media-video-hvc1/?a=6383&ch=26&cr=3&sig=demov', size: 0, time: Date.now() - 90000, source: 'net' },
      { kind: 'audio', url: 'https://vod.example.com/tos-cn-ve-15/oQa002/media-audio-und-mp4a/?a=6383&ch=26&cr=3&sig=demo-b', size: 0, time: Date.now() - 89000, source: 'net' }
    ],
    /* YouTube 形态：路径全是 /videoplayback，身份在 ?id= 里，角色由 &mime= 声明，
       且原本一条轨被切成多个 &range= 分片（后台已归一成一条，size 取自 clen）。
       注意这里故意不预置轨道探测结果：VP9/Opus 轨是 WebM 不是 fMP4，文件头探测
       必然失败，角色只能靠 URL 声明兜底 —— 这正是要验证的路径。 */
    youtube: [
      { kind: 'video', url: 'https://rr3---sn-demo.googlevideo.com/videoplayback?id=o-DEMO123456&itag=137&mime=video%2Fmp4&clen=133169152&dur=1847.1', size: 133169152, time: Date.now() - 90000, source: 'net', slice: true },
      { kind: 'audio', url: 'https://rr3---sn-demo.googlevideo.com/videoplayback?id=o-DEMO123456&itag=251&mime=audio%2Fwebm&clen=4832000&dur=1847.1', size: 4832000, time: Date.now() - 89000, source: 'net', slice: true }
    ]
  };

  const DEMO_TASKS = [
    {
      id: 'demo-1', name: '纪录片_第1集_1080P.mp4', status: 'running',
      phase: '下载分片', done: 62, total: 148, bytes: 78643200, speed: 3145728,
      url: 'https://vod.example.com/hls/movie/1080p/index.m3u8', startedAt: Date.now() - 32000
    },
    {
      id: 'demo-2', name: '宣传片_4K.mp4', status: 'done', sizeStr: '312.4 MB',
      url: 'https://media.example.com/files/opening_4k.mp4', startedAt: Date.now() - 600000
    }
  ];

  const DEMO_VARIANTS = [
    { res: '3840x2160（2160P）', bw: '12.80 Mbps', codecs: 'avc1.640033,mp4a.40.2' },
    { res: '1920x1080（1080P）', bw: '5.20 Mbps', codecs: 'avc1.640028,mp4a.40.2' },
    { res: '1280x720（720P）', bw: '2.60 Mbps', codecs: 'avc1.4d001f,mp4a.40.2' },
    { res: '854x480（480P）', bw: '1.10 Mbps', codecs: 'avc1.4d001e,mp4a.40.2' }
  ];

  /* 演示场景用的 DASH 清单（形态取自真实站点：SegmentTemplate 写在 AdaptationSet 上、
     SegmentTimeline 列分片、声音是独立声道组）。演示模式也用真解析器解一遍，
     保证界面里看到的轨道信息与真实运行时完全一致。 */
  const DEMO_MPD = '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1847.1S" minBufferTime="PT4S">\n' +
    '  <BaseURL>https://vod.example.com/dash/</BaseURL>\n' +
    '  <Period id="0" start="PT0S" duration="PT1847.1S">\n' +
    '    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" frameRate="25">\n' +
    '      <SegmentTemplate timescale="1000" media="video/$RepresentationID$/$Number%05d$.m4s" initialization="video/$RepresentationID$/init.mp4" duration="5000" startNumber="1"/>\n' +
    '      <Representation id="2160p" bandwidth="12800000" codecs="avc1.640033" width="3840" height="2160"/>\n' +
    '      <Representation id="1080p" bandwidth="5200000" codecs="avc1.640028" width="1920" height="1080"/>\n' +
    '      <Representation id="720p" bandwidth="2600000" codecs="avc1.4d001f" width="1280" height="720"/>\n' +
    '      <Representation id="480p" bandwidth="1100000" codecs="avc1.4d001e" width="854" height="480"/>\n' +
    '    </AdaptationSet>\n' +
    '    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="zh">\n' +
    '      <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>\n' +
    '      <SegmentTemplate timescale="44100" media="audio/$RepresentationID$/$Number%05d$.m4s" initialization="audio/$RepresentationID$/init.mp4" duration="220500" startNumber="1"/>\n' +
    '      <Representation id="aac128" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="44100"/>\n' +
    '    </AdaptationSet>\n' +
    '  </Period>\n' +
    '</MPD>';

  /* 演示模式下预置的轨道识别结果 */
  const DEMO_HEADS = {
    'https://vod.example.com/dash/movie-1-30080.m4s': { ok: true, role: 'video', label: '视频轨', codec: 'avc1', detail: '1920×1080', width: 1920, height: 1080 },
    'https://vod.example.com/dash/movie-1-30280.m4s': { ok: true, role: 'audio', label: '音频轨', codec: 'mp4a', detail: '2ch 44100Hz', channels: 2, sampleRate: 44100 },
    /* 抖音形态：无后缀分离轨 */
    'https://vod.example.com/tos-cn-ve-15/oQv001/media-video-hvc1/?a=6383&ch=26&cr=3&sig=demov': { ok: true, role: 'video', label: '视频轨', codec: 'hvc1', detail: '1280×720', width: 1280, height: 720 },
    'https://vod.example.com/tos-cn-ve-15/oQa002/media-audio-und-mp4a/?a=6383&ch=26&cr=3&sig=demo-b': { ok: true, role: 'audio', label: '音频轨', codec: 'mp4a', detail: '2ch 44100Hz', channels: 2, sampleRate: 44100 }
  };

  /* ---------------- 与后台通讯 ---------------- */

  function bg(msg) {
    if (IS_DEMO) return Promise.resolve({});
    return chrome.runtime.sendMessage(Object.assign({ target: 'background' }, msg));
  }

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtBytes(n) {
    if (!n) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
  }

  /* 条目上的"距今多久"。
     过去这里直接把嗅探时间戳格式化成 HH:MM:SS 摆在条目副标题里，且没有任何标签 ——
     用户会把它当成视频时长（"一直显示 9:53:38"就是这么来的：那是请求发生时的钟点，
     条目不刷新它就永远停在那儿）。改成相对时间，精确钟点只放进 title 提示。 */
  function fmtTime(ts) {
    if (!ts || !isFinite(ts)) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '刚刚';
    const s = Math.floor(diff / 1000);
    if (s < 45) return '刚刚';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    try { return new Date(ts).toLocaleDateString(); } catch (e) { return ''; }
  }

  /* 精确钟点（只用于 title 提示，不直接显示） */
  function exactTime(ts) {
    if (!ts || !isFinite(ts)) return '';
    try { return new Date(ts).toLocaleString(); } catch (e) { return ''; }
  }

  /* 时长是否落在合理区间。清单里的 duration 经常是站点写死的假值
     （实测过 9 小时这种），超过 6 小时或不足 1 秒一律视为不可信。 */
  function saneDuration(sec) {
    return typeof sec === 'number' && isFinite(sec) && sec >= 1 && sec <= 6 * 3600;
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  function nameFromUrl(url) {
    try {
      const u = new URL(url);
      const segs = u.pathname.split('/').filter(Boolean);
      let base = decodeURIComponent(segs[segs.length - 1] || '');
      if (!base || base.length > 90 || base.indexOf('.') < 0) base = u.hostname + (segs.length ? '_' + (segs[segs.length - 1] || '').slice(0, 40) : '');
      return base;
    } catch (e) { return 'video'; }
  }

  function sanitizeName(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[.\s_]+|[.\s_]+$/g, '')
      .slice(0, 100) || 'video';
  }

  function badgeOf(item) {
    const map = {
      hls: ['HLS', 'b-hls'], dash: ['DASH', 'b-dash'], mp4: ['MP4', 'b-mp4'],
      webm: ['WEBM', 'b-webm'], flv: ['FLV', 'b-flv'], mkv: ['MKV', 'b-mkv'],
      ts: ['TS', 'b-seg'], fmp4: ['M4S', 'b-seg'], blob: ['BLOB', 'b-blob'], video: ['VIDEO', 'b-dom'],
      audio: ['AUDIO', 'b-audio']
    };
    return map[item.kind] || [(item.ext || item.kind || '?').toUpperCase().slice(0, 5), 'b-dom'];
  }

  /* 「疑似整轨」的条目：需要探测文件头才能判定是视频轨/音频轨还是完整文件。
     - fmp4（.m4s）：B站等 DASH 站点拆出来的整轨
     - video / audio：无后缀的分离轨（抖音等站点：video/mp4 的视频轨 + audio/mp4 的音轨）
     - 无后缀的 mp4：按内容签名定性成 mp4 的无后缀流（普通 MP4 形态的分离轨 / 完整文件） */
  const EXT_HINT_RE = /\.(m3u8|m3u|mpd|mp4|m4v|m4s|webm|flv|f4v|mkv|mov|avi|ts|ogv|3gp|mpg|mpeg|wmv|qt|m4a|mp3|aac|opus|ogg|oga|flac|wav)(?:$|[?#])/i;
  function isTrackLike(item) {
    if (item.kind === 'fmp4' || item.kind === 'video' || item.kind === 'audio') return true;
    if (item.kind === 'mp4' && !EXT_HINT_RE.test(item.url)) return true;
    return false;
  }

  function isSeg(item) {
    if (item.kind === 'ts') return true;
    /* .m4s 既可能是 HLS 的分片，也可能是 DASH 站点拆分出来的完整视频轨/音频轨。
       识别出是「整轨」的（见 isTrackCandidate），就归入常规列表，方便直接下载。 */
    if (item.kind === 'fmp4') return !isTrackCandidate(item);
    return false;
  }

  /* ---------------- 轨道识别与音视频配对 ---------------- */

  let probeMap = new Map();   // url -> { ok, role, label, detail, codec, width, height, channels, sampleRate }
  let probing = false;
  let candUrls = [];          // 待定性候选：URL 与响应头都判不出类型，等按内容签名识别
  const candTried = new Set(); // 本次弹窗会话里已发起过定性的候选，避免重复

  /* ---------------- HLS 音频组（#EXT-X-MEDIA:TYPE=AUDIO） ----------------
     主流 HLS 把声音拆成一条独立的音频 playlist，画面 variant 本身不含声音。
     那条音频 playlist 播放器会去请求，但它与主清单长得毫无关系，常常抓不到或
     认不出。主清单的 #EXT-X-MEDIA 已经把地址写清楚了，直接读出来即可 ——
     这也是「不必等播放就能拿到」的一条捷径。 */
  let derivedItems = [];                      // 由清单推导出来的条目（不在网络嗅探结果里）
  const hlsAudioGroups = new Map();           // 主清单 URL → 该清单的音频轨条目[]
  const hlsGroupTried = new Set();            // 已读过主清单的地址，避免重复请求
  const dashReps = new Map();                 // .mpd 地址 → { video: [], audio: [] }（Representation 列表）
  const dashTried = new Set();                // 已读过的 MPD 地址，避免重复请求
  let lastPageUrl = null;

  /* 取一条条目的轨道角色 —— 这是「谁是画面、谁是声音」的唯一出口，全流程都走它。
     优先级：
       ① 文件头探测结果（最可信：直接读 moov 里的 handler_type）
       ② 探测失败时退回 URL 里站点自己声明的角色：YouTube 的 Opus/WebM 音轨不是
          fMP4，文件头探测必然失败，但 &mime=audio%2Fwebm 已经写得很清楚；
          抖音的 media-audio-und-mp4a 同理。
       ③ 但探测「成功」且判为音视频一体（both）时不退回 URL —— 否则一份完整的
          MP4 会被当成「只有画面」，进而跑去和别的音频配对，产出错文件。
     返回 { ok, role, label, detail, codec, … } 或 null。 */
  function roleInfoOf(item) {
    if (!item) return null;
    const probed = probeMap.get(item.url);
    if (probed && probed.ok && probed.role && probed.role !== 'unknown') return probed;
    if (typeof MediaRole !== 'undefined') {
      const r = MediaRole.roleFromUrl(item.url);
      if (r === 'video' || r === 'audio') {
        return {
          ok: true,
          role: r,
          label: r === 'video' ? '视频轨' : '音频轨',
          detail: '按流地址判定',
          fromUrl: true
        };
      }
    }
    return probed || null;
  }

  function roleOf(item) {
    const info = roleInfoOf(item);
    return info && info.ok ? info.role : '';
  }

  function isTrackCandidate(item) {
    const r = roleOf(item);
    return r === 'video' || r === 'audio';
  }

  /* 拆分「主文件名 + 扩展名」。
     必须先摘掉扩展名再取数字，否则 .m4s 里的 "4" 会被误当成文件名末尾的数字段，
     导致同一视频的两条轨（xxx-30080.m4s / xxx-30280.m4s）被拆成两个不同的组、永远配不上对。 */
  function splitExt(file) {
    const m = /(\.[a-z0-9]{1,5})$/i.exec(file);
    return m ? [file.slice(0, file.length - m[1].length), m[1]] : [file, ''];
  }

  /* 身份写在 query 里的站点（YouTube 的 /videoplayback?id=o-xxx）：
     路径对所有视频都是同一个，只有 query 里的 id 能区分是「哪条视频」。
     注意不要收 itag/mime —— 那正是用来区分「同一视频的不同轨」的。 */
  const IDENTITY_QUERY_KEYS = ['id', 'videoid', 'video_id', 'assetid', 'asset_id',
    'mediaid', 'media_id', 'fileid', 'file_id', 'contentid', 'content_id', 'movieid', 'movie_id'];

  function identityOf(url) {
    const qAt = url.indexOf('?');
    if (qAt < 0) return '';
    const out = [];
    for (const kv of url.slice(qAt + 1).split('&')) {
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const k = kv.slice(0, eq).toLowerCase();
      if (IDENTITY_QUERY_KEYS.indexOf(k) >= 0) out.push(k + '=' + kv.slice(eq + 1));
    }
    return out.join('&');
  }

  /* 分组键：同一视频的音视频轨常常来自不同 CDN 域名，因此只比较路径。
     把主文件名里最后一段连续数字替换成 *（如 62131_da3-1-30080.m4s → 62131_da3-1-*.m4s） */
  function groupKeyOf(url) {
    try {
      const p = new URL(url).pathname;
      const i = p.lastIndexOf('/');
      const dir = p.slice(0, i + 1);
      const pair = splitExt(p.slice(i + 1));
      let stem = pair[0];
      const m = /^(.*?)(\d+)$/.exec(stem);
      if (m && m[2].length >= 2) stem = m[1] + '*';
      const ident = identityOf(url);
      return dir + stem + pair[1] + (ident ? '?' + ident : '');
    } catch (e) { return url; }
  }

  /* 质量标签，用于去重：同一质量的不同 CDN 是同一份内容。
     iTag 站点（YouTube）用 itag 区分同一视频的不同轨与不同清晰度。 */
  function qualityTagOf(url) {
    try {
      if (typeof MediaRole !== 'undefined') {
        const it = MediaRole.itagOf(url);
        if (it) return 'itag' + it;
      }
      const pair = splitExt(new URL(url).pathname.split('/').pop() || '');
      const m = /(\d+)$/.exec(pair[0]);
      return m ? m[1] : pair[0] + pair[1];
    } catch (e) { return url; }
  }

  function scoreOfTrack(info) {
    if (!info || !info.ok) return 0;
    if (info.role === 'video') return (info.width || 0) * (info.height || 0);
    if (info.role === 'audio') return (info.sampleRate || 0) * (info.channels || 1);
    return 0;
  }

  /* 按分组键聚合整轨条目，并给出每组的视频轨/音频轨（各取质量最高的一条）。
     参与配对的条目：
       - fmp4（.m4s）：B站等 DASH 站点拆出来的整轨
       - video / audio：已探明角色的无后缀分离轨（抖音、YouTube 等），未探明角色的不参与 */
  function buildGroups() {
    const groups = new Map();
    const seen = new Set();   // groupKey + 质量标签，用于跨 CDN 去重
    for (const it of items) {
      const role = roleOf(it);
      const probedTrack = role === 'video' || role === 'audio';
      const eligible = it.kind === 'fmp4' || (isTrackLike(it) && probedTrack);
      if (!eligible) continue;

      const key = groupKeyOf(it.url);
      const dedupe = key + '|' + qualityTagOf(it.url);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      if (!groups.has(key)) groups.set(key, { key, all: [], videos: [], audios: [] });
      const g = groups.get(key);
      g.all.push(it);
      if (role === 'video') g.videos.push(it);
      else if (role === 'audio') g.audios.push(it);
    }
    for (const g of groups.values()) {
      g.videos.sort((a, b) => scoreOfTrack(roleInfoOf(b)) - scoreOfTrack(roleInfoOf(a)));
      g.audios.sort((a, b) => scoreOfTrack(roleInfoOf(b)) - scoreOfTrack(roleInfoOf(a)));
      g.bestVideo = g.videos[0] || null;
      g.bestAudio = g.audios[0] || null;
    }

    /* 兜底配对（跨组）：同一视频的画面与声音可能落在完全不同的路径分组里
       （抖音 media-video-* / media-audio-*、YouTube 同一 pathname 下的不同 itag
       被分到不同目录时都这样），按路径永远配不上。
       这里的配对依据是「请求时间邻近」—— 同一条视频的两条轨几乎同时被请求。
       只处理「完全没有配套轨」的组，且一条音频不会被两个画面抢走；
       相隔超过 CROSS_PAIR_WINDOW 的坚决不配（宁可标"未发现配套音频轨"，
       也不要拿另一条视频的声音去凑，那比没声音更糟）。 */
    const CROSS_PAIR_WINDOW = 30000;
    const vFree = [];
    const aFree = [];
    for (const g of groups.values()) {
      if (g.bestVideo && !g.bestAudio) vFree.push({ it: g.bestVideo, g });
      if (g.bestAudio && !g.bestVideo) aFree.push({ it: g.bestAudio, g });
    }
    if (vFree.length && aFree.length) {
      const pool = aFree.map((x, i) => ({ x, i, used: false }));
      for (const v of vFree) {
        let best = null;
        let bestGap = Infinity;
        for (const p of pool) {
          if (p.used) continue;
          const gap = Math.abs((p.x.it.time || 0) - (v.it.time || 0));
          if (gap < bestGap) { bestGap = gap; best = p; }
        }
        if (!best || bestGap > CROSS_PAIR_WINDOW) continue;
        best.used = true;
        v.g.crossAudio = best.x.it;   // 视频轨所在组：记住配到的音频
        best.x.g.crossVideo = v.it;   // 音频轨所在组：记住配到的视频
      }
    }
    return groups;
  }

  /* 探测 fmp4 条目的文件头，判断是视频轨还是音频轨；
     顺带对「候选」条目做内容签名定性（识别不出来的会被后台直接删掉）。
     识别完成后会自行重渲染一次。 */
  async function probeHeads() {
    if (IS_DEMO || probing) return;
    probing = true;
    try {
      /* 1) 候选条目定性：成功者会在后台被改写成真实类型，需要重新拉一次列表 */
      const need = candUrls.filter((u) => !candTried.has(u)).slice(0, 12);
      if (need.length) {
        need.forEach((u) => candTried.add(u));
        try {
          await bg({
            type: 'PROBE_KIND',
            tabId: currentTab ? currentTab.id : -1,
            pageUrl: pageUrl,
            items: need.map((u) => ({ url: u, pageUrl: pageUrl }))
          });
          await loadMedia();
        } catch (e) { /* 定性失败不影响正常下载 */ }
      }

      /* 2) 整轨识别：判断每条是视频轨还是音频轨，用于配对合并。
         - fmp4（.m4s）：B站等 DASH 站点拆出来的整轨
         - video / audio：无后缀的分离轨（抖音等站点：video/mp4 视频轨 + audio/mp4 音轨）
         清单推导出来的条目（HLS 音频组 / DASH 音频轨）跳过：它们的角色清单里已经写明，
         而且 DASH 那条指向的是单个分片，探测必然失败。 */
      const trackLike = items.filter((it) => !it.derived && isTrackLike(it));
      /* 数量过多说明这是一份 HLS 的 fMP4 分片列表，不是 DASH 的整轨，跳过探测 */
      if (trackLike.length && trackLike.length <= 60) {
        const needHeads = trackLike.filter((it) => !probeMap.has(it.url)).slice(0, 24);
        if (needHeads.length) {
          const r = await bg({
            type: 'PROBE_HEADS',
            pageUrl: pageUrl,
            items: needHeads.map((it) => ({ url: it.url, pageUrl: pageUrl || it.ref || '' }))
          });
          const heads = (r && r.heads) || {};
          for (const u of Object.keys(heads)) probeMap.set(u, heads[u]);
        }
      }
    } catch (e) { /* 探测失败不影响正常下载 */ }
    probing = false;
    renderList();
    renderFoot();
  }

  /* 主动发现 HLS 音频组：读主清单 → 解析 #EXT-X-MEDIA:TYPE=AUDIO → 把独立的音频
     playlist 作为一条「音频轨」补进列表，并记下它与主清单的对应关系，供「选择清晰度」
     时把画面 variant 与音频组一起下载后合并。 */
  async function discoverHlsAudioGroups() {
    if (IS_DEMO || probing) return;
    const masters = items.filter((it) => it.kind === 'hls' && !it.derived && !hlsGroupTried.has(it.url)).slice(0, 4);
    if (!masters.length) return;
    masters.forEach((it) => hlsGroupTried.add(it.url));

    let changed = false;
    for (const it of masters) {
      try {
        const r = await bg({ type: 'FETCH_TEXT', url: it.url, pageUrl: pageUrl || (it.ref || '') });
        if (!r || r.error || typeof r.text !== 'string') continue;
        const parsed = HLSKit.parsePlaylist(r.text, it.url);
        if (parsed.kind !== 'master' || !parsed.audioGroups || !parsed.audioGroups.length) continue;

        const list = [];
        for (const g of parsed.audioGroups) {
          let item = derivedItems.find((x) => x.url === g.uri);
          if (!item) {
            item = {
              url: g.uri,
              kind: 'hls',
              ext: 'm3u8',
              size: 0,
              time: Date.now(),
              ref: it.url,
              role: 'audio',
              source: 'hlsgroup',
              derived: true,
              groupName: [g.name, g.language, g.channels].filter(Boolean).join(' · ')
            };
            derivedItems.push(item);
            hlsGroupTried.add(g.uri);
          }
          list.push(item);
        }
        if (list.length) { hlsAudioGroups.set(it.url, list); changed = true; }
      } catch (e) { /* 单条主清单失败不影响其他 */ }
    }
    if (changed) renderAll();
  }

  /* 取一份 .mpd 并解析成可直接下载的轨道。
     清单里 AdaptationSet 的 contentType 直接标明谁是谁，不用猜路径。 */
  async function fetchDash(url, ref) {
    const r = await bg({ type: 'FETCH_TEXT', url, pageUrl: pageUrl || ref || '' });
    if (r && r.error) throw new Error(r.error);
    if (!r || typeof r.text !== 'string') throw new Error('清单内容为空');
    const parsed = MpdKit.parseMpd(r.text, url);
    const video = parsed.representations.filter((x) => x.role === 'video' && x.segmentUrls.length);
    const audio = parsed.representations.filter((x) => x.role === 'audio' && x.segmentUrls.length);
    const bestAudio = audio.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0] || null;
    const info = { video, audio, bestAudio, duration: parsed.duration, isLive: parsed.isLive };
    dashReps.set(url, info);
    dashTried.add(url);
    return info;
  }

  /* 主动发现 DASH 轨道：读 .mpd 清单 → 解析出画面/声音两组 Representation。
     与 HLS 音频组同样的思路：把「最佳音频轨」作为一条独立条目补进列表，
     画面轨则放进「选择清晰度」面板里选。 */
  async function discoverDashTracks() {
    if (IS_DEMO || probing) return;
    const mpds = items.filter((it) => it.kind === 'dash' && !it.derived && !dashTried.has(it.url)).slice(0, 3);
    if (!mpds.length) return;
    mpds.forEach((it) => dashTried.add(it.url));

    let changed = false;
    for (const it of mpds) {
      try {
        const info = await fetchDash(it.url, it.ref);
        if (!info.video.length && !info.audio.length) continue;

        const bestAudio = info.bestAudio;
        if (bestAudio) {
          /* 音频轨本身是一串分片（不是单个文件），用 dashgroup 标记，
             下载时走「多分片拼接」链路而不是单文件下载。 */
          let item = derivedItems.find((x) => x.ref === it.url && x.source === 'dashgroup');
          if (!item) {
            item = {
              url: bestAudio.segmentUrls[0],
              kind: 'audio',
              ext: 'm4a',
              size: 0,
              time: Date.now(),
              ref: it.url,
              role: 'audio',
              source: 'dashgroup',
              derived: true,
              dashAudio: bestAudio,
              groupName: [bestAudio.lang, bestAudio.channels ? bestAudio.channels + 'ch' : '',
                bestAudio.sampleRate ? bestAudio.sampleRate + 'Hz' : ''].filter(Boolean).join(' · ')
            };
            derivedItems.push(item);
          } else {
            item.dashAudio = bestAudio;
            item.url = bestAudio.segmentUrls[0];
          }
        }
        changed = true;
      } catch (e) { /* 单条清单失败不影响其他 */ }
    }
    if (changed) renderAll();
  }

  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 2600);
  }

  /* ---------------- 诊断信息导出 ----------------
   * 把「这个页面到底嗅探到了什么」整理成一段纯文本，一键复制。
   * 遇到"扫不到 / 只有声音 / 时长不对"这类问题时，把它贴回来就能直接定位，
   * 不必再来回猜。 */
  function buildDiagnostics() {
    const lines = [];
    lines.push('视频嗅探下载器 · 诊断信息');
    lines.push('扩展版本: ' + (HAS_CHROME && chrome.runtime && chrome.runtime.getManifest
      ? (chrome.runtime.getManifest().version || '?') : '演示模式'));
    lines.push('页面: ' + (pageUrl || '(未知)'));
    lines.push('时间: ' + new Date().toLocaleString());
    lines.push('条目 ' + items.length + ' 个（当前筛选: ' + filter + '）');
    items.forEach((it, i) => {
      const info = roleInfoOf(it);
      lines.push((i + 1) + '. [' + it.kind + ']' + (it.ext ? '.' + it.ext : '') +
        ' source=' + (it.source || '?') +
        (it.size ? ' size=' + it.size : '') +
        (it.role ? ' role=' + it.role : '') +
        (it.slice ? ' slice=1' : '') +
        (it.derived ? ' derived=1' : ''));
      lines.push('    ' + it.url);
      if (info) {
        lines.push('    识别: ' + (info.ok
          ? ((info.role || '?') + ' / ' + (info.codec || '?') + ' / ' + (info.detail || ''))
          : ('失败 ' + (info.error || ''))));
      }
    });
    dashReps.forEach((v, k) => {
      lines.push('DASH 清单 ' + k + ' → 画面 ' + v.video.length + ' 轨 / 音频 ' + v.audio.length +
        ' 轨 / 声明时长 ' + v.duration + ' 秒 / live=' + (v.isLive ? 1 : 0));
      v.video.slice(0, 3).forEach((r) => lines.push('    画面轨 ' + (r.id || '') + ' ' + (r.bandwidth || 0) +
        'bps ' + (r.width || 0) + 'x' + (r.height || 0) + ' 分片 ' + (r.segmentUrls || []).length));
      v.audio.slice(0, 3).forEach((r) => lines.push('    音频轨 ' + (r.id || '') + ' ' + (r.bandwidth || 0) +
        'bps ' + (r.sampleRate || 0) + 'Hz ' + (r.channels || 0) + 'ch 分片 ' + (r.segmentUrls || []).length));
    });
    hlsAudioGroups.forEach((v, k) => {
      lines.push('HLS 音频组 ' + k + ' → ' + v.map((x) => x.url).join(' , '));
    });
    lines.push('候选（尚未定性）' + candUrls.length + ' 个:');
    candUrls.forEach((u) => lines.push('    ' + u));
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    return new Promise((resolve) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        resolve(!!ok);
      } catch (e) { resolve(false); }
    });
  }

  /* ---------------- 数据加载 ---------------- */

  async function loadSettings() {
    if (!IS_DEMO) {
      try {
        const got = await chrome.storage.local.get('settings');
        settings = Object.assign({}, DEFAULTS, got.settings || {});
      } catch (e) { /* ignore */ }
    }
    $('#setFolder').value = settings.folder || '';
    $('#setFormat').value = settings.format || 'auto';
    $('#setConcurrency').value = String(settings.concurrency || 6);
  }

  async function saveSettings() {
    settings.folder = $('#setFolder').value.trim().replace(/[/\\]+$/, '');
    settings.format = $('#setFormat').value;
    settings.concurrency = parseInt($('#setConcurrency').value, 10) || 6;
    if (IS_DEMO) return;
    await chrome.storage.local.set({ settings });
  }

  async function loadMedia() {
    if (IS_DEMO) {
      items = (DEMO_SCENES[DEMO_SCENE] || DEMO_ITEMS).slice();
      pageUrl = DEMO_PAGE_URL;
      probeMap = new Map(Object.entries(DEMO_HEADS));
      candUrls = [];
      derivedItems = [];
      hlsAudioGroups.clear();
      dashReps.clear();
      /* 演示场景里若含 .mpd，就用真解析器解一遍，界面显示与真实运行时一致 */
      const demoMpd = items.find((it) => it.kind === 'dash');
      if (demoMpd && typeof MpdKit !== 'undefined') {
        try {
          const parsed = MpdKit.parseMpd(DEMO_MPD, demoMpd.url);
          const video = parsed.representations.filter((x) => x.role === 'video' && x.segmentUrls.length);
          const audio = parsed.representations.filter((x) => x.role === 'audio' && x.segmentUrls.length);
          dashReps.set(demoMpd.url, {
            video, audio, bestAudio: audio[0] || null,
            duration: parsed.duration, isLive: parsed.isLive
          });
        } catch (e) { /* 演示数据异常不影响其他 */ }
      }
      return;
    }
    if (!currentTab || currentTab.id < 0) { items = []; candUrls = []; derivedItems = []; pageUrl = ''; return; }
    try {
      const r = await bg({ type: 'GET_TAB_MEDIA', tabId: currentTab.id });
      const all = (r && r.items) || [];
      /* 候选条目先不进列表：等按内容签名定性后再显示，避免列表里出现一堆"待识别" */
      const base = all.filter((it) => it.kind !== 'cand');
      candUrls = all.filter((it) => it.kind === 'cand').map((it) => it.url);
      const nowUrl = (r && r.pageUrl) || '';

      /* 换页了：探测结果与推导出来的音频轨都属于上一页，必须清掉 */
      if (nowUrl !== lastPageUrl) {
        lastPageUrl = nowUrl;
        derivedItems = [];
        hlsAudioGroups.clear();
        hlsGroupTried.clear();
        dashReps.clear();
        dashTried.clear();
        candTried.clear();
        probeMap = new Map();
      }
      pageUrl = nowUrl;

      /* 推导条目只保留「主清单仍在列表里」的那些，并排在最后 */
      const masters = new Set(base.map((b) => b.url));
      derivedItems = derivedItems.filter((d) => masters.has(d.ref));
      items = base.concat(derivedItems);
    } catch (e) { items = []; candUrls = []; }
  }

  /* 重新抓取列表 → 渲染 → 异步识别轨道类型（识别完成后会自行再渲染一次） */
  async function refreshMedia() {
    await loadMedia();
    renderAll();
    await probeHeads();
    await discoverHlsAudioGroups();
    await discoverDashTracks();
  }

  async function loadTasks() {
    if (IS_DEMO) {
      tasks = (DEMO_TAB === 'tasks' || QS.get('tasks') === '1') ? DEMO_TASKS.slice() : [];
      return;
    }
    try {
      const r = await bg({ type: 'GET_TASKS' });
      tasks = (r && r.tasks) || [];
    } catch (e) { tasks = []; }
    announceFinished(tasks);
  }

  /* ---------------- 渲染 ---------------- */

  function filteredItems() {
    return items.filter((it) => {
      switch (filter) {
        case 'all': return !isSeg(it);
        case 'hls': return it.kind === 'hls';
        case 'file': return ['mp4', 'webm', 'flv', 'mkv', 'mov', 'avi', 'video', 'dash', 'audio'].indexOf(it.kind) >= 0;
        case 'seg': return isSeg(it);
        case 'dom': return it.source === 'dom' && it.kind !== 'blob';
        default: return true;
      }
    });
  }

  function renderChips() {
    const count = (fn) => items.filter(fn).length;
    $('#cAll').textContent = count((it) => !isSeg(it));
    $('#cHls').textContent = count((it) => it.kind === 'hls');
    $('#cFile').textContent = count((it) => ['mp4', 'webm', 'flv', 'mkv', 'mov', 'avi', 'video', 'dash', 'audio'].indexOf(it.kind) >= 0);
    $('#cSeg').textContent = count(isSeg);
    $('#cDom').textContent = count((it) => it.source === 'dom' && it.kind !== 'blob');
  }

  function renderList() {
    renderChips();
    const list = $('#list');
    const arr = filteredItems();
    const groups = buildGroups();

    if (!arr.length) {
      list.innerHTML = '<div class="empty">' +
        (items.length ? '当前筛选下没有资源，试试切换上方分类。' :
          '暂未嗅探到视频资源。<br>请播放页面中的视频后稍等片刻，<br>或点击右上角 ⟳ 重新扫描。<br><br>' +
          '提示：浏览器内置页面 / 扩展商店页面无法嗅探。') +
        '</div>';
      return;
    }

    list.innerHTML = arr.map((it) => {
      let [label, cls] = badgeOf(it);
      const name = it.kind === 'blob' ? '（Blob/MSE 播放源，请下载网络列表中的流地址）' : nameFromUrl(it.url);
      const subs = [];
      if (it.kind !== 'blob') subs.push(esc(hostOf(it.url)));
      if (it.size) subs.push(fmtBytes(it.size));
      subs.push(fmtTime(it.time));
      if (it.source === 'dom') subs.push('页面元素');
      else subs.push('网络请求');
      const subTitle = it.time ? ('嗅探于 ' + exactTime(it.time)) : '';

      const isHlsGroup = !!(it.derived && it.role === 'audio' && it.source === 'hlsgroup'); // 主清单 #EXT-X-MEDIA 推导出的独立音频轨
      const isDashGroup = !!(it.derived && it.source === 'dashgroup');   // .mpd 里推导出的独立音频轨
      const isHls = it.kind === 'hls' && !isHlsGroup;
      const isDash = it.kind === 'dash';
      const isBlob = it.kind === 'blob';
      const isFmp4 = it.kind === 'fmp4';

      /* ---- 轨道识别（DASH 音视频分离场景） ---- */
      const info = isTrackLike(it) ? roleInfoOf(it) : null;
      const group = isTrackLike(it) ? (groups.get(groupKeyOf(it.url)) || null) : null;
      let mergeAudioUrl = '';
      let noteHtml = '';

      if (info && info.ok) {
        if (info.role === 'video') label = (isFmp4 ? 'M4S·视频' : '视频轨');
        else if (info.role === 'audio') label = (isFmp4 ? 'M4S·音频' : '音频轨');
        else if (info.role === 'both') label = (isFmp4 ? 'M4S' : 'MP4·完整');
        const detailBits = [];
        if (info.detail) detailBits.push(info.detail);
        if (info.codec) detailBits.push(info.codec);
        if (detailBits.length) subs.splice(1, 0, esc(detailBits.join(' ')));

        if (info.role === 'video') {
          /* 优先同组音频；分组失败时用跨组 1v1 兜底配对（抖音分离轨路径完全不同，分组永远配不上） */
          const audioItem = (group && group.bestAudio) || (group && group.crossAudio) || null;
          if (audioItem) {
            mergeAudioUrl = audioItem.url;
            noteHtml = '<div class="item-note ok">该视频的画面与声音是两条独立流，下载时会自动合并为一个文件</div>';
          } else {
            noteHtml = '<div class="item-note">未发现配套音频轨（可能是纯视频流，或音频尚未加载）</div>';
          }
        } else if (info.role === 'audio') {
          const videoItem = (group && group.bestVideo) || (group && group.crossVideo) || null;
          noteHtml = videoItem
            ? '<div class="item-note">这是视频轨的声音部分，已被自动合并，一般无需单独下载</div>'
            : '<div class="item-note ok">纯音频流，可直接下载</div>';
        } else if (info.role === 'both') {
          noteHtml = '<div class="item-note ok">完整文件，画面与声音都在这个文件里</div>';
        }
      } else if (isTrackLike(it) && probing && !info) {
        noteHtml = '<div class="item-note">正在识别轨道类型…</div>';
      }

      /* HLS 主清单声明了独立音频轨（#EXT-X-MEDIA:TYPE=AUDIO）：画面 variant 本身没有声音 */
      const hlsGroups = isHls ? (hlsAudioGroups.get(it.url) || []) : [];
      if (isHls && hlsGroups.length) {
        noteHtml = '<div class="item-note ok">画面与声音是分开的：声音在独立音频轨上，' +
          '点「选择清晰度」下载时会自动把两者合并</div>';
      }

      /* DASH(.mpd)：清单里 AdaptationSet 已标明画面组与声音组 */
      const dashInfo = isDash ? dashReps.get(it.url) : null;
      if (isDash && dashInfo) {
        const nv = dashInfo.video.length, na = dashInfo.audio.length;
        const bits = [];
        if (nv) bits.push(nv + ' 条画面轨');
        if (na) bits.push(na + ' 条音频轨');
        noteHtml = '<div class="item-note ' + (na ? 'ok' : '') + '">清单里有 ' + bits.join(' + ') +
          (na ? '，选择清晰度下载时会自动把声音合进去' : '（没有独立音频轨）') + '</div>';
      } else if (isDash && !dashTried.has(it.url)) {
        noteHtml = '<div class="item-note">正在解析清单…</div>';
      }

      let acts = '';
      const roleAudio = !!(info && info.ok && info.role === 'audio');
      if (isHlsGroup) {
        label = '音频轨';
        cls = 'b-audio';
        noteHtml = '<div class="item-note ok">独立音频轨（来自 HLS 主清单的 #EXT-X-MEDIA），可直接下载；' +
          '或回到画面那条用「选择清晰度」下载含声音的完整视频</div>';
        acts += '<button class="mini-btn primary" data-act="dl">单独下载</button>';
      } else if (isDashGroup) {
        label = '音频轨';
        cls = 'b-audio';
        const gn = it.groupName ? '（' + esc(it.groupName) + '）' : '';
        noteHtml = '<div class="item-note ok">独立音频轨' + gn + '（来自 .mpd 清单，共 ' +
          ((it.dashAudio && it.dashAudio.segmentUrls.length) || 0) + ' 个分片），可直接下载；' +
          '或回到清单那条用「选择清晰度」下载含声音的完整视频</div>';
        acts += '<button class="mini-btn primary" data-act="dashtrack">单独下载</button>';
      } else if (isHls) {
        acts += '<button class="mini-btn primary" data-act="hls">选择清晰度</button>';
      } else if (isDash) {
        acts += '<button class="mini-btn primary" data-act="hls">选择清晰度</button>';
      } else if (mergeAudioUrl) {
        acts += '<button class="mini-btn primary" data-act="merge" data-audio="' + esc(mergeAudioUrl) + '">下载（含声音）</button>';
        acts += '<button class="mini-btn" data-act="dl" title="只下载视频轨，不加声音">仅视频</button>';
      } else if (!isBlob) {
        acts += '<button class="mini-btn primary" data-act="dl">' + (roleAudio ? '单独下载' : '下载') + '</button>';
      }
      if (!isBlob) acts += '<button class="mini-btn" data-act="copy" title="复制链接">复制</button>';

      let variantsHtml = '';
      if (variantOpenUrl === it.url) {
        variantsHtml = renderVariantPanel(it);
      }

      return '<div class="item" data-url="' + esc(it.url) + '">' +
        '<span class="badge ' + cls + '">' + label + '</span>' +
        '<div class="item-main">' +
          '<div class="item-name" title="' + esc(it.url) + '">' + esc(name) + '</div>' +
          '<div class="item-sub"' + (subTitle ? ' title="' + esc(subTitle) + '"' : '') + '>' + subs.map((s, i) => i === 0 ? s : '<span class="dot"></span>' + s).join('') + '</div>' +
          noteHtml +
        '</div>' +
        '<div class="item-acts">' + acts + '</div>' +
      '</div>' + variantsHtml;
    }).join('');
  }

  function renderVariantPanel(item) {
    return '<div class="variants" data-variant-for="' + esc(item.url) + '">' +
      '<div class="variant-loading">正在获取清晰度列表…</div></div>';
  }

  /* 任务完成提示：只弹一次 toast，不进列表。
     下载记录本身仍写在 chrome.storage.session 里（测试与调试要读），
     但界面不再堆积历史条目 —— 用户明确不需要。 */
  const toastedTasks = new Set();
  function announceFinished(list) {
    if (IS_DEMO) return;
    for (const t of list || []) {
      if (!t || t.status === 'running' || toastedTasks.has(t.id)) continue;
      toastedTasks.add(t.id);
      if (t.status === 'done') {
        toast('下载完成：' + (t.name || 'video') + (t.sizeStr ? '（' + t.sizeStr + '）' : ''), 4000);
      } else if (t.status === 'error') {
        toast('下载失败：' + (t.name || 'video') + (t.error ? '（' + t.error + '）' : ''), 6000);
      }
    }
  }

  function renderTasks() {
    const sec = $('#tasksSection');
    /* 正常模式只显示「正在进行」的任务：做完的就从界面上消失，避免越积越多。
       演示模式保留完成态，商店截图要展示完整界面。 */
    const running = tasks.filter((t) => t.status === 'running');
    const recent = IS_DEMO ? tasks.filter((t) => t.status !== 'running').slice(0, 3) : [];
    const show = running.concat(recent);
    if (!show.length) { sec.hidden = true; return; }
    sec.hidden = false;

    $('#taskList').innerHTML = show.map((t) => {
      const pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : (t.status === 'done' ? 100 : 0);
      const cls = t.status === 'done' ? 'done' : (t.status === 'error' ? 'error' : '');
      let sub = '';
      if (t.status === 'running') {
        sub = '<span>' + esc(t.phase || '下载中') + (t.total ? ' ' + t.done + '/' + t.total : '') + '</span>' +
              '<span>' + fmtBytes(t.bytes) + (t.speed ? ' · ' + fmtBytes(t.speed) + '/s' : '') + '</span>';
      } else if (t.status === 'done') {
        sub = '<span>已完成 ' + esc(t.sizeStr || '') + '</span><span>' + fmtTime(t.startedAt) + '</span>';
      } else if (t.status === 'canceled') {
        sub = '<span>已取消</span><span></span>';
      } else {
        sub = '<span>失败</span><span></span>';
      }
      const err = t.status === 'error' && t.error ? '<div class="task-error">' + esc(t.error) + '</div>' : '';
      const note = t.note ? '<div class="task-note">' + esc(t.note) + '</div>' : '';
      const x = t.status === 'running' ? '<button class="task-x" data-cancel="' + esc(t.id) + '" title="取消">✕</button>' : '';
      return '<div class="task ' + cls + '">' +
        '<div class="task-top"><span class="task-name" title="' + esc(t.url) + '">' + esc(t.name) + '</span>' + x + '</div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="task-sub">' + sub + '</div>' + err + note +
      '</div>';
    }).join('');
  }

  function renderFoot() {
    const n = items.filter((it) => !isSeg(it)).length;
    $('#footHint').textContent = n ? ('共嗅探到 ' + n + ' 个可用资源') : '正在扫描…';
  }

  function renderAll() {
    renderList();
    renderTasks();
    renderFoot();
  }

  /* ---------------- 下载流程 ---------------- */

  function buildTitle() {
    let title = '';
    if (currentTab && currentTab.title) title = currentTab.title;
    title = sanitizeName(title || '');
    if (/^(chrome|edge|about|extension)/i.test(title)) title = '';
    return title || 'video';
  }

  async function onHlsClick(item, rowEl) {
    variantOpenUrl = item.url;
    renderList();
    const panel = document.querySelector('.variants[data-variant-for="' + CSS.escape(item.url) + '"]');

    if (IS_DEMO) {
      if (!panel) return;
      panel.innerHTML = '<div class="variant-hint">选择要下载的清晰度（按码率降序）</div>' +
        DEMO_VARIANTS.map((v, idx) => '<div class="variant-row" data-vidx="' + idx + '">' +
          '<span class="v-res">' + esc(v.res) + (idx === 0 ? ' · 最高' : '') + '</span>' +
          '<span class="v-meta">' + esc(v.bw) + ' · ' + esc(v.codecs.split(',')[0]) + '</span>' +
        '</div>').join('');
      return;
    }

    try {
      const r = await bg({ type: 'FETCH_TEXT', url: item.url, pageUrl: pageUrl || (item.ref || '') });
      if (r && r.error) throw new Error(r.error);
      const parsed = HLSKit.parsePlaylist(r.text, item.url);
      if (!panel) return;

      if (parsed.kind === 'master') {
        const variants = parsed.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth);
        /* 该主清单是否把声音拆成了独立音频组（#EXT-X-MEDIA:TYPE=AUDIO）。
           有的话，画面 variant 里是没有声音的，下载必须连音频组一起取。 */
        const groups = (parsed.audioGroups && parsed.audioGroups.length)
          ? parsed.audioGroups.map((g) => ({ uri: g.uri }))
          : (hlsAudioGroups.get(item.url) || []).map((x) => ({ uri: x.url }));
        const aud = groups[0] || null;
        const hint = aud
          ? '选择要下载的清晰度（按码率降序）· 声音在独立音频轨上，下载时会自动合并'
          : '选择要下载的清晰度（按码率降序）';
        panel.innerHTML = '<div class="variant-hint">' + esc(hint) + '</div>' +
          variants.map((v, idx) => {
            const res = v.resolution ? v.resolution.replace(/x(\d+)/, (m, h) => 'x' + h + '（' + h + 'P）') : (v.audioOnly ? '音频轨' : '未知分辨率');
            const bw = v.bandwidth ? (v.bandwidth / 1e6).toFixed(2) + ' Mbps' : '';
            return '<div class="variant-row" data-vidx="' + idx + '">' +
              '<span class="v-res">' + esc(res) + (idx === 0 ? ' · 最高' : '') + '</span>' +
              '<span class="v-meta">' + esc(bw) + (v.codecs ? ' · ' + esc(v.codecs.split(',')[0]) : '') + '</span>' +
            '</div>';
          }).join('');
        panel.querySelectorAll('.variant-row').forEach((el) => {
          el.addEventListener('click', () => {
            const v = variants[parseInt(el.dataset.vidx, 10)];
            const label = v.resolution || (v.bandwidth ? Math.round(v.bandwidth / 1000) + 'kbps' : '');
            if (aud) startHlsMerged(item, v.url, aud.uri, label);
            else startHls(item, v.url, label);
          });
        });
      } else {
        const len = parsed.segments.length;
        const liveWarn = parsed.isLive ? '<div class="variant-hint">⚠ 检测到直播流，只能下载当前已缓存的片段</div>' : '';
        /* 清单声明的时长未必可信（站点写死值、单位搞错都会发生）。只展示落在合理区间内的值，
           离谱的直接不显示，而不是摆一个 9 小时的假数字让人以为视频真有那么长。 */
        const durTxt = saneDuration(parsed.totalDuration)
          ? ' · 约 ' + Math.round(parsed.totalDuration / 60) + ' 分钟'
          : '';
        panel.innerHTML = liveWarn +
          '<div class="variant-row" data-direct="1">' +
          '<span class="v-res">直接下载' + (parsed.isLive ? '（直播快照）' : '') + '</span>' +
          '<span class="v-meta">共 ' + len + ' 个分片' + durTxt + '</span>' +
        '</div>';
        panel.querySelector('[data-direct]').addEventListener('click', () => {
          if (parsed.isLive && saneDuration(parsed.totalDuration) &&
              !confirm('这是直播流，只能下载当前时刻已缓存的片段（约 ' + Math.round(parsed.totalDuration / 60) + ' 分钟）。继续下载？')) return;
          startHls(item, item.url, '');
        });
      }
    } catch (e) {
      if (panel) panel.innerHTML = '<div class="variant-loading" style="color:var(--danger)">加载失败：' + esc(e.message || e) + '</div>';
    }
  }

  /* ---------------- DASH(.mpd) ---------------- */

  /* 一条 Representation → 引擎侧认得的「取数规格」（init 段 + 一串分片） */
  function repSpec(rep) {
    return { parts: (rep.segmentUrls || []).slice(), initUrl: rep.initUrl || '' };
  }

  /* 点 .mpd 那条的「选择清晰度」：列出清单里的画面轨 */
  async function onDashClick(item) {
    variantOpenUrl = item.url;
    renderList();

    let info = dashReps.get(item.url) || null;
    if (!info && !IS_DEMO) {
      let panel0 = document.querySelector('.variants[data-variant-for="' + CSS.escape(item.url) + '"]');
      if (panel0) panel0.innerHTML = '<div class="variant-loading">正在解析 DASH 清单…</div>';
      try {
        info = await fetchDash(item.url, item.ref);
      } catch (e) {
        panel0 = document.querySelector('.variants[data-variant-for="' + CSS.escape(item.url) + '"]');
        if (panel0) panel0.innerHTML = '<div class="variant-loading" style="color:var(--danger)">清单解析失败：' + esc(e.message || e) + '</div>';
        return;
      }
      renderList();   /* 清单读到了，条目上的说明也一并刷新 */
    }

    const panel = document.querySelector('.variants[data-variant-for="' + CSS.escape(item.url) + '"]');
    if (!panel) return;

    if (info) { renderDashPanel(panel, item, info); return; }

    /* 演示模式下清单没能解出来时的静态兜底（仅用于商店截图） */
    panel.innerHTML = '<div class="variant-hint">选择要下载的清晰度（按分辨率降序）</div>' +
      DEMO_VARIANTS.map((v, idx) => '<div class="variant-row" data-vidx="' + idx + '">' +
        '<span class="v-res">' + esc(v.res) + (idx === 0 ? ' · 最高' : '') + '</span>' +
        '<span class="v-meta">' + esc(v.bw) + ' · ' + esc(v.codecs.split(',')[0]) + '</span>' +
      '</div>').join('');
  }

  function renderDashPanel(panel, item, info) {
    const variants = (info.video || []).slice().sort((a, b) =>
      (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));

    if (!variants.length) {
      panel.innerHTML = '<div class="variant-hint">这份清单里没有画面轨' +
        (info.bestAudio ? '（纯音频清单，可直接下载下方那条音频轨）' : '') + '</div>';
      return;
    }

    const liveWarn = info.isLive ? '<div class="variant-hint">⚠ 这是直播清单（dynamic），分片会持续增长，只能下载当前已列出的部分</div>' : '';
    const hint = info.bestAudio
      ? '选择要下载的清晰度（按分辨率降序）· 清单里的声音是独立音频轨，下载时会自动合并'
      : '选择要下载的清晰度（按分辨率降序）· 清单里没有独立音频轨';

    panel.innerHTML = liveWarn + '<div class="variant-hint">' + esc(hint) + '</div>' +
      variants.map((v, idx) => {
        const res = v.height
          ? v.height + 'P' + (v.width ? '（' + v.width + '×' + v.height + '）' : '')
          : (v.bandwidth ? Math.round(v.bandwidth / 1000) + ' kbps' : '未知清晰度');
        const meta = [MpdKit.describe(v), v.segmentUrls.length + ' 分片'].filter(Boolean).join(' · ');
        return '<div class="variant-row" data-vidx="' + idx + '">' +
          '<span class="v-res">' + esc(res) + (idx === 0 ? ' · 最高' : '') + '</span>' +
          '<span class="v-meta">' + esc(meta) + '</span>' +
        '</div>';
      }).join('');

    panel.querySelectorAll('.variant-row').forEach((el) => {
      el.addEventListener('click', () => {
        const v = variants[parseInt(el.dataset.vidx, 10)];
        const label = v.height ? v.height + 'P' : (v.bandwidth ? Math.round(v.bandwidth / 1000) + 'kbps' : '');
        if (info.bestAudio) startDashMerged(item, v, info.bestAudio, label);
        else startDashTrack(v, label, 'video', item);
      });
    });
  }

  /* DASH 的「含声音」下载：画面 Representation + 音频 Representation 各自是一串分片，
     交给引擎按序取回拼接成两条完整轨道后合并。 */
  async function startDashMerged(item, vRep, aRep, qualityLabel) {
    const title = buildTitle();
    const name = sanitizeName(title + (qualityLabel ? '_' + qualityLabel : ''));
    variantOpenUrl = null;
    renderList();
    if (IS_DEMO) { toast('已开始下载：' + name + '（DASH 音视频轨将自动合并）', 3400); return; }
    const r = await bg({
      type: 'START_MERGE',
      tabId: currentTab ? currentTab.id : -1,
      videoUrl: vRep.segmentUrls[0],
      audioUrl: aRep.segmentUrls[0],
      videoSpec: repSpec(vRep),
      audioSpec: repSpec(aRep),
      pageUrl: pageUrl || (item && item.ref) || '',
      name,
      folder: settings.folder || ''
    });
    if (r && r.error) { toast('启动合并下载失败：' + r.error); return; }
    toast('已开始下载：' + name + '（' + vRep.segmentUrls.length + ' 个画面分片 + ' +
      aRep.segmentUrls.length + ' 个声音分片，将自动合并）', 3800);
    await loadTasks();
    renderTasks();
  }

  /* 单独下载一条多分片轨（DASH 的音频轨 / 没有配套声音的画面轨） */
  async function startDashTrack(rep, qualityLabel, kindStr, item) {
    const title = buildTitle();
    const name = sanitizeName(title + (qualityLabel ? '_' + qualityLabel : ''));
    if (IS_DEMO) { toast('已开始下载：' + name, 3200); return; }
    const r = await bg({
      type: 'START_PARTS',
      tabId: currentTab ? currentTab.id : -1,
      parts: (rep.segmentUrls || []).slice(),
      initUrl: rep.initUrl || '',
      kind: kindStr || '',
      pageUrl: pageUrl || (item && item.ref) || '',
      name,
      folder: settings.folder || ''
    });
    if (r && r.error) { toast('启动下载失败：' + r.error); return; }
    toast('已开始下载：' + name + '（' + (rep.segmentUrls || []).length + ' 个分片）', 3400);
    await loadTasks();
    renderTasks();
  }

  async function startHls(item, url, qualityLabel) {
    const title = buildTitle();
    const name = sanitizeName(title + (qualityLabel ? '_' + qualityLabel : ''));
    variantOpenUrl = null;
    renderList();
    if (IS_DEMO) { toast('已开始下载：' + name + '（进度见上方任务区）', 3200); return; }
    const r = await bg({
      type: 'START_HLS',
      tabId: currentTab ? currentTab.id : -1,
      url,
      pageUrl: pageUrl || (item.ref || ''),
      name,
      folder: settings.folder || '',
      format: settings.format,
      concurrency: settings.concurrency
    });
    if (r && r.error) { toast('启动下载失败：' + r.error); return; }
    toast('已开始下载：' + name + '（进度见上方任务区）', 3200);
    await loadTasks();
    renderTasks();
  }

  async function onDirectDownload(item) {
    let base = nameFromUrl(item.url);
    if (!/\.[a-z0-9]{2,5}$/i.test(base) && item.ext) base += '.' + item.ext;
    const folder = settings.folder ? settings.folder + '/' : '';
    const filename = folder + sanitizeName(base) || undefined;
    if (IS_DEMO) { toast('已加入下载：' + filename + '（若被防盗链拦截将自动重试）', 3200); return; }
    const r = await bg({ type: 'DIRECT_DOWNLOAD', url: item.url, filename, pageUrl: pageUrl || (item.ref || '') });
    if (r && r.error) { toast('下载失败：' + r.error); return; }
    toast('已加入下载：' + filename + '（若被防盗链拦截将自动重试）', 3200);
  }

  /* DASH 音视频分离：把视频轨与配套音频轨一起下载并在本地合并为一个 MP4 */
  async function onMergeDownload(videoItem, audioUrl) {
    const title = buildTitle();
    const name = sanitizeName(title);
    if (IS_DEMO) { toast('已开始下载：' + name + '（将自动合并视频轨与音频轨）', 3400); return; }
    const r = await bg({
      type: 'START_MERGE',
      tabId: currentTab ? currentTab.id : -1,
      videoUrl: videoItem.url,
      audioUrl,
      pageUrl: pageUrl || videoItem.ref || '',
      name,
      folder: settings.folder || ''
    });
    if (r && r.error) { toast('启动合并下载失败：' + r.error); return; }
    toast('已开始下载：' + name + '（自动合并视频轨与音频轨）', 3600);
    await loadTasks();
    renderTasks();
  }

  /* HLS 的「含声音」下载：画面 variant 与独立音频组一起取，在引擎里各自展开成
     一条完整轨道后再合并。两条都是清单（不是一个文件），由引擎的 fetchTrack 统一处理。 */
  async function startHlsMerged(item, videoUrl, audioUrl, qualityLabel) {
    const title = buildTitle();
    const name = sanitizeName(title + (qualityLabel ? '_' + qualityLabel : ''));
    variantOpenUrl = null;
    renderList();
    if (IS_DEMO) { toast('已开始下载：' + name + '（视频与独立音频轨将自动合并）', 3400); return; }
    const r = await bg({
      type: 'START_MERGE',
      tabId: currentTab ? currentTab.id : -1,
      videoUrl,
      audioUrl,
      pageUrl: pageUrl || (item.ref || ''),
      name,
      folder: settings.folder || ''
    });
    if (r && r.error) { toast('启动合并下载失败：' + r.error); return; }
    toast('已开始下载：' + name + '（视频与独立音频轨自动合并）', 3600);
    await loadTasks();
    renderTasks();
  }

  async function onCopy(url) {
    try {
      await navigator.clipboard.writeText(url);
      toast('已复制链接');
    } catch (e) {
      toast('复制失败，请手动复制');
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    $('#chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      filter = chip.dataset.filter;
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderList();
    });

    $('#list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.item');
      if (!row) return;
      const url = row.dataset.url;
      const item = items.find((it) => it.url === url);
      if (!item) return;

      const act = btn.dataset.act;
      if (act === 'hls') { if (item.kind === 'dash') onDashClick(item); else onHlsClick(item, row); }
      else if (act === 'dashtrack') startDashTrack(item.dashAudio || {}, '', 'audio', item);
      else if (act === 'merge') onMergeDownload(item, btn.dataset.audio);
      else if (act === 'dl') onDirectDownload(item);
      else if (act === 'copy') onCopy(item.url);
      else if (act === 'dashinfo') toast('DASH(.mpd) 清单暂不直接解析；若列表里已抓到 m4s 音视频轨，下载时会自动合并成一个 MP4', 4200);
    });

    $('#taskList').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      await bg({ type: 'CANCEL_TASK', taskId: btn.dataset.cancel });
      await loadTasks();
      renderTasks();
    });

    $('#btnRescan').addEventListener('click', async () => {
      if (IS_DEMO) { toast('已重新扫描'); return; }
      if (currentTab && currentTab.id >= 0) {
        /* force：连性能时间线里"已经报过"的条目也重新报一次，否则清空列表后刷不回来 */
        try { await chrome.tabs.sendMessage(currentTab.id, { type: 'DOM_SCAN', force: true }); } catch (e) { /* 部分页面无内容脚本 */ }
      }
      await loadMedia();
      renderAll();
      toast('已重新扫描');
      probeHeads();
    });

    $('#btnClear').addEventListener('click', async () => {
      if (IS_DEMO) { toast('已清空当前列表'); return; }
      if (currentTab && currentTab.id >= 0) await bg({ type: 'CLEAR_TAB', tabId: currentTab.id });
      variantOpenUrl = null;
      probeMap = new Map();
      candTried.clear();
      await loadMedia();
      renderAll();
    });

    $('#btnSettings').addEventListener('click', () => {
      const p = $('#settingsPanel');
      p.hidden = !p.hidden;
    });

    ['#setFolder', '#setFormat', '#setConcurrency'].forEach((sel) => {
      $(sel).addEventListener('change', saveSettings);
    });

    /* 使用授权声明（下载内容权利提示） */
    const policy = $('#usagePolicy');
    if (policy) {
      policy.addEventListener('click', (e) => {
        e.preventDefault();
        if (IS_DEMO || !HAS_CHROME) { toast('请仅下载您有权保存的内容'); return; }
        try { chrome.tabs.create({ url: chrome.runtime.getURL('policy.html') }); } catch (err) { /* ignore */ }
      });
    }

    /* 复制诊断信息：把当前页面嗅探到的全部条目与识别结果导出成文本 */
    const diag = $('#diagLink');
    if (diag) {
      diag.addEventListener('click', async (e) => {
        e.preventDefault();
        const text = buildDiagnostics();
        const ok = await copyText(text);
        toast(ok ? '诊断信息已复制，直接粘贴给我即可' : '复制失败，请手动查看控制台', 3600);
        if (!ok) console.log(text);
      });
    }

    /* 演示模式下阻止 iframe/预览中的真实跳转 */
    if (IS_DEMO) {
      document.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (a) e.preventDefault();
      });
    }
  }

  /* ---------------- 后台消息订阅 ---------------- */

  if (!IS_DEMO && HAS_CHROME && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.target !== 'popup') return;
      if (msg.type === 'MEDIA_UPDATED' && currentTab && msg.tabId === currentTab.id) {
        loadMedia().then(() => { renderList(); renderFoot(); probeHeads(); });
      } else if (msg.type === 'TASKS_UPDATED') {
        loadTasks().then(renderTasks);
      }
    });
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    await loadSettings();
    bindEvents();

    if (IS_DEMO) {
      currentTab = { id: -1, title: '示例视频 · 4K 纪录片 第 1 集' };
      if (['all', 'hls', 'file', 'seg', 'dom'].indexOf(DEMO_TAB) >= 0) filter = DEMO_TAB;
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tabs && tabs[0];
    }

    await loadMedia();
    await loadTasks();

    if (IS_DEMO) {
      if (DEMO_TAB === 'settings') $('#settingsPanel').hidden = false;
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === filter));
    }

    renderAll();
    /* 识别 .m4s 条目的轨道类型（视频轨/音频轨），用于提示并支持音视频合并下载 */
    if (!IS_DEMO) probeHeads();

    if (IS_DEMO) {
      if (DEMO_VARIANT) {
        const firstHls = items.find((it) => it.kind === 'hls');
        if (firstHls) await onHlsClick(firstHls);
      }
      if (DEMO_DASH) {
        const mpd = items.find((it) => it.kind === 'dash');
        if (mpd) await onDashClick(mpd);
      }
    } else if (currentTab && currentTab.id >= 0) {
      /* 打开 popup 时顺带触发一次页面 DOM 扫描 */
      try { await chrome.tabs.sendMessage(currentTab.id, { type: 'DOM_SCAN' }); } catch (e) { /* ignore */ }
    }

    /* 供自动化测试判断页面就绪：演示模式与真实模式都要置位 */
    document.body.dataset.ready = '1';
    window.__POP_READY = true;
  }

  /* 供自动化测试读取内部纯逻辑（只读，不影响运行时行为） */
  window.__POP_TEST__ = {
    groupKeyOf, qualityTagOf, splitExt, scoreOfTrack, buildGroups, isSeg,
    roleInfoOf, roleOf, isTrackLike, identityOf, repSpec,
    fmtTime, exactTime, saneDuration, buildDiagnostics,
    /* 测试缝：直接灌一批任务并重渲染，用来验证"界面只显示进行中的任务" */
    setTasks: (list) => { tasks = list || []; renderTasks(); return tasks.length; },
    getItems: () => items,
    getTasks: () => tasks,
    getProbeMap: () => probeMap,
    getMediaRole: () => (typeof MediaRole !== 'undefined' ? MediaRole : null),
    getMpdKit: () => (typeof MpdKit !== 'undefined' ? MpdKit : null),
    getDashReps: () => dashReps
  };

  init();
})();
