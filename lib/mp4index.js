/* ============================================================
 * 视频嗅探下载器 - MP4 索引重建（fMP4 → 标准 MP4）
 *
 * 背景：很多站点（B站、抖音、以及所有用 DASH / HLS-fMP4 的站点）分发的
 *       就是「碎片化 MP4（fMP4）」：moov 里只有轨道描述，逐帧信息散落在
 *       每个 moof/traf/trun 中。这类文件有两个致命问题：
 *
 *         1) moov.mvhd.duration 常写成 0xFFFFFFFF（"未知"），播放器根本
 *            不知道视频多长，进度条没有可拖的范围；
 *         2) 没有 sidx / mfra 索引时，播放器要定位"第 30 秒"必须从头遍历
 *            所有分片。遇到「整轨一个大分片」的源（音频一整块 + 视频一整块），
 *            任何索引格式都无法表达，结果就是进度条拖不动、拖动后卡住。
 *
 * 本模块做的事：把 fMP4 里所有 sample 的信息（偏移/大小/时长/关键帧标记/
 * 合成时间偏移）提取出来，重建为标准 MP4 的 stbl 索引表（stts / stss /
 * ctts / stsc / stsz / stco|co64），去掉 moof，输出「ftyp + moov(带完整
 * 索引) + mdat」。这样任何播放器都能精确定位任意时间点。
 *
 * 纯逻辑模块，不依赖任何 Chrome API：可在 offscreen 文档与 Node 中运行。
 * 挂载为全局：Mp4Index
 * ============================================================ */
