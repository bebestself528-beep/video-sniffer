/* ============================================================
 * 视频嗅探下载器 - fMP4 音视频轨合并
 *
 * 背景：B站、以及大量使用 DASH 的站点会把视频轨和音频轨拆成两条独立的
 *       流（例如 62131_da3-1-30032.m4s 只有画面、-1-30216.m4s 只有声音），
 *       播放器在内存里用 MSE 把两轨拼起来播。直接分别下载就会得到
 *       「有画面没声音」和「有声音没画面」两个文件。
 *
 * 本模块做的事：
 *   inspect() —— 解析一个 fMP4 的 moov，判断它是纯视频轨、纯音频轨还是混合轨
 *   mergeAv() —— 把一条纯视频轨 + 一条纯音频轨合成为一个双轨 MP4（fMP4 结构）
 *
 * 合并原理（fMP4 天然支持）：
 *   1. 取视频轨的 ftyp 作为输出头；
 *   2. 重建 moov：新建 mvhd + 视频 trak + 音频 trak + mvex(两个 trex)；
 *   3. 音频轨的 track_ID 需要重编号（避免与视频轨冲突），同步改写它的
 *      tkhd / trex / 每一个 moof→traf→tfhd；
 *   4. 两轨的 moof+mdat 片段按 tfdt 解码时间顺序交织输出。
 *   每条 trak 自带 timescale，因此各轨的 tfdt 无需换算即可直接使用。
 *
 * 纯逻辑模块，不依赖任何 Chrome API：可在 offscreen 文档与 Node 中运行。
 * 挂载为全局：Fmp4Merge
 * ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- 字节工具 ---------------- */

  function rdU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function rdU16(b, o) { return ((b[o] << 8) | b[o + 1]) >>> 0; }
  function rdU64(b, o) {
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[o + i]);
    return Number(v);
  }
  function wrU32(b, o, v) {
    b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
  }
  function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  function makeBox(type, payload) {
    const out = new Uint8Array(8 + payload.length);
    wrU32(out, 0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
  }

  /* ---------------- box 解析 ---------------- */

  /* 解析 [start,end) 范围内的同级 box 列表；遇到截断的最后一个 box 会标记 truncated */
  function parseBoxes(buf, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = rdU32(buf, p);
      const type = fourcc(buf, p + 4);
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) { out.push({ type, start: p, size: end - p, header: 8, truncated: true }); break; }
        size = rdU64(buf, p + 8);
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) {
        out.push({ type, start: p, size: end - p, header, truncated: true });
        break;
      }
      out.push({ type, start: p, size, header, truncated: false });
      p += size;
    }
    return out;
  }

  function kidsOf(buf, b) { return parseBoxes(buf, b.start + b.header, b.start + b.size); }
  function findBox(list, type) {
    for (const b of list) if (b.type === type) return b;
    return null;
  }
  function findAll(list, type) {
    const out = [];
    for (const b of list) if (b.type === type) out.push(b);
    return out;
  }
  function sliceBox(buf, b) { return buf.subarray(b.start, b.start + b.size); }

  /* ---------------- trak 读取 ---------------- */

  function readTrak(buf, trak) {
    const tk = kidsOf(buf, trak);
    const tkhd = findBox(tk, 'tkhd');
    const mdia = findBox(tk, 'mdia');
    const info = { trak, tkhd, mdia, ok: false };
    if (!tkhd || !mdia) return info;

    /* tkhd: version + flags(4) + [creation, modification] + track_ID */
    const tv = buf[tkhd.start + tkhd.header];
    const tb = tkhd.start + tkhd.header + 4;
    info.trackId = rdU32(buf, tb + (tv === 1 ? 16 : 8));

    const md = kidsOf(buf, mdia);
    const mdhd = findBox(md, 'mdhd');
    const hdlr = findBox(md, 'hdlr');

    if (hdlr) info.handler = fourcc(buf, hdlr.start + hdlr.header + 8);
    if (mdhd) {
      const mv = buf[mdhd.start + mdhd.header];
      const mb = mdhd.start + mdhd.header + 4;
      info.timescale = rdU32(buf, mb + (mv === 1 ? 16 : 8));
      info.duration = mv === 1 ? rdU64(buf, mb + 24) : rdU32(buf, mb + 16);
    }

    /* stsd → 第一个 sample entry（判断编码类型、分辨率、采样率） */
    const minf = findBox(md, 'minf');
    const stbl = minf ? findBox(kidsOf(buf, minf), 'stbl') : null;
    const stsd = stbl ? findBox(kidsOf(buf, stbl), 'stsd') : null;
    if (stsd) {
      const entries = parseBoxes(buf, stsd.start + stsd.header + 8, stsd.start + stsd.size);
      const e = entries[0];
      if (e && !e.truncated) {
        info.codec = e.type;
        const cb = e.start + e.header;
        if (info.handler === 'vide') {
          info.width = rdU16(buf, cb + 24);
          info.height = rdU16(buf, cb + 26);
        } else if (info.handler === 'soun') {
          info.channels = rdU16(buf, cb + 16);
          info.sampleRate = rdU32(buf, cb + 24) >>> 16;
        }
      }
    }

    info.ok = !!info.handler && !!info.timescale;
    return info;
  }

  /* ---------------- 片段读取 ---------------- */

  function readTfhd(buf, traf) {
    const tfhd = findBox(kidsOf(buf, traf), 'tfhd');
    if (!tfhd) return null;
    const flags = rdU32(buf, tfhd.start + tfhd.header) & 0xffffff;
    const base = tfhd.start + tfhd.header + 4;
    const out = { box: tfhd, flags, trackId: rdU32(buf, base) };
    let p = base + 4;
    if (flags & 0x000001) p += 8;                       // base_data_offset
    if (flags & 0x000002) p += 4;                       // sample_description_index
    if (flags & 0x000008) { out.defaultSampleDuration = rdU32(buf, p); p += 4; }
    if (flags & 0x000010) { out.defaultSampleSize = rdU32(buf, p); p += 4; }
    if (flags & 0x000020) out.defaultSampleFlags = rdU32(buf, p);
    return out;
  }

  function readTfdt(buf, traf) {
    const tfdt = findBox(kidsOf(buf, traf), 'tfdt');
    if (!tfdt) return null;
    const ver = buf[tfdt.start + tfdt.header];
    const base = tfdt.start + tfdt.header + 4;
    return { box: tfdt, time: ver === 1 ? rdU64(buf, base) : rdU32(buf, base) };
  }

  /* 读取 trun，返回 { sampleCount, durations:number|null, sumDuration } */
  function readTrun(buf, traf, fallbackDuration) {
    const trun = findBox(kidsOf(buf, traf), 'trun');
    if (!trun) return null;
    const flags = rdU32(buf, trun.start + trun.header) & 0xffffff;
    const base = trun.start + trun.header + 4;
    const sampleCount = rdU32(buf, base);
    let p = base + 4;
    if (flags & 0x000001) p += 4;                       // data_offset
    if (flags & 0x000004) p += 4;                       // first_sample_flags

    let perSample = 0;
    if (flags & 0x000100) perSample += 4;               // sample_duration
    if (flags & 0x000200) perSample += 4;               // sample_size
    if (flags & 0x000400) perSample += 4;               // sample_flags
    if (flags & 0x000800) perSample += 4;               // composition_time_offset

    let sum = 0;
    let exact = false;
    if (flags & 0x000100) {
      exact = true;
      for (let i = 0; i < sampleCount; i++) sum += rdU32(buf, p + i * perSample);
    } else if (fallbackDuration) {
      sum = sampleCount * fallbackDuration;
    }
    return { box: trun, flags, sampleCount, sumDuration: sum, exact };
  }

  /* ---------------- 对外：解析 ---------------- */

  /**
   * 解析一个 fMP4 的结构信息。
   * 允许传入文件的前若干字节（head 探测），只要 moov 完整即可。
   */
  function inspect(buf) {
    const tops = parseBoxes(buf, 0, buf.length);
    const ftyp = findBox(tops, 'ftyp');
    const moov = findBox(tops, 'moov');
    if (!moov) return { ok: false, reason: 'no-moov', tops };
    if (moov.truncated) return { ok: false, reason: 'truncated-moov', tops };

    const mk = kidsOf(buf, moov);
    const traks = findAll(mk, 'trak').map((t) => readTrak(buf, t)).filter((t) => t.ok);
    const handlers = traks.map((t) => t.handler);
    const hasVideo = handlers.indexOf('vide') >= 0;
    const hasAudio = handlers.indexOf('soun') >= 0;

    const mvex = findBox(mk, 'mvex');
    const trexes = mvex ? findAll(kidsOf(buf, mvex), 'trex') : [];

    return {
      ok: true,
      ftyp, moov, mvex,
      traks, trexes,
      hasVideo, hasAudio,
      kind: hasVideo && hasAudio ? 'both' : hasVideo ? 'video' : hasAudio ? 'audio' : 'other',
      video: traks.find((t) => t.handler === 'vide') || null,
      audio: traks.find((t) => t.handler === 'soun') || null,
      tops
    };
  }

  /* ---------------- 对外：合并 ---------------- */

  function buildMvhd(timescale, duration, nextTrackId) {
    const c = new Uint8Array(100);
    wrU32(c, 0, 0);                          // version 0 + flags
    wrU32(c, 4, 0);                          // creation_time
    wrU32(c, 8, 0);                          // modification_time
    wrU32(c, 12, timescale);
    wrU32(c, 16, duration);
    wrU32(c, 20, 0x00010000);                // rate = 1.0
    c[24] = 0x01; c[25] = 0x00;              // volume = 1.0
    /* 26..27 reserved, 28..35 reserved */
    wrU32(c, 36, 0x00010000);                // matrix[0]
    wrU32(c, 52, 0x00010000);                // matrix[4]
    wrU32(c, 76, 0x40000000);                // matrix[8]
    wrU32(c, 96, nextTrackId);               // next_track_ID
    return makeBox('mvhd', c);
  }

  function buildMehd(duration) {
    const c = new Uint8Array(8);
    wrU32(c, 0, 0);                          // version 0 + flags
    wrU32(c, 4, duration);
    return makeBox('mehd', c);
  }

  /**
   * 把一条纯视频轨与一条纯音频轨合成为一个 fMP4。
   * @param {Uint8Array} videoBuf 含 vide trak 的完整 fMP4（ftyp+moov+fragments）
   * @param {Uint8Array} audioBuf 含 soun trak 的完整 fMP4
   * @returns {{ data: Uint8Array, merged: boolean, note: string, durationSec: number, video:object, audio:object }}
   */
  function mergeAv(videoBuf, audioBuf) {
    const V = inspect(videoBuf);
    if (!V.ok) throw new Error('视频轨解析失败：' + V.reason);
    const A = inspect(audioBuf);
    if (!A.ok) throw new Error('音频轨解析失败：' + A.reason);
    if (!V.hasVideo) throw new Error('第一个文件里没有视频轨（handler_type != vide）');
    if (!A.hasAudio) throw new Error('第二个文件里没有音频轨（handler_type != soun）');

    /* 视频轨本身已含音频 → 无需合并 */
    if (V.hasAudio) {
      return { data: videoBuf, merged: false, note: '视频轨已包含音频，无需合并', durationSec: 0, video: V.video, audio: V.audio };
    }
    if (!V.mvex || !A.mvex) throw new Error('缺少 mvex（该文件不是分片 MP4，无法合并）');
    const vTrex = findBox(kidsOf(videoBuf, V.mvex), 'trex');
    const aTrex = findBox(kidsOf(audioBuf, A.mvex), 'trex');
    if (!vTrex || !aTrex) throw new Error('缺少 trex，无法重建 mvex');

    /* ---------- 1. 确定新的 track_ID（音频轨重编号，避免与视频轨冲突） ---------- */
    const vId = V.video.trackId;
    const newAId = vId === 1 ? 2 : 1;

    /* ---------- 2. 在音频轨副本上改写 track_ID ---------- */
    const aCopy = Uint8Array.from(audioBuf);

    /* 2.1 trak/tkhd.track_ID */
    {
      const aTkhd = A.audio.tkhd;
      const tv = aCopy[aTkhd.start + aTkhd.header];
      wrU32(aCopy, aTkhd.start + aTkhd.header + 4 + (tv === 1 ? 16 : 8), newAId);
    }
    /* 2.2 mvex/trex.track_ID */
    {
      const off = aTrex.start + aTrex.header + 4;
      wrU32(aCopy, off, newAId);
    }
    /* 2.3 每个 moof→traf→tfhd.track_ID */
    let patched = 0;
    for (const top of parseBoxes(aCopy, 0, aCopy.length)) {
      if (top.type !== 'moof') continue;
      for (const traf of findAll(kidsOf(aCopy, top), 'traf')) {
        const h = readTfhd(aCopy, traf);
        if (h) { wrU32(aCopy, h.box.start + h.box.header + 4, newAId); patched++; }
      }
    }
    if (!patched) throw new Error('音频轨没有可改写的分片（tfhd 未找到）');

    /* ---------- 3. 重建 moov ---------- */
    const vTrakBytes = sliceBox(videoBuf, V.video.trak);
    const aTrakBytes = aCopy.subarray(A.audio.trak.start, A.audio.trak.start + A.audio.trak.size);
    const vTrexBytes = sliceBox(videoBuf, vTrex);
    const aTrexBytes = aCopy.subarray(aTrex.start, aTrex.start + aTrex.size);

    /* ---------- 4. 统计时长（用于 mvhd/mehd） ---------- */
    /* aCopy 与 audioBuf 字节布局完全一致，可直接复用 A 里的偏移 */
    const vTimeline = collectFragments(videoBuf, V);
    const aTimeline = collectFragments(aCopy, A);
    const vDur = timelineSeconds(vTimeline);
    const aDur = timelineSeconds(aTimeline);
    const durationSec = Math.max(vDur, aDur);
    const MV_TIMESCALE = 1000;
    const mvhdDuration = Math.round(durationSec * MV_TIMESCALE);

    const mvexPayload = concat([buildMehd(mvhdDuration), vTrexBytes, aTrexBytes]);
    const moov = makeBox('moov', concat([
      buildMvhd(MV_TIMESCALE, mvhdDuration, Math.max(vId, newAId) + 1),
      vTrakBytes,
      aTrakBytes,
      makeBox('mvex', mvexPayload)
    ]));

    /* ---------- 5. 输出：ftyp + moov + 按解码时间交织的片段 ---------- */
    const chunks = [];
    if (V.ftyp) chunks.push(sliceBox(videoBuf, V.ftyp));
    else chunks.push(makeBox('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d])));
    chunks.push(moov);

    const all = vTimeline.concat(aTimeline);
    all.sort((x, y) => (x.seconds - y.seconds) || (x.order - y.order));
    for (const f of all) chunks.push(f.bytes);

    return {
      data: concat(chunks),
      merged: true,
      note: '已合并视频轨 + 音频轨（音轨 #' + newAId + '，' + patched + ' 个分片）',
      durationSec,
      video: V.video,
      audio: A.audio
    };
  }

  /* ---------------- 片段时间轴 ---------------- */

  function collectFragments(buf, info) {
    const trak = info.traks && info.traks[0];
    const timescale = (trak && trak.timescale) || 1000;
    const defaultDur = info.trexes && info.trexes[0]
      ? rdU32(buf, info.trexes[0].start + info.trexes[0].header + 12)
      : 0;

    const tops = parseBoxes(buf, 0, buf.length);
    const out = [];
    let order = 0;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i].type !== 'moof' || tops[i].truncated) continue;
      let end = tops[i].start + tops[i].size;
      const next = tops[i + 1];
      if (next && next.type === 'mdat' && !next.truncated) end = next.start + next.size;

      let startTime = 0;
      let dur = 0;
      for (const traf of findAll(kidsOf(buf, tops[i]), 'traf')) {
        const tfdt = readTfdt(buf, traf);
        const tfhd = readTfhd(buf, traf);
        const fd = (tfhd && tfhd.defaultSampleDuration) || defaultDur || 0;
        const trun = readTrun(buf, traf, fd);
        if (tfdt) startTime = Math.max(startTime, tfdt.time);
        if (trun) dur = Math.max(dur, trun.sumDuration);
      }
      out.push({
        bytes: buf.subarray(tops[i].start, end),
        time: startTime,
        timescale,
        seconds: startTime / timescale,
        durationSec: dur / timescale,
        order: order++
      });
    }
    return out;
  }

  function timelineSeconds(frags) {
    let end = 0;
    for (const f of frags) end = Math.max(end, f.seconds + f.durationSec);
    return end;
  }

  /* ---------------- 轨类型判定（供嗅探 UI 使用） ---------------- */

  /**
   * 轻量分类：只需文件头若干字节即可判断是纯视频轨 / 纯音频轨。
   * @returns {{ok:boolean, role:'video'|'audio'|'both'|'unknown', label:string, codec?:string, detail?:string}}
   */
  function classifyHead(buf) {
    const info = inspect(buf);
    if (!info.ok) return { ok: false, role: 'unknown', label: '未知' };
    const v = info.video, a = info.audio;
    if (v && a) return { ok: true, role: 'both', label: '音视频', codec: v.codec, detail: v.width + '×' + v.height };
    if (v) {
      return {
        ok: true, role: 'video', label: '视频轨', codec: v.codec,
        detail: (v.width && v.height ? v.width + '×' + v.height : '') + (v.codec ? '' : ''),
        width: v.width, height: v.height
      };
    }
    if (a) {
      return {
        ok: true, role: 'audio', label: '音频轨', codec: a.codec,
        detail: (a.channels ? a.channels + 'ch' : '') + (a.sampleRate ? ' ' + a.sampleRate + 'Hz' : ''),
        channels: a.channels, sampleRate: a.sampleRate
      };
    }
    return { ok: false, role: 'unknown', label: '未知' };
  }

  /* ---------------- 导出 ---------------- */

  root.Fmp4Merge = {
    inspect,
    mergeAv,
    classifyHead,
    parseBoxes,
    makeBox,
    concat,
    /* 便于测试/调试 */
    _internal: { readTrak, collectFragments, timelineSeconds, buildMvhd }
  };
})(typeof self !== 'undefined' ? self : globalThis);
