/* ============================================================
 * 视频嗅探下载器 - DASH(.mpd) 清单解析
 * 纯逻辑模块，不依赖任何 Chrome API 与 DOM：
 *   - 在 Service Worker / offscreen 文档 / popup 中运行
 *   - 在 Node 中运行（单元测试）
 * 挂载为全局：MpdKit
 *
 * 【为什么需要它】
 * DASH 站点把画面与声音拆成两条独立的 Representation（音视频分离的第三种形态，
 * 前两种是 fMP4 的 .m4s 与无后缀的抖音式分离轨）。清单本身是 XML，扩展过去
 * 只把它当成一个「DASH 类型」的条目记下来，里面的轨道信息一个字都没读 ——
 * 结果只能等浏览器把分片都请求一遍才可能凑出两条轨，而且认不出谁是谁。
 *
 * 这里把清单读透：AdaptationSet 的 contentType 直接告诉我们哪组是画面、哪组是
 * 声音（不用猜路径），Representation 给出清晰度/码率/编解码，BaseURL 与
 * SegmentTemplate / SegmentList / SegmentBase 给出实际要下载的地址。
 *
 * 不依赖 DOMParser：MPD 的结构非常简单（元素 + 属性 + 文本），自己扫一遍即可，
 * 这样同一份代码在 Node 单测里也能跑，不必注入假的 DOM。
 * ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- 极简 XML 扫描 ---------------- */

  function parseAttrs(s) {
    const out = {};
    const re = /([A-Za-z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s || ''))) out[m[1]] = m[2] != null ? m[2] : m[3];
    return out;
  }

  /* 把 XML 扫成一棵树 { tag, attrs, children, text }。
     只处理元素、属性、文本与 CDATA —— MPD 用不到注释以外的复杂语法。 */
  function parseXml(text) {
    const rootEl = { tag: '#root', attrs: {}, children: [], text: '' };
    const stack = [rootEl];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z0-9_:.-]+)\s*>|<([A-Za-z0-9_:.-]+)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
    let m;
    let last = 0;
    while ((m = re.exec(text))) {
      const between = text.slice(last, m.index);
      if (between.trim()) stack[stack.length - 1].text += between;
      last = re.lastIndex;

      if (m[1] != null) { stack[stack.length - 1].text += m[1]; continue; }   // CDATA
      if (m[2]) {                                                             // 闭合标签
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === m[2]) { stack.length = i; break; }
        }
        continue;
      }
      if (m[3]) {                                                             // 开标签
        const el = { tag: m[3], attrs: parseAttrs(m[4] || ''), children: [], text: '' };
        stack[stack.length - 1].children.push(el);
        if (!m[5]) stack.push(el);
      }
    }
    return rootEl;
  }

  /* ---------------- 基础工具 ---------------- */

  function resolveUrl(uri, base) {
    if (!uri) return '';
    try { return new URL(uri, base).href; } catch (e) { return uri; }
  }

  /* ISO 8601 时长（PT1H2M3.5S）→ 秒 */
  function parseDuration(s) {
    if (!s) return 0;
    const m = /^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
      .exec(String(s).trim());
    if (!m) return 0;
    return (+(m[1] || 0)) * 31536000 + (+(m[2] || 0)) * 2592000 + (+(m[3] || 0)) * 604800 +
      (+(m[4] || 0)) * 86400 + (+(m[5] || 0)) * 3600 + (+(m[6] || 0)) * 60 + (+(m[7] || 0));
  }

  /* DASH 的 URL 模板：$RepresentationID$ / $Bandwidth$ / $Number$ / $Time$，
     以及 $Number%05d$ 这种补零写法；$$ 是转义的字面量 $ */
  function fillTemplate(tpl, vars) {
    if (!tpl) return '';
    return String(tpl).replace(/\$\$|\$([A-Za-z]+)(?:%0(\d+)d)?\$/g, (whole, name, pad) => {
      if (whole === '$$') return '$';
      let v = vars[name];
      if (v == null) v = vars[name.charAt(0).toUpperCase() + name.slice(1)];
      if (v == null || v === '') return '';
      if (pad) {
        const w = parseInt(pad, 10);
        let s = String(v);
        while (s.length < w) s = '0' + s;
        return s;
      }
      return String(v);
    });
  }

  function childrenOf(el, tag) {
    return (el && el.children ? el.children : []).filter((c) => c.tag === tag);
  }
  function childOf(el, tag) {
    return childrenOf(el, tag)[0] || null;
  }

  /* 顺着元素链找 BaseURL：MPD > Period > AdaptationSet > Representation，
     逐级拼接（子级的相对地址是相对父级 BaseURL 的）。 */
  function baseUrlOf(el, inherited) {
    const b = childOf(el, 'BaseURL');
    const raw = b && b.text ? b.text.trim() : '';
    return raw ? resolveUrl(raw, inherited) : inherited;
  }

  /* ---------------- 分片枚举 ---------------- */

  /* SegmentTimeline → 每段的起始时间列表 */
  function timelineStarts(tl) {
    const out = [];
    let t = 0;
    for (const s of childrenOf(tl, 'S')) {
      const d = parseInt(s.attrs.d, 10) || 0;
      const r = parseInt(s.attrs.r, 10);
      const start = s.attrs.t != null ? parseInt(s.attrs.t, 10) : t;
      const repeat = isNaN(r) ? 0 : r;
      let cur = start;
      for (let i = 0; i <= repeat; i++) {
        out.push(cur);
        cur += d;
      }
      t = cur;
      /* 最后一段的 d 有时省略（用后一段的 t 推），这里给个兜底避免 0 长度死循环 */
      if (!d) break;
    }
    return out;
  }

  /* 从一个 SegmentTemplate/SegmentList 所在的层级，枚举出这条 Representation 的
     「初始化段 + 全部分片 URL」。返回 { initUrl, segmentUrls, note }
     inheritedSeg：父级（AdaptationSet / Period）上的 SegmentTemplate/SegmentList ——
     真实站点最常见的写法就是把模板写在 AdaptationSet 上、Representation 只写
     id/分辨率/码率，所以必须支持从父级继承。 */
  function enumerateSegments(rep, inheritedBase, periodDuration, inheritedSeg) {
    /* rep 是 XML 元素，属性在 attrs 上 —— 别写成 rep.id */
    const vars = {
      RepresentationID: (rep.attrs && rep.attrs.id) || '',
      Bandwidth: parseInt(rep.attrs && rep.attrs.bandwidth, 10) || 0,
      Number: 0,
      Time: 0
    };
    const ownBase = baseUrlOf(rep, inheritedBase);

    /* 先在 Representation 上找，找不到再继承父级 */
    const list = childOf(rep, 'SegmentList') || (inheritedSeg && inheritedSeg.list) || null;
    const tmpl = childOf(rep, 'SegmentTemplate') || (inheritedSeg && inheritedSeg.template) || null;

    /* ① 单文件形态：整个 Representation 就是一个文件（配 SegmentBase 索引字节范围） */
    const repBase = childOf(rep, 'BaseURL');
    const hasSegInfo = tmpl || list || childOf(rep, 'SegmentBase');
    if (repBase && !hasSegInfo) {
      return { initUrl: '', segmentUrls: [ownBase], single: true, note: '单文件' };
    }

    /* ② SegmentList：分片地址逐个列出 */
    if (list) {
      const init = childOf(list, 'Initialization');
      const initUrl = init && init.attrs.sourceURL
        ? resolveUrl(fillTemplate(init.attrs.sourceURL, vars), ownBase) : '';
      const segs = childrenOf(list, 'SegmentURL')
        .map((s) => s.attrs.media ? resolveUrl(fillTemplate(s.attrs.media, vars), ownBase) : '')
        .filter(Boolean);
      if (segs.length) return { initUrl, segmentUrls: segs, note: 'SegmentList' };
    }

    /* ③ SegmentTemplate：按 SegmentTimeline 或 duration/timescale 推算出全部分片 */
    if (tmpl) {
      const a = tmpl.attrs;
      const initUrl = a.initialization
        ? resolveUrl(fillTemplate(a.initialization, vars), ownBase) : '';
      const mediaTpl = a.media || '';
      if (!mediaTpl) return { initUrl, segmentUrls: [], note: 'SegmentTemplate（没有 media 模板）' };

      const tl = childOf(tmpl, 'SegmentTimeline');
      const startNumber = parseInt(a.startNumber, 10) || 1;
      const segs = [];

      if (tl) {
        const starts = timelineStarts(tl);
        for (const t of starts) {
          vars.Number = startNumber + segs.length;
          vars.Time = t;
          segs.push(resolveUrl(fillTemplate(mediaTpl, vars), ownBase));
        }
      } else {
        const dur = parseInt(a.duration, 10) || 0;
        const ts = parseInt(a.timescale, 10) || 1;
        const total = periodDuration || 0;
        if (dur > 0 && total > 0) {
          const count = Math.ceil(total / (dur / ts));
          for (let i = 0; i < count; i++) {
            vars.Number = startNumber + i;
            vars.Time = 0;
            segs.push(resolveUrl(fillTemplate(mediaTpl, vars), ownBase));
          }
        }
      }
      if (segs.length) {
        return { initUrl, segmentUrls: segs, note: 'SegmentTemplate（' + segs.length + ' 段）' };
      }
      return { initUrl, segmentUrls: [], note: 'SegmentTemplate（无法推算分片数量）' };
    }

    /* ④ 什么都没有：整个 BaseURL 当作一个文件 */
    if (ownBase && ownBase !== inheritedBase) {
      return { initUrl: '', segmentUrls: [ownBase], single: true, note: '单文件' };
    }
    return { initUrl: '', segmentUrls: [], note: '未找到可下载的分片信息' };
  }

  /* ---------------- 主入口 ---------------- */

  /*
   * 解析 MPD 清单。
   * 返回 {
   *   duration, isLive,
   *   representations: [{
   *     role: 'video' | 'audio' | '',  // 由 AdaptationSet 的 contentType/mimeType 直接给出
   *     id, bandwidth, codecs, width, height, channels, sampleRate,
   *     initUrl, segmentUrls: [], single, note, lang
   *   }]
   * }
   */
  function parseMpd(xmlText, mpdUrl) {
    if (typeof xmlText !== 'string' || !xmlText) throw new Error('MPD 内容为空');
    const doc = parseXml(xmlText.replace(/^\uFEFF/, ''));
    const mpd = doc.children.find((e) => e.tag === 'MPD');
    if (!mpd) throw new Error('不是有效的 DASH 清单（缺少 MPD 元素）');

    const mpdBase = baseUrlOf(mpd, mpdUrl);
    const totalDuration = parseDuration(mpd.attrs.mediaPresentationDuration) ||
      parseDuration(mpd.attrs.maximumSuggestedPresentationDuration) || 0;
    const type = (mpd.attrs.type || '').toLowerCase();
    const isLive = type === 'dynamic' || /dynamic/.test(type);

    const out = [];
    const periods = childrenOf(mpd, 'Period');
    /* 没有 Period 元素时按「隐式 Period」处理 —— 此时 AdaptationSet 直接挂在 MPD 下，
       所以伪造的 Period 要把它自己的孩子带过来，否则里面什么都扫不到 */
    const periodList = periods.length ? periods
      : [{ tag: 'Period', attrs: {}, children: childrenOf(mpd, 'AdaptationSet'), text: '' }];

    for (const period of periodList) {
      const pBase = baseUrlOf(period, mpdBase);
      const pDur = parseDuration(period.attrs.duration) || totalDuration;
      /* Period 级模板（少见但合法），作为 AdaptationSet 级继承的兜底 */
      const periodSeg = {
        template: childOf(period, 'SegmentTemplate'),
        list: childOf(period, 'SegmentList')
      };

      for (const as of childrenOf(period, 'AdaptationSet')) {
        const asBase = baseUrlOf(as, pBase);
        const asMime = (as.attrs.mimeType || '').toLowerCase();
        /* AdaptationSet 级模板：真实站点最常用的写法，Representation 只写 id/分辨率 */
        const asSeg = {
          template: childOf(as, 'SegmentTemplate') || periodSeg.template,
          list: childOf(as, 'SegmentList') || periodSeg.list
        };
        let asType = (as.attrs.contentType || '').toLowerCase();
        if (!asType && asMime) asType = asMime.split('/')[0];
        if (!asType) {
          /* 没写 contentType 的少见情况：看有没有音频专属属性来推断 */
          asType = (as.attrs.audioSamplingRate || childOf(as, 'AudioChannelConfiguration')) ? 'audio' : 'video';
        }
        const role = asType === 'audio' ? 'audio' : (asType === 'video' ? 'video' : '');

        for (const rep of childrenOf(as, 'Representation')) {
          const mime = (rep.attrs.mimeType || asMime || '').toLowerCase();
          const repType = (rep.attrs.contentType || '').toLowerCase() ||
            (mime ? mime.split('/')[0] : '') || asType;
          const repRole = repType === 'audio' ? 'audio' : (repType === 'video' ? 'video' : role);

          const item = {
            role: repRole,
            id: rep.attrs.id || '',
            bandwidth: parseInt(rep.attrs.bandwidth, 10) || parseInt(as.attrs.bandwidth, 10) || 0,
            codecs: rep.attrs.codecs || as.attrs.codecs || '',
            width: parseInt(rep.attrs.width, 10) || parseInt(as.attrs.width, 10) || 0,
            height: parseInt(rep.attrs.height, 10) || parseInt(as.attrs.height, 10) || 0,
            channels: 0,
            sampleRate: parseInt(rep.attrs.audioSamplingRate, 10) || parseInt(as.attrs.audioSamplingRate, 10) || 0,
            lang: as.attrs.lang || '',
            mime: mime,
            initUrl: '',
            segmentUrls: [],
            single: false,
            note: ''
          };

          const acc = childOf(rep, 'AudioChannelConfiguration') || childOf(as, 'AudioChannelConfiguration');
          if (acc && acc.attrs.value) item.channels = parseInt(acc.attrs.value, 10) || 0;

          const seg = enumerateSegments(rep, asBase, pDur, asSeg);
          item.initUrl = seg.initUrl;
          item.segmentUrls = seg.segmentUrls;
          item.single = !!seg.single;
          item.note = seg.note;
          out.push(item);
        }
      }
    }

    return { duration: totalDuration, isLive, representations: out, baseUrl: mpdBase };
  }

  /* 摘要：给界面用的一句话描述 */
  function describe(rep) {
    const bits = [];
    if (rep.role === 'video' && rep.width && rep.height) bits.push(rep.width + '×' + rep.height);
    if (rep.role === 'audio' && rep.channels) bits.push(rep.channels + 'ch');
    if (rep.role === 'audio' && rep.sampleRate) bits.push(rep.sampleRate + 'Hz');
    if (rep.codecs) bits.push(String(rep.codecs).split('.')[0]);
    if (rep.bandwidth) bits.push((rep.bandwidth / 1e6).toFixed(2) + ' Mbps');
    return bits.join(' · ');
  }

  root.MpdKit = {
    parseMpd,
    parseXml,
    parseAttrs,
    parseDuration,
    fillTemplate,
    enumerateSegments,
    timelineStarts,
    describe
  };
})(typeof self !== 'undefined' ? self : globalThis);