(function (root) {
  'use strict';

  var MOVIE_TS = 1000;                 /* mvhd / tkhd 统一用 1000 的时间基 */
  var CO64_THRESHOLD = 3.9e9;          /* 超过此大小改用 64 位偏移，留出 moov 增长余量 */

  /* ---------------- 字节工具 ---------------- */

  function rdU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function rdI32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
  function rdU64(b, o) {
    var v = 0n;
    for (var i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[o + i]);
    return Number(v);
  }
  function wrU32(b, o, v) {
    v = v >>> 0;
    b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
  }
  function wrU16(b, o, v) { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; }
  function wrU64(b, o, v) {
    var x = BigInt(v);
    for (var i = 7; i >= 0; i--) { b[o + i] = Number(x & 255n); x >>= 8n; }
  }
  function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  function concatBytes(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Uint8Array(n), p = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], p); p += list[i].length; }
    return out;
  }

  function makeBox(type, payload) {
    var body = payload || new Uint8Array(0);
    var out = new Uint8Array(8 + body.length);
    wrU32(out, 0, out.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  }

  /* ---------------- box 解析 ---------------- */

  function parseBoxes(buf, start, end) {
    var out = [], p = start;
    while (p + 8 <= end) {
      var size = rdU32(buf, p);
      var type = fourcc(buf, p + 4);
      var header = 8;
      if (size === 1) {
        if (p + 16 > end) { out.push({ type: type, start: p, size: end - p, header: 8, truncated: true }); break; }
        size = rdU64(buf, p + 8);
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) {
        out.push({ type: type, start: p, size: end - p, header: header, truncated: true });
        break;
      }
      out.push({ type: type, start: p, size: size, header: header, truncated: false });
      p += size;
    }
    return out;
  }

  function kidsOf(buf, b) { return parseBoxes(buf, b.start + b.header, b.start + b.size); }
  function findBox(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
  }
  function sliceBox(buf, b) { return buf.subarray(b.start, b.start + b.size); }
  function pathOf(buf, b, names) {
    var cur = b;
    for (var i = 0; i < names.length; i++) {
      if (!cur) return null;
      cur = findBox(kidsOf(buf, cur), names[i]);
    }
    return cur;
  }

  /* tkhd / mdhd 里 duration 与 timescale 的读取 */
  function readTkhdDuration(buf, tkhd) {
    var v = buf[tkhd.start + tkhd.header];
    var base = tkhd.start + tkhd.header + 4;
    return v === 1 ? rdU64(buf, base + 24) : rdU32(buf, base + 16);
  }
  function readTimescale(buf, trak) {
    var mdia = findBox(kidsOf(buf, trak), 'mdia');
    var mdhd = mdia ? findBox(kidsOf(buf, mdia), 'mdhd') : null;
    if (!mdhd) return 0;
    var v = buf[mdhd.start + mdhd.header];
    var base = mdhd.start + mdhd.header + 4;
    return rdU32(buf, base + (v === 1 ? 16 : 8));
  }
  function readTrackId(buf, trak) {
    var tkhd = findBox(kidsOf(buf, trak), 'tkhd');
    if (!tkhd) return -1;
    var v = buf[tkhd.start + tkhd.header];
    var base = tkhd.start + tkhd.header + 4;
    return rdU32(buf, base + (v === 1 ? 16 : 8));
  }

  /* ---------------- 判定 ---------------- */

  function inspect(buf) {
    var tops = parseBoxes(buf, 0, buf.length);
    var moov = findBox(tops, 'moov');
    var moofs = tops.filter(function (b) { return b.type === 'moof'; });
    var out = {
      ok: false, fragmented: moofs.length > 0, moofCount: moofs.length,
      hasSidx: !!findBox(tops, 'sidx'), hasMfra: !!findBox(tops, 'mfra'),
      hasIndex: false, durationUnknown: false, needsRebuild: false, reason: ''
    };
    if (!moov) { out.reason = 'no-moov'; return out; }
    out.ok = true;

    var mk = kidsOf(buf, moov);
    var mvhd = findBox(mk, 'mvhd');
    if (mvhd) {
      var v = buf[mvhd.start + mvhd.header];
      var base = mvhd.start + mvhd.header + 4;
      var dur = v === 1 ? rdU64(buf, base + 20) : rdU32(buf, base + 12);
      if (dur === 0 || dur === 4294967295) out.durationUnknown = true;
    }

    var traks = mk.filter(function (b) { return b.type === 'trak'; });
    for (var i = 0; i < traks.length; i++) {
      var stbl = pathOf(buf, traks[i], ['mdia', 'minf', 'stbl']);
      if (!stbl) continue;
      var sk = kidsOf(buf, stbl);
      var stco = findBox(sk, 'stco') || findBox(sk, 'co64');
      if (stco && rdU32(buf, stco.start + stco.header + 4) > 0) { out.hasIndex = true; break; }
    }

    out.needsRebuild = out.fragmented && !out.hasIndex;
    return out;
  }

  /* ---------------- 关键帧判定 ----------------
   * sample_flags 位布局（ISO/IEC 14496-12）：
   *   bits 25-24 sample_depends_on      0=未知 1=依赖其他帧（P/B） 2=不依赖（I 帧）
   *   bit  16    sample_is_non_sync_sample  1=明确不是同步帧
   * 注意 depends_on==2 恰恰表示「这是关键帧」——把它当成非关键帧会让整张
   * stss 表颠倒，播放器从 P 帧开始解码，直接报 "Failed to send video packet"。 */
  function isSyncSample(flags) {
    if (flags & 0x00010000) return false;
    if (((flags >>> 24) & 0x03) === 1) return false;
    return true;
  }

  /* ---------------- 收集 sample ---------------- */

  /* mvex/trex 里的每轨默认值。tfhd 没写默认值时必须以 trex 为准，
     否则会读到 size=0 的「空帧」，重建出的文件一个字节数据都没有。 */
  function readTrexMap(buf, moov) {
    var map = new Map();
    var mvex = findBox(kidsOf(buf, moov), 'mvex');
    if (!mvex) return map;
    var trexes = kidsOf(buf, mvex).filter(function (b) { return b.type === 'trex' && !b.truncated; });
    for (var i = 0; i < trexes.length; i++) {
      var p = trexes[i].start + trexes[i].header + 4;
      var id = rdU32(buf, p);
      map.set(id, {
        dur: rdU32(buf, p + 8),
        size: rdU32(buf, p + 12),
        flags: rdU32(buf, p + 16)
      });
    }
    return map;
  }

  /* 该 moof 后面的 mdat 是否完整（下载被截断时最后一块 mdat 往往只有半截）。
     不完整的片段整块丢弃：宁可少几帧，也不能让索引指向不存在的数据。 */
  function nextMdatComplete(tops, ti) {
    for (var k = ti + 1; k < tops.length; k++) {
      var t = tops[k];
      if (t.type === 'mdat') return !t.truncated;
      if (t.type === 'moof') return false;
      if (t.type === 'free' || t.type === 'skip' || t.type === 'sidx' ||
        t.type === 'styp' || t.type === 'prft' || t.type === 'emsg') continue;
      return false;
    }
    return false;
  }

  function collectSamples(buf, tops, sampleTracks, trexMap) {
    var byTrack = new Map();   /* trackId -> 可用的 sample 列表 */
    var rawByTrack = new Map(); /* trackId -> 源文件里声明的 sample 总数 */
    sampleTracks.forEach(function (t) {
      byTrack.set(t.id, []);
      rawByTrack.set(t.id, 0);
    });

    var pending = 0;
    for (var ti = 0; ti < tops.length; ti++) {
      var top = tops[ti];
      if (top.type !== 'moof' || top.truncated) continue;
      var moofStart = top.start;
      var dataOk = nextMdatComplete(tops, ti);
      pending = 0;   /* 规范：每个 moof 的首个 traf 以 moof 起点为基准 */
      var trafs = kidsOf(buf, top).filter(function (b) { return b.type === 'traf'; });

      for (var fi = 0; fi < trafs.length; fi++) {
        var tk = kidsOf(buf, trafs[fi]);
        var tfhd = findBox(tk, 'tfhd');
        if (!tfhd) continue;
        var tfFlags = rdU32(buf, tfhd.start + tfhd.header) & 0xffffff;
        var p = tfhd.start + tfhd.header + 4;
        var trackId = rdU32(buf, p); p += 4;
        if (!byTrack.has(trackId)) continue;

        var trex = trexMap.get(trackId) || { dur: 0, size: 0, flags: 0 };
        var baseDataOffset = -1;
        if (tfFlags & 0x01) { baseDataOffset = rdU64(buf, p); p += 8; }
        if (tfFlags & 0x02) p += 4;
        var defDur = trex.dur, defSize = trex.size, defFlags = trex.flags;
        if (tfFlags & 0x08) { defDur = rdU32(buf, p); p += 4; }
        if (tfFlags & 0x10) { defSize = rdU32(buf, p); p += 4; }
        if (tfFlags & 0x20) { defFlags = rdU32(buf, p); p += 4; }

        if (baseDataOffset < 0) baseDataOffset = (tfFlags & 0x020000) ? moofStart : (pending || moofStart);

        var list = byTrack.get(trackId);
        var raw = rawByTrack.get(trackId);
        var dataPos = baseDataOffset;
        var truns = tk.filter(function (b) { return b.type === 'trun' && !b.truncated; });

        for (var ri = 0; ri < truns.length; ri++) {
          var o = truns[ri].start + truns[ri].header;
          var tFlags = rdU32(buf, o) & 0xffffff;
          var q = o + 4;
          var count = rdU32(buf, q); q += 4;
          if (tFlags & 0x01) { dataPos = baseDataOffset + rdI32(buf, q); q += 4; }
          var firstFlags = null;
          if (tFlags & 0x04) { firstFlags = rdU32(buf, q); q += 4; }

          var hasDur = (tFlags & 0x100) !== 0;
          var hasSize = (tFlags & 0x200) !== 0;
          var hasFlags = (tFlags & 0x400) !== 0;
          var hasCts = (tFlags & 0x800) !== 0;
          raw += count;

          for (var i = 0; i < count; i++) {
            var dur = defDur, size = defSize, flags = defFlags, cts = 0;
            if (hasDur) { dur = rdU32(buf, q); q += 4; }
            if (hasSize) { size = rdU32(buf, q); q += 4; }
            if (hasFlags) { flags = rdU32(buf, q); q += 4; }
            else if (i === 0 && firstFlags !== null) flags = firstFlags;
            if (hasCts) { cts = rdI32(buf, q); q += 4; }

            if (dataOk) list.push({ offset: dataPos, size: size, dur: dur, cts: cts, sync: isSyncSample(flags) });
            dataPos += size;
          }
        }
        rawByTrack.set(trackId, raw);
        pending = dataPos;
      }
    }
    return { byTrack: byTrack, rawByTrack: rawByTrack };
  }

  /* ---------------- 合成时间归一化 ----------------
   * 源文件常把 ctts 整体抬一个正偏移（B站这里抬了 3200），再用 edts/elst 的
   * media_time 把它抵回来。重建时 edts 会被丢弃，若不把偏移归零，首帧 PTS
   * 就不是 0，播放器会一直等不到「起始关键帧」而报解码失败。
   * 这里减去最小 PTS，让整条时间轴从 0 开始。 */
  function normalizeComposition(list) {
    var dts = 0, minPts = Infinity;
    for (var i = 0; i < list.length; i++) {
      var pts = dts + list[i].cts;
      if (pts < minPts) minPts = pts;
      dts += list[i].dur;
    }
    if (!isFinite(minPts) || minPts === 0) return;
    for (var j = 0; j < list.length; j++) list[j].cts -= minPts;
  }

  /* ---------------- 索引表构建 ---------------- */

  function buildStts(samples) {
    var entries = [];
    for (var i = 0; i < samples.length; i++) {
      var last = entries[entries.length - 1];
      if (last && last.delta === samples[i].dur) last.count++;
      else entries.push({ count: 1, delta: samples[i].dur });
    }
    var body = new Uint8Array(8 + entries.length * 8);
    wrU32(body, 0, 0);
    wrU32(body, 4, entries.length);
    for (var k = 0; k < entries.length; k++) {
      wrU32(body, 8 + k * 8, entries[k].count);
      wrU32(body, 12 + k * 8, entries[k].delta);
    }
    return makeBox('stts', body);
  }

  function buildStss(samples) {
    var idx = [];
    for (var i = 0; i < samples.length; i++) if (samples[i].sync) idx.push(i + 1);
    /* 全部同步帧（常见于纯音频）→ 省略 stss，播放器默认全部可寻址 */
    if (!idx.length || idx.length === samples.length) return null;
    var body = new Uint8Array(8 + idx.length * 4);
    wrU32(body, 0, 0);
    wrU32(body, 4, idx.length);
    for (var k = 0; k < idx.length; k++) wrU32(body, 8 + k * 4, idx[k]);
    return makeBox('stss', body);
  }

  function buildCtts(samples) {
    var any = false, neg = false;
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].cts !== 0) any = true;
      if (samples[i].cts < 0) neg = true;
    }
    if (!any) return null;

    var entries = [];
    for (var j = 0; j < samples.length; j++) {
      var last = entries[entries.length - 1];
      if (last && last.off === samples[j].cts) last.count++;
      else entries.push({ count: 1, off: samples[j].cts });
    }
    var body = new Uint8Array(8 + entries.length * 8);
    /* 有负偏移（B 帧常见）时必须用 version 1，version 0 的偏移是无符号的，
       写成大正数会让整条时间轴错乱 */
    wrU32(body, 0, neg ? 0x01000000 : 0);
    wrU32(body, 4, entries.length);
    for (var k = 0; k < entries.length; k++) {
      wrU32(body, 8 + k * 8, entries[k].count);
      wrU32(body, 12 + k * 8, entries[k].off >>> 0);
    }
    return makeBox('ctts', body);
  }

  /* 每个 sample 一个 chunk：stsc 只需一条记录，stco 条目数 = sample 数 */
  function buildStsc() {
    var body = new Uint8Array(4 + 4 + 12);
    wrU32(body, 0, 0);
    wrU32(body, 4, 1);
    wrU32(body, 8, 1);      /* first_chunk */
    wrU32(body, 12, 1);     /* samples_per_chunk */
    wrU32(body, 16, 1);     /* sample_description_index */
    return makeBox('stsc', body);
  }

  function buildStsz(samples) {
    var uniform = samples.length > 1;
    if (uniform) {
      for (var i = 1; i < samples.length; i++) {
        if (samples[i].size !== samples[0].size) { uniform = false; break; }
      }
    }
    if (uniform) {
      var fixed = new Uint8Array(12);
      wrU32(fixed, 0, 0);
      wrU32(fixed, 4, samples[0].size);
      wrU32(fixed, 8, samples.length);
      return makeBox('stsz', fixed);
    }
    var body = new Uint8Array(12 + samples.length * 4);
    wrU32(body, 0, 0);
    wrU32(body, 4, 0);
    wrU32(body, 8, samples.length);
    for (var k = 0; k < samples.length; k++) wrU32(body, 12 + k * 4, samples[k].size);
    return makeBox('stsz', body);
  }

  function buildChunkOffsets(offsets, use64) {
    var n = offsets.length;
    var body = new Uint8Array(8 + n * (use64 ? 8 : 4));
    wrU32(body, 0, 0);
    wrU32(body, 4, n);
    for (var i = 0; i < n; i++) {
      if (use64) wrU64(body, 8 + i * 8, offsets[i]);
      else wrU32(body, 8 + i * 4, offsets[i]);
    }
    return makeBox(use64 ? 'co64' : 'stco', body);
  }

  /* ---------------- 偏移重算 ----------------
   * 输出布局是「ftyp + newMoov + 所有 mdat」，源文件里其它顶层盒（moof、
   * sidx、free、styp、mfra…）全部丢弃。所以不能用「减掉前面 moof 总大小」
   * 这种近似——真实文件里 mdat 前面常夹着 sidx（B站每个分片清单近 5KB）
   * 和 free 填充，漏减就会让每个 chunk 偏移整体错位；播放器读到错位数据后
   * 表现为「无法解码 / 进度条拖不动」。
   * 这里直接按新布局算出每块 mdat 的位移，逐块累加，不做任何假设。 */

  function buildMdatMap(tops, headSize) {
    var map = [];
    var newPos = headSize;              /* ftyp + moov 之后 */
    for (var i = 0; i < tops.length; i++) {
      var t = tops[i];
      if (t.type !== 'mdat' || t.truncated) continue;
      map.push({ start: t.start, end: t.start + t.size, newStart: newPos, delta: newPos - t.start });
      newPos += t.size;
    }
    return map;
  }

  function computeOffsets(samples, map) {
    var out = new Array(samples.length);
    var ok = true;
    /* sample 在源文件里天然按顺序排列，mdat 也是；用游标单向前进即可 O(N+M)。
       万一遇到乱序（正常 muxer 不会），游标回退到 0 重扫，保证结果正确。 */
    var mi = 0;
    for (var k = 0; k < samples.length; k++) {
      var s = samples[k];
      if (mi > 0 && s.offset < map[mi].start) mi = 0;
      while (mi < map.length && s.offset >= map[mi].end) mi++;
      if (mi >= map.length || s.offset < map[mi].start) { ok = false; out[k] = 0; continue; }
      var hit = map[mi];
      var nb = s.offset + hit.delta;
      /* 换算后必须仍落在同一块 mdat 的数据区内 */
      var payloadStart = hit.newStart + 8;
      var payloadEnd = hit.newStart + (hit.end - hit.start);
      if (nb < payloadStart || nb + s.size > payloadEnd) ok = false;
      out[k] = nb;
    }
    return { offsets: out, ok: ok };
  }

  /* ---------------- trak 重建 ---------------- */

  function rebuildTrak(ctx, trak, samples) {
    var buf = ctx.buf;
    var tk = kidsOf(buf, trak);
    var tkhd = findBox(tk, 'tkhd');
    var mdia = findBox(tk, 'mdia');
    if (!tkhd || !mdia) return null;

    var md = kidsOf(buf, mdia);
    var mdhd = findBox(md, 'mdhd');
    var minf = findBox(md, 'minf');
    if (!mdhd || !minf) return null;
    var timescale = readTimescale(buf, trak);
    if (!timescale) return null;

    var totalDur = 0;
    for (var i = 0; i < samples.length; i++) totalDur += samples[i].dur;

    /* --- mdhd.duration = 该轨实际总时长 ---
       v0: version/flags(4) creation(4) modification(4) timescale(4) duration(4)
       v1: version/flags(4) creation(8) modification(8) timescale(4) duration(8) */
    var mdhdBytes = Uint8Array.from(sliceBox(buf, mdhd));
    var mdhv = mdhdBytes[mdhd.header];
    var mdhBase = mdhd.header + 4;
    if (mdhv === 1) wrU64(mdhdBytes, mdhBase + 20, totalDur);
    else wrU32(mdhdBytes, mdhBase + 12, totalDur);

    /* --- tkhd.duration = 换算到 movie timescale --- */
    var tkhdBytes = Uint8Array.from(sliceBox(buf, tkhd));
    var tkhv = tkhdBytes[tkhd.header];
    var tkhBase = tkhd.header + 4;
    var durMovie = Math.round(totalDur / timescale * MOVIE_TS);
    if (tkhv === 1) wrU64(tkhdBytes, tkhBase + 24, durMovie);
    else wrU32(tkhdBytes, tkhBase + 16, durMovie);

    /* --- stbl 重建 --- */
    var stbl = findBox(kidsOf(buf, minf), 'stbl');
    if (!stbl) return null;
    var stsd = findBox(kidsOf(buf, stbl), 'stsd');
    if (!stsd) return null;   /* 没有编码描述就无法重建 */

    var offsets = ctx.offsetsFor(samples);
    if (!offsets.ok) throw new Error('帧数据偏移与 mdat 数据区对不上，已中止以免产出坏文件');
    var parts = [sliceBox(buf, stsd), buildStts(samples)];
    var stss = buildStss(samples);
    if (stss) parts.push(stss);
    var ctts = buildCtts(samples);
    if (ctts) parts.push(ctts);
    parts.push(buildStsc());
    parts.push(buildStsz(samples));
    parts.push(buildChunkOffsets(offsets.offsets, ctx.use64));
    var newStbl = makeBox('stbl', concatBytes(parts));

    /* --- minf：保留 vmhd/smhd/dinf，替换 stbl --- */
    var mink = kidsOf(buf, minf);
    var minfParts = [];
    for (var a = 0; a < mink.length; a++) {
      minfParts.push(mink[a].type === 'stbl' ? newStbl : sliceBox(buf, mink[a]));
    }
    var newMinf = makeBox('minf', concatBytes(minfParts));

    /* --- mdia：替换 mdhd / minf --- */
    var mdiaParts = [];
    for (var b = 0; b < md.length; b++) {
      if (md[b].type === 'mdhd') mdiaParts.push(mdhdBytes);
      else if (md[b].type === 'minf') mdiaParts.push(newMinf);
      else mdiaParts.push(sliceBox(buf, md[b]));
    }
    var newMdia = makeBox('mdia', concatBytes(mdiaParts));

    /* --- trak：替换 tkhd / mdia，丢弃 edts ---
       edts/elst 描述的是「源文件时间轴怎么剪」，里面记的 media_time 是源分片
       的绝对时间；重建后分片被重新编号、ctts 也被归一化，这些数值全部失效。
       留着它反而会让播放器把时长算成零点几秒（实测 Chrome 直接把 35 秒的
       文件读成 0.734 秒，进度条完全失效）。 */
    var trakParts = [];
    for (var c = 0; c < tk.length; c++) {
      if (tk[c].type === 'tkhd') trakParts.push(tkhdBytes);
      else if (tk[c].type === 'mdia') trakParts.push(newMdia);
      else if (tk[c].type === 'edts') continue;
      else trakParts.push(sliceBox(buf, tk[c]));
    }

    return {
      bytes: makeBox('trak', concatBytes(trakParts)),
      timescale: timescale,
      totalDur: totalDur,
      sampleCount: samples.length
    };
  }

  /* ---------------- 主入口 ---------------- */

  /**
   * 把 fMP4 重建为带完整索引的标准 MP4。
   * @param {Uint8Array} buf
   * @param {{asParts?:boolean}} [opts] asParts=true 时返回分片数组（省一次整文件拷贝）
   * @returns {{ data?: Uint8Array, parts?: Uint8Array[], changed: boolean, note: string,
   *             durationSec: number, tracks: number, samples: number, dropped: number }}
   */
  function toIndexedMp4(buf, opts) {
    var info = inspect(buf);
    if (!info.ok) throw new Error('不是有效的 MP4（' + info.reason + '）');
    if (!info.needsRebuild) {
      return { data: buf, changed: false, note: '已有完整索引，无需处理', durationSec: 0, tracks: 0, samples: 0, dropped: 0 };
    }

    var tops = parseBoxes(buf, 0, buf.length);
    var moov = findBox(tops, 'moov');
    var ftyp = findBox(tops, 'ftyp');

    var mk = kidsOf(buf, moov);
    var trakList = [];
    var traks = mk.filter(function (b) { return b.type === 'trak'; });
    for (var i = 0; i < traks.length; i++) {
      var id = readTrackId(buf, traks[i]);
      if (id >= 0) trakList.push({ id: id, trak: traks[i] });
    }
    if (!trakList.length) throw new Error('moov 里没有可用轨道');

    var trexMap = readTrexMap(buf, moov);
    var collected = collectSamples(buf, tops, trakList, trexMap);
    var byTrack = collected.byTrack;
    var totalSamples = 0;
    var dropped = 0;
    var usableTracks = [];
    for (var ti = 0; ti < trakList.length; ti++) {
      var tId = trakList[ti].id;
      var listN = byTrack.get(tId) || [];
      var rawN = collected.rawByTrack.get(tId) || 0;
      if (!listN.length) {
        /* 源文件本来就没这块数据 → 该轨是空壳，跳过；源里有数据但全被丢弃
           （尾部片段不完整）→ 会丢整条轨，直接中止更安全 */
        if (rawN > 0) throw new Error('轨道 #' + tId + ' 的数据不完整（' + rawN + ' 帧无法定位），已中止');
        continue;
      }
      totalSamples += listN.length;
      dropped += Math.max(0, rawN - listN.length);
      normalizeComposition(listN);
      usableTracks.push(trakList[ti]);
    }
    if (!totalSamples) throw new Error('没有找到任何 sample（moof/trun 为空）');
    trakList = usableTracks;

    var totalBytes = 0;
    for (var bi = 0; bi < trakList.length; bi++) {
      var bl = byTrack.get(trakList[bi].id);
      for (var bj = 0; bj < bl.length; bj++) totalBytes += bl[bj].size;
    }
    if (!totalBytes) throw new Error('所有 sample 的长度都是 0（缺少 trex/tfhd 默认值）');

    var use64 = buf.length > CO64_THRESHOLD;
    var ctx = {
      buf: buf, tops: tops, oldMoovSize: moov.size,
      newMoovSize: moov.size, use64: use64,
      /* 第一遍只量字节数，偏移数值不影响任何表的大小 */
      offsetsFor: function (list) { return { offsets: list.map(function () { return 0; }), ok: true }; }
    };

    /* 第一遍：只为量出 newMoov 的确切大小（stbl 各表大小与偏移数值无关） */
    var probeParts = [buildMvhd(MOVIE_TS, 0, 1)];
    for (var p1 = 0; p1 < trakList.length; p1++) {
      var list1 = byTrack.get(trakList[p1].id) || [];
      if (!list1.length) continue;
      var r1 = rebuildTrak(ctx, trakList[p1].trak, list1);
      if (r1) probeParts.push(r1.bytes);
    }
    var newMoovSize = makeBox('moov', concatBytes(probeParts)).length;

    /* 输出头部（ftyp + moov）尺寸定了，才能算出每块 mdat 的新位置 */
    var ftypBytes = ftyp
      ? sliceBox(buf, ftyp)
      : makeBox('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d]));
    var mdatMap = buildMdatMap(tops, ftypBytes.length + newMoovSize);

    /* 第二遍：用真实 mdat 位移计算偏移并落盘 */
    ctx.newMoovSize = newMoovSize;
    ctx.offsetsFor = function (list) { return computeOffsets(list, mdatMap); };
    var bodyParts = [buildMvhd(MOVIE_TS, 0, 1)];
    var meta = [];
    for (var p2 = 0; p2 < trakList.length; p2++) {
      var list2 = byTrack.get(trakList[p2].id) || [];
      if (!list2.length) continue;
      var r2 = rebuildTrak(ctx, trakList[p2].trak, list2);
      if (r2) { bodyParts.push(r2.bytes); meta.push(r2); }
    }

    var maxDurSec = 0;
    var maxTrackId = 0;
    for (var m = 0; m < meta.length; m++) {
      maxDurSec = Math.max(maxDurSec, meta[m].totalDur / meta[m].timescale);
    }
    for (var t = 0; t < trakList.length; t++) maxTrackId = Math.max(maxTrackId, trakList[t].id);

    bodyParts[0] = buildMvhd(MOVIE_TS, Math.round(maxDurSec * MOVIE_TS), maxTrackId + 1);
    var newMoov = makeBox('moov', concatBytes(bodyParts));

    if (newMoov.length !== newMoovSize) {
      throw new Error('moov 大小与预估不一致（' + newMoovSize + ' vs ' + newMoov.length + '），已中止以免产出坏文件');
    }

    var out = [];
    out.push(ftypBytes);
    out.push(newMoov);
    var mdatCount = 0;
    for (var e = 0; e < tops.length; e++) {
      if (tops[e].type === 'mdat' && !tops[e].truncated) { out.push(sliceBox(buf, tops[e])); mdatCount++; }
    }
    if (!mdatCount) throw new Error('没有找到 mdat 数据');

    var res = {
      changed: true,
      note: '已重建索引（' + meta.length + ' 轨 / ' + totalSamples + ' 帧 / ' +
        maxDurSec.toFixed(1) + ' 秒' + (use64 ? ' / 64 位偏移' : '') +
        (dropped ? '，尾部不完整片段已丢弃 ' + dropped + ' 帧' : '') + '）',
      durationSec: maxDurSec,
      tracks: meta.length,
      samples: totalSamples,
      dropped: dropped
    };
    if (opts && opts.asParts) res.parts = out;
    else res.data = concatBytes(out);
    return res;
  }

  function buildMvhd(timescale, duration, nextTrackId) {
    var c = new Uint8Array(100);
    wrU32(c, 0, 0);
    wrU32(c, 4, 0);
    wrU32(c, 8, 0);
    wrU32(c, 12, timescale);
    wrU32(c, 16, duration);
    wrU32(c, 20, 0x00010000);       /* rate = 1.0 */
    wrU16(c, 24, 0x0100);           /* volume = 1.0 */
    wrU32(c, 36, 0x00010000);       /* matrix[0] */
    wrU32(c, 52, 0x00010000);       /* matrix[4] */
    wrU32(c, 68, 0x40000000);       /* matrix[8]（正确偏移 36+8*4=68） */
    wrU32(c, 96, nextTrackId);
    return makeBox('mvhd', c);
  }

  /* ---------------- 低成本预判 ----------------
   * 大文件（几百 MB 的 HLS 下载）不能为了「判断要不要重建」先整份拼起来。
   * 只看开头一段就足够：碎片化 MP4 的 moov 里必有 mvex，且 moof 紧跟其后。 */

  var HEAD_TOP_BOXES = {
    ftyp: 1, styp: 1, moov: 1, mdat: 1, moof: 1,
    free: 1, skip: 1, wide: 1, sidx: 1, pdin: 1
  };

  /**
   * @param {Uint8Array} head 文件开头若干 KB
   * @returns {'notmp4'|'rebuild'|'skip'|'unknown'}
   */
  function sniffHead(head) {
    if (!head || head.length < 16) return 'unknown';
    var tops = parseBoxes(head, 0, head.length);
    if (!tops.length) return 'unknown';
    if (!HEAD_TOP_BOXES[tops[0].type]) return 'notmp4';

    var sawMoov = false, sawMvex = false;
    for (var i = 0; i < tops.length; i++) {
      var t = tops[i];
      if (t.type === 'moof') return 'rebuild';
      if (t.type === 'mdat') return sawMoov ? 'unknown' : 'skip';  /* moov 还没出现就到 mdat → moov 在尾部，标准 MP4 */
      if (t.type === 'moov') {
        sawMoov = true;
        if (t.truncated) return 'unknown';
        sawMvex = !!findBox(kidsOf(head, t), 'mvex');
        if (!sawMvex) return 'skip';          /* 有完整 moov 但没有 mvex → 非分片 */
      }
    }
    /* 扫完了还没定论：moov 里带 mvex 但还没看到 moof（head 太短）→ 大概率要重建 */
    return sawMvex ? 'rebuild' : 'unknown';
  }

  var api = {
    inspect: inspect,
    toIndexedMp4: toIndexedMp4,
    sniffHead: sniffHead,
    isSyncSample: isSyncSample,
    buildMvhd: buildMvhd,
    _parseBoxes: parseBoxes
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Mp4Index = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
