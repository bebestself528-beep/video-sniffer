/* ============================================================
 * 视频嗅探下载器 - WebM / Matroska 音视频轨识别与合并
 * 纯逻辑模块，不依赖任何 Chrome API：
 *   - 在 offscreen 文档中运行（浏览器环境）
 *   - 在 Node 中运行（单元测试）
 * 挂载为全局：WebmMerge
 *
 * 【为什么需要它】
 * YouTube 这类站点默认给的是 VP9/AV1 画面 + Opus 声音，两条独立轨都是 WebM
 * 而不是 fMP4 —— fmp4merge 只认 ISO BMFF（ftyp/moov/moof），碰到 WebM 直接
 * 判失败。结果就是「视频轨和音频轨都下到了，却合不出一个带声音的文件」，
 * 和抖音那次是同一类问题，只是换了个容器。
 *
 * 【WebM 的结构与合并思路】
 *   EBML Header
 *   Segment
 *     Info   —— TimestampScale（一刻度多少纳秒）、Duration
 *     Tracks —— TrackEntry[]，每个含 TrackNumber / TrackUID / TrackType / CodecID
 *     Cluster[] —— Timestamp（绝对时间）+ SimpleBlock[]（带相对的轨道号与时间）
 *
 * 合并 = 把两边的 Tracks 合成一份（画面轨号 1、声音轨号 2），按 Cluster 的
 * 绝对时间戳交织两边的 Cluster，重写新 Segment。
 * 关键点：块的轨道号必须跟着改 —— 不改的话解码器会把音频块喂给画面解码器。
 * 块内轨道号是 vint 编码，1 与 2 都只需 1 字节，所以可以原地改写，所有元素
 * 长度不变，Cluster 可以整段原样搬运（无需重建，快且不会出错）。
 *
 * 取舍：SeekHead / Cues 里存的是绝对字节偏移，插入新 Tracks 后全部失效，
 * 因此这里直接丢弃它们（播放器会自行扫描定位，播放与拖动都正常）。
 * ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- EBML 元素 ID ---------------- */

  const ID_EBML = 0x1A45DFA3;
  const ID_SEGMENT = 0x18538067;
  const ID_SEEK_HEAD = 0x114D9B74;
  const ID_INFO = 0x1549A966;
  const ID_TIMESTAMP_SCALE = 0x2AD7B1;
  const ID_DURATION = 0x4489;
  const ID_TRACKS = 0x1654AE6B;
  const ID_TRACK_ENTRY = 0xAE;
  const ID_TRACK_NUMBER = 0xD7;
  const ID_TRACK_UID = 0x73C5;
  const ID_TRACK_TYPE = 0x83;
  const ID_CODEC_ID = 0x86;
  const ID_VIDEO = 0xE0;
  const ID_PIXEL_WIDTH = 0xB0;
  const ID_PIXEL_HEIGHT = 0xBA;
  const ID_AUDIO = 0xE1;
  const ID_SAMPLING_FREQ = 0xB5;
  const ID_CHANNELS = 0x9F;
  const ID_CLUSTER = 0x1F43B675;
  const ID_CLUSTER_TIME = 0xE7;
  const ID_SIMPLE_BLOCK = 0xA3;
  const ID_BLOCK_GROUP = 0xA0;
  const ID_BLOCK = 0xA1;
  const ID_CUES = 0x1C53BB6B;
  const ID_CHAPTERS = 0x1043A770;
  const ID_TAGS = 0x1254C367;
  const ID_ATTACHMENTS = 0x1941A469;

  const TRACK_TYPE_VIDEO = 1;
  const TRACK_TYPE_AUDIO = 2;

  /* ---------------- 基础读取 ---------------- */

  /* 元素 ID：首字节的前导零个数决定长度（1–4 字节）。ID 含标记位，原样比较。 */
  function readId(buf, pos) {
    if (pos >= buf.length) return null;
    const b = buf[pos];
    if (b === 0) return null;
    let len = 1;
    for (let mask = 0x80; mask && !(b & mask); mask >>= 1) len++;
    if (len > 4 || pos + len > buf.length) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = (id << 8 | buf[pos + i]) >>> 0;
    return { id, len };
  }

  /* 元素长度（vint）：首字节前导零个数决定长度，去掉标记位后的值才是长度。
     所有值位都为 1 表示「未知长度」（流式写入的 Segment 常见）。 */
  function readSize(buf, pos) {
    if (pos >= buf.length) return null;
    const b = buf[pos];
    if (b === 0) return null;
    let len = 1;
    for (let mask = 0x80; mask && !(b & mask); mask >>= 1) len++;
    if (pos + len > buf.length) return null;
    let value = b & (0xFF >> len);
    let allOnes = value === (0xFF >> len);
    for (let i = 1; i < len; i++) {
      value = value * 256 + buf[pos + i];
      if (buf[pos + i] !== 0xFF) allOnes = false;
    }
    return { size: value, len, unknown: allOnes };
  }

  /* 写出长度的 vint。留出「全 1」编码，避免被误读成未知长度。 */
  function writeSize(value) {
    let len = 1;
    while (len <= 8 && value >= Math.pow(2, 7 * len) - 1) len++;
    const out = new Uint8Array(len);
    let v = value;
    for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xFF; v = Math.floor(v / 256); }
    out[0] |= (0x80 >> (len - 1));
    return out;
  }

  /*
   * 未知长度元素的真实结束位置。
   * Matroska 规定「未知长度」元素一直延伸到「同级的下一个同类元素」为止（或文件末尾），
   * 而不是简单的一直到文件末尾。
   *
   * 这一条非常关键：MediaRecorder 等流式写入的文件里，Cluster 的长度字段常常是
   * 未知长度，而它后面还跟着别的 Cluster。如果一律按「到文件末尾」处理，第一个簇
   * 会把后面所有簇吞掉 —— 解析结果只有一个超长簇，合并时后面的内容整段消失
   * （实测：5.6 秒的录制品合并后只剩 3.97 秒）。
   */
  function scanUnknownEnd(buf, start, end, id) {
    let p = start;
    let guard = 0;
    while (p < end && guard++ < 200000) {
      const idr = readId(buf, p);
      if (!idr) break;
      if (idr.id === id) return p;             // 下一个同类元素 = 本元素到此结束
      const szr = readSize(buf, p + idr.len);
      if (!szr) break;
      if (szr.unknown) return end;             // 嵌套的未知长度：只能给到末尾
      const next = p + idr.len + szr.len + szr.size;
      if (next <= p) break;
      p = next;
    }
    return end;
  }

  /* 遍历 [start, end) 内的同级元素 */
  function children(buf, start, end) {
    const out = [];
    let p = start;
    let guard = 0;
    while (p < end && guard++ < 100000) {
      const idr = readId(buf, p);
      if (!idr) break;
      const szr = readSize(buf, p + idr.len);
      if (!szr) break;
      const dataStart = p + idr.len + szr.len;
      const dataEnd = szr.unknown
        ? scanUnknownEnd(buf, dataStart, end, idr.id)
        : Math.min(end, dataStart + szr.size);
      out.push({ id: idr.id, headStart: p, dataStart, dataEnd, size: szr.size, unknown: szr.unknown });
      if (szr.unknown && dataEnd >= end) break;
      if (dataEnd <= p) break;   // 防御：长度异常时避免死循环
      p = dataEnd;
    }
    return out;
  }

  function readUint(buf, start, end) {
    let v = 0;
    for (let i = start; i < end; i++) v = v * 256 + buf[i];
    return v;
  }

  function readFloat(buf, start, end) {
    const len = end - start;
    if (len === 4) {
      const dv = new DataView(buf.buffer, buf.byteOffset + start, 4);
      return dv.getFloat32(0, false);
    }
    if (len === 8) {
      const dv = new DataView(buf.buffer, buf.byteOffset + start, 8);
      return dv.getFloat64(0, false);
    }
    if (len === 0) return 0;
    return readUint(buf, start, end);   // 少数文件把浮点写成整数
  }

  function readString(buf, start, end) {
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
    return s;
  }

  function concat(list) {
    let n = 0;
    for (const p of list) n += p.length;
    const out = new Uint8Array(n);
    let off = 0;
    for (const p of list) { out.set(p, off); off += p.length; }
    return out;
  }

  function idToBytes(id) {
    const b = [];
    let x = id;
    while (x > 0) { b.unshift(x & 0xFF); x = Math.floor(x / 256); }
    return new Uint8Array(b);
  }

  function uintToBytes(v) {
    v = Math.max(0, Math.floor(v));
    if (v === 0) return new Uint8Array([0]);
    const out = [];
    while (v > 0) { out.unshift(v & 0xFF); v = Math.floor(v / 256); }
    return new Uint8Array(out);
  }

  function buildElement(id, data) {
    return concat([idToBytes(id), writeSize(data.length), data]);
  }

  function buildUintElement(id, value) {
    return buildElement(id, uintToBytes(value));
  }

  function buildFloatElement(id, value) {
    const d = new Uint8Array(8);
    new DataView(d.buffer).setFloat64(0, value, false);
    return buildElement(id, d);
  }

  /* ---------------- 结构解析 ---------------- */

  function isWebmHead(buf) {
    return buf && buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
  }

  function readTrackEntry(buf, entry) {
    const kids = children(buf, entry.dataStart, entry.dataEnd);
    const pick = (id) => kids.find((e) => e.id === id);
    const out = {
      entry,
      number: 0, uid: 0, type: 0, codec: '',
      width: 0, height: 0, channels: 0, sampleRate: 0
    };
    const num = pick(ID_TRACK_NUMBER);
    if (num) out.number = readUint(buf, num.dataStart, num.dataEnd);
    const uid = pick(ID_TRACK_UID);
    if (uid) out.uid = readUint(buf, uid.dataStart, uid.dataEnd);
    const type = pick(ID_TRACK_TYPE);
    if (type) out.type = readUint(buf, type.dataStart, type.dataEnd);
    const codec = pick(ID_CODEC_ID);
    if (codec) out.codec = readString(buf, codec.dataStart, codec.dataEnd);

    const v = pick(ID_VIDEO);
    if (v) {
      const vk = children(buf, v.dataStart, v.dataEnd);
      const w = vk.find((e) => e.id === ID_PIXEL_WIDTH);
      const h = vk.find((e) => e.id === ID_PIXEL_HEIGHT);
      if (w) out.width = readUint(buf, w.dataStart, w.dataEnd);
      if (h) out.height = readUint(buf, h.dataStart, h.dataEnd);
    }
    const a = pick(ID_AUDIO);
    if (a) {
      const ak = children(buf, a.dataStart, a.dataEnd);
      const ch = ak.find((e) => e.id === ID_CHANNELS);
      const sf = ak.find((e) => e.id === ID_SAMPLING_FREQ);
      if (ch) out.channels = readUint(buf, ch.dataStart, ch.dataEnd);
      if (sf) out.sampleRate = Math.round(readFloat(buf, sf.dataStart, sf.dataEnd));
    }
    return out;
  }

  /* 解析一份 WebM。requireClusters=false 时允许只有头部（用于预览/探测） */
  function parseFile(data, opts) {
    const buf = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    if (!isWebmHead(buf)) throw new Error('不是 WebM/Matroska 文件（缺少 EBML 头）');

    const top = children(buf, 0, buf.length);
    const ebmlEl = top.find((e) => e.id === ID_EBML);
    const segEl = top.find((e) => e.id === ID_SEGMENT);
    if (!segEl) throw new Error('不是 WebM/Matroska 文件（缺少 Segment）');

    const segKids = children(buf, segEl.dataStart, segEl.dataEnd);
    const infoEl = segKids.find((e) => e.id === ID_INFO);
    const tracksEl = segKids.find((e) => e.id === ID_TRACKS);
    const clusters = segKids.filter((e) => e.id === ID_CLUSTER);

    if (!tracksEl) throw new Error('WebM 文件里没有 Tracks 元素');
    if (!clusters.length && !(opts && opts.allowNoClusters)) {
      throw new Error('WebM 文件里没有媒体数据（Cluster）');
    }

    let timestampScale = 1000000;   // 默认 1ms
    let duration = 0;
    if (infoEl) {
      for (const e of children(buf, infoEl.dataStart, infoEl.dataEnd)) {
        if (e.id === ID_TIMESTAMP_SCALE) timestampScale = readUint(buf, e.dataStart, e.dataEnd) || 1000000;
        else if (e.id === ID_DURATION) duration = readFloat(buf, e.dataStart, e.dataEnd) || 0;
      }
    }

    const entries = children(buf, tracksEl.dataStart, tracksEl.dataEnd)
      .filter((e) => e.id === ID_TRACK_ENTRY)
      .map((e) => readTrackEntry(buf, e));

    return { buf, ebmlEl, segEl, infoEl, tracksEl, clusters, timestampScale, duration, entries };
  }

  function clusterTime(buf, cluster) {
    for (const c of children(buf, cluster.dataStart, cluster.dataEnd)) {
      if (c.id === ID_CLUSTER_TIME) return readUint(buf, c.dataStart, c.dataEnd);
      if (c.id === ID_SIMPLE_BLOCK || c.id === ID_BLOCK_GROUP) break;   // 时间戳应在块之前
    }
    return 0;
  }

  /* ---------------- 块的轨道号改写 ---------------- */

  /* 改写一个块（SimpleBlock / Block）头部的轨道号 vint。
     vint 长度不变时原地改即可 —— 1 与 2 都只需 1 字节，正常文件都满足。 */
  function patchBlockTrack(buf, pos, want) {
    const r = readSize(buf, pos);
    if (!r) throw new Error('WebM 块头损坏（读不出轨道号）');
    if (want >= Math.pow(2, 7 * r.len) - 1) {
      throw new Error('轨道号 ' + want + ' 超出块头 ' + r.len + ' 字节 vint 能表示的范围');
    }
    let v = want;
    for (let i = r.len - 1; i >= 0; i--) { buf[pos + i] = v & 0xFF; v = Math.floor(v / 256); }
    buf[pos] |= (0x80 >> (r.len - 1));
  }

  /*
   * 按时间分桶重切簇，让两轨真正交织。
   *
   * 为什么不能整簇搬运：MediaRecorder 之类的流式写入常常把整段录成一个簇
   * （我们实测 2.2 秒的录制品就是「1 个画面簇 + 1 个声音簇」，两个簇都覆盖
   * 全程）。这种文件整簇拼接等于「先播完 2 秒画面、再播 2 秒声音」，播放器
   * 会在靠近结尾处报解码错误。真实文件虽然簇更多，但同样是「一个簇里塞了
   * 一大段」，粗粒度交织也会让时间轴忽前忽后。
   *
   * 做法：把块按绝对时间分到 1 秒一个的桶里，每桶输出一个簇，簇内块的相对
   * 时间戳改写为「相对本簇」。画面只在关键帧处开新桶 —— 让簇首是非关键帧
   * 虽然合法，但会让拖动定位变得很糟。
   */

  const BUCKET_MS = 1000;      // 每个簇覆盖的时间
  const MAX_SPAN_MS = 30000;   // 兜底：块相对时间戳是 int16，别让它溢出

  /* 读一个块的头：轨道号 vint 长度、相对时间戳位置、是否关键帧 */
  function blockInfo(buf, pos) {
    const r = readSize(buf, pos);
    const len = r ? r.len : 1;
    const relPos = pos + len;
    let rel = (buf[relPos] << 8) | buf[relPos + 1];
    if (rel & 0x8000) rel -= 0x10000;
    const flags = buf[relPos + 2];
    return { len, rel, relPos, key: !!(flags & 0x80) };
  }

  function writeRel(buf, relPos, v) {
    const x = ((v % 65536) + 65536) % 65536;
    buf[relPos] = (x >> 8) & 0xFF;
    buf[relPos + 1] = x & 0xFF;
  }

  /* 从源簇里收集目标轨的块（顺带把块头轨道号改成 want）。 */
  function collectBlocks(buf, cluster, want, out) {
    const base = clusterTime(buf, cluster);
    for (const k of children(buf, cluster.dataStart, cluster.dataEnd)) {
      if (k.id === ID_SIMPLE_BLOCK) {
        const info = blockInfo(buf, k.dataStart);
        patchBlockTrack(buf, k.dataStart, want);
        out.push({ time: base + info.rel, el: k, info });
      } else if (k.id === ID_BLOCK_GROUP) {
        /* BlockGroup 是原子单位（含 BlockDuration / ReferenceBlock 等），整块搬运 */
        for (const g of children(buf, k.dataStart, k.dataEnd)) {
          if (g.id !== ID_BLOCK) continue;
          const info = blockInfo(buf, g.dataStart);
          patchBlockTrack(buf, g.dataStart, want);
          out.push({ time: base + info.rel, el: k, info });
          break;
        }
      }
    }
    return out;
  }

  /* 把收集到的块按时间分桶并输出成簇；返回 [{ time, bytes }] */
  function bucketize(buf, blocks, isVideo) {
    const sorted = blocks.slice().sort((a, b) => a.time - b.time);
    const buckets = [];
    let cur = null;

    for (const b of sorted) {
      const needNew = !cur ||
        (b.time - cur.start >= BUCKET_MS && (!isVideo || b.info.key)) ||
        (b.time - cur.start >= MAX_SPAN_MS);
      if (needNew) {
        cur = { start: b.time, items: [] };
        buckets.push(cur);
      }
      cur.items.push(b);
    }

    return buckets.map((bk) => {
      const parts = [buildUintElement(ID_CLUSTER_TIME, bk.start)];
      for (const it of bk.items) {
        writeRel(buf, it.info.relPos, it.time - bk.start);
        parts.push(buf.subarray(it.el.headStart, it.el.dataEnd));
      }
      return { time: bk.start, bytes: buildElement(ID_CLUSTER, concat(parts)) };
    });
  }

  /* 重建 TrackEntry：轨道号与 UID 换成新的，其余（CodecID/CodecPrivate/尺寸…）
     原样搬运。TrackNumber 与 TrackUID 按规范排在最前。
     注意必须用 0xAE 外壳包起来 —— 少了它，Tracks 里躺着的就是一串裸字段，
     解析器读不到任何 TrackEntry。 */
  function rebuildTrackEntry(buf, entry, newNumber, newUid) {
    const parts = [];
    for (const c of children(buf, entry.dataStart, entry.dataEnd)) {
      if (c.id === ID_TRACK_NUMBER || c.id === ID_TRACK_UID) continue;
      parts.push(buf.subarray(c.headStart, c.dataEnd));
    }
    return buildElement(ID_TRACK_ENTRY, concat([
      buildUintElement(ID_TRACK_NUMBER, newNumber),
      buildUintElement(ID_TRACK_UID, newUid)
    ].concat(parts)));
  }

  /*
   * 取出一个 Cluster 的完整字节（含头）。
   * bucketize 重建的簇头部自带正确长度，这里只用于「原样搬运」的场景。
   * 注意未知长度的簇不能直接搬：放到中间后它后面就再也解析不出来了，
   * 必须按实际内容重写长度。
   */
  function clusterBytes(buf, cluster) {
    if (!cluster.unknown) return buf.subarray(cluster.headStart, cluster.dataEnd);
    return buildElement(ID_CLUSTER, buf.subarray(cluster.dataStart, cluster.dataEnd));
  }

  /* 重建 Info：保留原有字段，但 Duration 换成合并后的真实时长 */
  function rebuildInfo(buf, infoEl, duration) {
    const parts = [];
    let hasScale = false;
    let hasDuration = false;
    if (infoEl) {
      for (const c of children(buf, infoEl.dataStart, infoEl.dataEnd)) {
        if (c.id === ID_DURATION) { hasDuration = true; continue; }
        if (c.id === ID_TIMESTAMP_SCALE) hasScale = true;
        parts.push(buf.subarray(c.headStart, c.dataEnd));
      }
    }
    if (!hasScale) parts.unshift(buildUintElement(ID_TIMESTAMP_SCALE, 1000000));
    if (duration > 0 || hasDuration) parts.push(buildFloatElement(ID_DURATION, duration > 0 ? duration : 0));
    return buildElement(ID_INFO, concat(parts));
  }

  /* 读块头里的相对时间戳（有符号 int16，紧跟轨道号 vint 之后） */
  function blockRelativeTime(buf, pos) {
    const r = readSize(buf, pos);
    const p = pos + (r ? r.len : 1);
    if (p + 2 > buf.length) return 0;
    let v = (buf[p] << 8) | buf[p + 1];
    if (v & 0x8000) v -= 0x10000;
    return v;
  }

  /* 走一遍所有簇里的块，用「簇时间戳 + 块相对时间戳」的最大值作为时长。
     流式写入的文件（MediaRecorder 录出来的）通常没有 Duration 字段，合并时
     必须自己算出来，否则播放器得扫完整段才知道总时长，进度条会一直显示未知。 */
  function trackDurationTicks(buf, parsed) {
    let maxT = 0;
    for (const c of parsed.clusters) {
      const base = clusterTime(buf, c);
      for (const k of children(buf, c.dataStart, c.dataEnd)) {
        if (k.id === ID_SIMPLE_BLOCK) {
          const t = base + blockRelativeTime(buf, k.dataStart);
          if (t > maxT) maxT = t;
        } else if (k.id === ID_BLOCK_GROUP) {
          for (const g of children(buf, k.dataStart, k.dataEnd)) {
            if (g.id === ID_BLOCK) {
              const t = base + blockRelativeTime(buf, g.dataStart);
              if (t > maxT) maxT = t;
            }
          }
        }
      }
    }
    return maxT;
  }

  /* ---------------- 合并 ---------------- */

  function mergeAv(videoData, audioData) {
    const V = parseFile(videoData);
    const A = parseFile(audioData);

    const vTrack = V.entries.find((e) => e.type === TRACK_TYPE_VIDEO);
    const aTrack = A.entries.find((e) => e.type === TRACK_TYPE_AUDIO);
    if (!vTrack) throw new Error('第一个文件里没有视频轨（TrackType != 1）');
    if (!aTrack) throw new Error('第二个文件里没有音频轨（TrackType != 2）');
    if (V.timestampScale !== A.timestampScale) {
      throw new Error('两个文件的时间基准不同（' + V.timestampScale + ' 与 ' + A.timestampScale +
        ' 纳秒/刻度），无法直接合并');
    }

    /* 复制一份再改写：块头是原地修改的，不能动调用方传进来的数组 */
    const vBuf = new Uint8Array(V.buf);
    const aBuf = new Uint8Array(A.buf);

    /* 两轨各自按时间分桶重切簇，块头轨道号同步改成 1（画面）/ 2（声音） */
    const vBlocks = [];
    for (const c of V.clusters) collectBlocks(vBuf, c, 1, vBlocks);
    const aBlocks = [];
    for (const c of A.clusters) collectBlocks(aBuf, c, 2, aBlocks);
    if (!vBlocks.length) throw new Error('画面轨里没有找到数据块');
    if (!aBlocks.length) throw new Error('声音轨里没有找到数据块');

    const vClusters = bucketize(vBuf, vBlocks, true);
    const aClusters = bucketize(aBuf, aBlocks, false);

    /* 按簇起始时间交织两轨 */
    const merged = [];
    let i = 0, j = 0;
    while (i < vClusters.length || j < aClusters.length) {
      const vt = i < vClusters.length ? vClusters[i].time : Infinity;
      const at = j < aClusters.length ? aClusters[j].time : Infinity;
      if (vt <= at) merged.push(vClusters[i++].bytes);
      else merged.push(aClusters[j++].bytes);
    }

    const tracks = buildElement(ID_TRACKS, concat([
      rebuildTrackEntry(V.buf, vTrack.entry, 1, 1),
      rebuildTrackEntry(A.buf, aTrack.entry, 2, 2)
    ]));

    /* 时长取「两边声明的时长」与「按块实测的时长」中的最大值：
       视频与音频轨常常差几百毫秒，取小的会让播放器提前结束。 */
    const scale = V.timestampScale || 1000000;
    const seconds = Math.max(
      V.duration * scale / 1e9,
      A.duration * A.timestampScale / 1e9,
      trackDurationTicks(V.buf, V) * scale / 1e9,
      trackDurationTicks(A.buf, A) * A.timestampScale / 1e9
    );
    const durationTicks = Math.round(seconds * 1e9 / scale);
    const info = rebuildInfo(V.buf, V.infoEl, durationTicks);

    /* EBML 头原样保留 */
    const ebml = V.buf.subarray(V.ebmlEl.headStart, V.ebmlEl.dataEnd);
    const segment = buildElement(ID_SEGMENT, concat([info, tracks].concat(merged)));
    const out = concat([ebml, segment]);

    const note = '已合并 WebM 双轨（' + vClusters.length + ' 个画面簇 + ' + aClusters.length + ' 个声音簇）';
    return {
      data: out,
      note,
      video: { codec: vTrack.codec, width: vTrack.width, height: vTrack.height },
      audio: { codec: aTrack.codec, channels: aTrack.channels, sampleRate: aTrack.sampleRate }
    };
  }

  /* ---------------- 轨道识别（供 UI 显示"视频轨/音频轨"） ---------------- */

  function probe(data) {
    const buf = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    if (!isWebmHead(buf)) return { ok: false, role: 'unknown', label: '未知' };
    let f;
    try {
      f = parseFile(buf, { allowNoClusters: true });
    } catch (e) {
      return { ok: false, role: 'unknown', label: '未知' };
    }
    const v = f.entries.find((e) => e.type === TRACK_TYPE_VIDEO);
    const a = f.entries.find((e) => e.type === TRACK_TYPE_AUDIO);
    if (v && a) {
      return {
        ok: true, role: 'both', label: '音视频', codec: v.codec,
        detail: v.width + '×' + v.height, width: v.width, height: v.height,
        container: 'webm'
      };
    }
    if (v) {
      return {
        ok: true, role: 'video', label: '视频轨', codec: v.codec,
        detail: v.width + '×' + v.height, width: v.width, height: v.height,
        container: 'webm'
      };
    }
    if (a) {
      const bits = [];
      if (a.channels) bits.push(a.channels + 'ch');
      if (a.sampleRate) bits.push(a.sampleRate + 'Hz');
      return {
        ok: true, role: 'audio', label: '音频轨', codec: a.codec,
        detail: bits.join(' '), channels: a.channels, sampleRate: a.sampleRate,
        container: 'webm'
      };
    }
    return { ok: false, role: 'unknown', label: '未知' };
  }

  /* ---------------- 导出 ---------------- */

  root.WebmMerge = {
    isWebmHead,
    parseFile,
    probe,
    mergeAv,
    readId,
    readSize,
    readUint,
    readFloat,
    writeSize,
    children,
    buildElement,
    clusterTimestamp: clusterTime,
    ID: {
      EBML: ID_EBML, SEGMENT: ID_SEGMENT, INFO: ID_INFO, TRACKS: ID_TRACKS,
      TRACK_ENTRY: ID_TRACK_ENTRY, CLUSTER: ID_CLUSTER,
      CLUSTER_TIME: ID_CLUSTER_TIME, SIMPLE_BLOCK: ID_SIMPLE_BLOCK, BLOCK_GROUP: ID_BLOCK_GROUP,
      BLOCK: ID_BLOCK
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
