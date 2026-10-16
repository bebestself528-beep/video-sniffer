/* ============================================================
 * 视频嗅探下载器 - offscreen 下载引擎
 * 在 offscreen 文档中运行（有完整 DOM 与 Blob 能力）：
 *   解析播放列表 -> 下载分片(并发/解密/重试) -> 合并 -> (可选)转 MP4 -> 保存
 * ============================================================ */
(function () {
  'use strict';

  const tasks = new Map(); // taskId -> { abort }
  let idleTimer = null;

  /* ---------------- 工具 ---------------- */

  function send(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* ignore */ }
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function sanitizePath(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[.\s_]+|[.\s_]+$/g, '')
      .slice(0, 120);
  }

  async function fetchText(url, signal) {
    let sig = signal;
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout && AbortSignal.any) {
      sig = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    }
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: sig });
    if (!res.ok) throw new Error('获取播放列表失败：HTTP ' + res.status);
    const text = (await res.text()).replace(/^\uFEFF/, '');
    if (!/^#EXTM3U/.test(text.trim().slice(0, 200))) throw new Error('返回内容不是有效的 m3u8 播放列表');
    return text;
  }

  /* 空闲 3 分钟后自动关闭 offscreen 文档（任务运行中不关闭） */
  function scheduleClose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (tasks.size === 0) {
        try { window.close(); } catch (e) { /* ignore */ }
      }
    }, 3 * 60 * 1000);
  }

  /* ---------------- Blob 保存 ----------------
   * 注意——经测试，chromium 对「非 blob 创建方上下文」通过 downloads API 下载 blob URL 时
   * 会忽略自定义文件名（用 UUID 命名）。因此优先在 offscreen 内用锚点方式下载，
   * 其余路径作为兜底。saveMethod 可用于强制指定路径（调试用）。 */
  async function saveBlobToDisk(blob, target, finalName, saveMethod) {
    const blobUrl = URL.createObjectURL(blob);
    let downloadId = 0;
    let saveVia = '';

    const saveViaAnchor = () => {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = finalName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    const saveViaBg = async () => {
      const r = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'SAVE_BLOB',
        blobUrl,
        filename: target
      });
      if (!r || !r.downloadId) throw new Error((r && r.error) || '后台保存失败');
      return r.downloadId;
    };

    try {
      if (saveMethod === 'bg') {
        downloadId = await saveViaBg();
        saveVia = 'background-downloads';
      } else if (saveMethod === 'offscreen') {
        if (!chrome.downloads || !chrome.downloads.download) throw new Error('offscreen 环境无 downloads API');
        downloadId = await chrome.downloads.download({
          url: blobUrl, filename: target, conflictAction: 'uniquify', saveAs: false
        });
        saveVia = 'offscreen-downloads';
      } else {
        /* auto：优先锚点方式（可正确保留文件名），随后向后台确认下载确实已创建；
           若确认失败（个别环境不支持）则退回后台 downloads 方式（文件名会退化为 UUID） */
        try {
          saveViaAnchor();
          let confirmed = false;
          for (let i = 0; i < 6 && !confirmed; i++) {
            await new Promise((r) => setTimeout(r, 400));
            try {
              const v = await chrome.runtime.sendMessage({
                target: 'background',
                type: 'VERIFY_BLOB_DOWNLOAD',
                blobUrl
              });
              if (v && v.found) confirmed = true;
            } catch (eV) {
              confirmed = true; /* 无法确认时信任锚点，避免重复下载 */
            }
          }
          if (confirmed) {
            saveVia = 'anchor';
          } else {
            downloadId = await saveViaBg();
            saveVia = 'background-downloads';
          }
        } catch (eA) {
          downloadId = await saveViaBg();
          saveVia = 'background-downloads';
        }
      }
    } finally {
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ } }, 120000);
    }
    return { downloadId, saveVia };
  }

  /* ---------------- 单文件下载任务（用于"直接下载被防盗链拦截"时的回退）
   * 通过扩展 fetch 下载（declarativeNetRequest 可注入 Referer），流式读入内存后保存 */
  async function startFileTask(msg) {
    const taskId = msg.taskId;
    const abort = new AbortController();
    tasks.set(taskId, { abort });
    const startedAt = Date.now();
    let lastNotify = 0;
    let lastBytes = 0;
    let lastBytesTime = Date.now();
    let speed = 0;

    function report(patch, force) {
      const now = Date.now();
      if (!force && now - lastNotify < 500) return;
      lastNotify = now;
      if (patch.bytes != null) {
        const dt = now - lastBytesTime;
        if (dt >= 300) {
          const inst = (patch.bytes - lastBytes) / (dt / 1000);
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
          lastBytes = patch.bytes;
          lastBytesTime = now;
        }
      }
      send({
        target: 'background',
        type: 'TASK_UPDATE',
        task: Object.assign({
          id: taskId,
          url: msg.url,
          name: msg.name || 'video',
          startedAt,
          elapsed: now - startedAt,
          speed: Math.round(speed)
        }, patch, { speed: Math.round(speed) })
      });
    }

    try {
      report({ status: 'running', phase: '下载文件（携带 Referer 重试）', done: 0, total: 0, bytes: 0 }, true);

      let sig = abort.signal;
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout && AbortSignal.any) {
        sig = AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60 * 1000)]);
      }
      const res = await fetch(msg.url, { credentials: 'include', cache: 'no-store', signal: sig });
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      const chunks = [];
      let bytes = 0;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          bytes += value.byteLength;
          report({ phase: '下载文件（携带 Referer 重试）', bytes, total });
        }
      } else {
        const buf = await res.arrayBuffer();
        chunks.push(new Uint8Array(buf));
        bytes = buf.byteLength;
      }

      const mime = res.headers.get('content-type') || 'application/octet-stream';
      const blob = new Blob(chunks, { type: mime.split(';')[0].trim() });
      report({ phase: '保存文件', bytes, total }, true);

      const finalName = sanitizePath(msg.filename || msg.name || 'file');
      const saved = await saveBlobToDisk(blob, finalName, finalName, msg.saveMethod || 'auto');

      report({
        status: 'done',
        phase: '已完成（自动重试成功）',
        sizeStr: fmtBytes(blob.size),
        downloadId: saved.downloadId,
        saveVia: saved.saveVia,
        bytes,
        total: bytes
      }, true);
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      report({
        status: aborted ? 'canceled' : 'error',
        phase: aborted ? '已取消' : '失败',
        error: aborted ? '' : String((e && e.message) || e)
      }, true);
    } finally {
      tasks.delete(taskId);
      scheduleClose();
    }
  }

  /* ---------------- 音视频轨合并下载 ----------------
   * 用于 DASH 架构的站点（如哔哩哔哩）：视频轨与音频轨是两条独立流，
   * 分别下载会得到"有画面没声音"和"有声音没画面"两个文件。
   * 这里把两条流都拉下来，在本地合成一个双轨 MP4 再保存。 */

  /* 带超时的信号 */
  function anyTimeout(signal, ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout && AbortSignal.any) {
      return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    }
    return signal;
  }

  /* 流式下载为 Uint8Array，边读边回调进度 */
  async function fetchToBuffer(url, signal, onProgress) {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + '（' + url.slice(0, 80) + '）');
    const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    const chunks = [];
    let bytes = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytes += value.byteLength;
        if (onProgress) onProgress(bytes, total);
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      bytes = buf.byteLength;
      if (onProgress) onProgress(bytes, buf.byteLength);
    }
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return { data: out, total: total || n };
  }

  function concatParts(parts) {
    let n = 0;
    for (const p of parts) n += p.byteLength;
    const out = new Uint8Array(n);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
  }

  function looksLikeM3u8(data) {
    if (!data || data.length < 7) return false;
    for (let i = 0; i < 7; i++) if (data[i] !== '#EXTM3U'.charCodeAt(i)) return false;
    return true;
  }

  /* 纯音频轨的落盘后缀：同样是 ftyp 容器，音频用 .m4a 更贴切，
     系统与播放器也会据此选对解码器。 */
  function audioExtOf(data) {
    const c = containerExtOf(data);
    return c === 'mp4' ? 'm4a' : c;
  }

  /* 按内容判断容器，用于决定落盘后缀与 MIME。
     合并产物的容器取决于源轨：VP9/Opus 的轨合并出来是 WebM，不能硬写 .mp4 ——
     后缀骗人的话播放器与系统都会用错的解码器去打开。 */
  function containerExtOf(data) {
    if (!data || data.length < 8) return 'mp4';
    if (data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3) return 'webm';
    if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return 'mp4';
    if (data[0] === 0x47) return 'ts';
    if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return 'mp3';
    return 'mp4';
  }

  /* 把一份 HLS 清单展开成「一条完整轨道」的字节流。
     合并的两侧都可能是清单而不是文件 —— 主流 HLS 用
       #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",URI="audio/index.m3u8"
     把声音拆成独立 playlist，画面 variant 本身不含声音。不展开就永远合不出声音。
       · fMP4 形态（有 EXT-X-MAP）：init 段 + 各分片按序拼接，就是 mergeAv 认的 fMP4 轨
       · TS 形态：交给 mux.js 转封装成 fMP4
     这样无论站点用哪种分片格式，合并链路最终都统一在 fMP4 上。 */
  async function expandHls(text, url, signal, onProgress) {
    const parsed = HLSKit.parsePlaylist(text, url);
    if (parsed.kind === 'master') {
      throw new Error('该地址是主播放列表（含多个清晰度），不是单条轨道');
    }
    const dl = await HLSKit.downloadAll(parsed, {
      signal,
      onProgress: (p) => { if (onProgress) onProgress(p.bytes, 0); }
    });
    const parts = dl.initParts.concat(dl.segments).filter((p) => p && p.byteLength);
    if (!parts.length) throw new Error('播放列表里没有可用的分片数据');
    const firstSeg = dl.segments.find((p) => p && p.byteLength);
    if (firstSeg && HLSKit.isTsData(firstSeg)) {
      const mux = (typeof muxjs !== 'undefined' && muxjs) ? muxjs : null;
      return concatParts(dl.initParts.concat(HLSKit.transmuxTsToMp4(mux, dl.segments)));
    }
    return concatParts(parts);
  }

  /* 统一入口：一条轨可能是单个文件，也可能是一份 HLS 清单。
     不能只看 URL 后缀 —— HLS 音频组地址常常没有后缀，只能看内容。 */
  async function fetchTrack(url, signal, onProgress) {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + '（' + url.slice(0, 80) + '）');

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (/mpegurl/.test(ct) || /\.m3u8?(?:$|[?#])/i.test(url)) {
      return { data: await expandHls(await res.text(), url, signal, onProgress), total: 0 };
    }

    const reader = (res.body && res.body.getReader) ? res.body.getReader() : null;
    if (!reader) {
      const data = new Uint8Array(await res.arrayBuffer());
      if (looksLikeM3u8(data)) {
        return { data: await expandHls(new TextDecoder('utf-8').decode(data), url, signal, onProgress), total: 0 };
      }
      if (onProgress) onProgress(data.byteLength, data.byteLength);
      return { data, total: data.byteLength };
    }

    const declared = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    const chunks = [];
    let bytes = 0;
    let peeked = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!peeked && value && value.byteLength) {
        peeked = true;
        /* 服务器把清单标成 text/plain 或 octet-stream 时，只能靠内容认出来 */
        if (looksLikeM3u8(value)) {
          try { reader.cancel(); } catch (e) { /* ignore */ }
          const again = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
          return { data: await expandHls(await again.text(), url, signal, onProgress), total: 0 };
        }
      }
      chunks.push(value);
      bytes += value.byteLength;
      if (onProgress) onProgress(bytes, declared);
    }
    return { data: concatParts(chunks), total: declared || bytes };
  }

  /* 一条轨由一串分片组成（DASH 的多数形态：init 段 + N 个 media 段）。
     逐段取回按序拼接，就是一条完整轨道 —— 与 MSE 里 appendBuffer 的顺序一致。
     TS 分片（老式 DASH profile / 部分 HLS）拼出来是裸 TS 流，交给 mux.js 转封装。 */
  async function fetchParts(parts, initUrl, signal, onProgress) {
    const all = (initUrl ? [initUrl] : []).concat(parts || []);
    if (!all.length) throw new Error('这条轨没有任何分片地址');
    const got = [];
    let bytes = 0;
    for (let i = 0; i < all.length; i++) {
      const probe = await fetchTrack(all[i], signal, null);
      got.push(probe.data);
      bytes += probe.data.byteLength;
      if (onProgress) onProgress(bytes, 0, i + 1, all.length);
    }
    /* TS 判定看第一个分片的首字节（0x47 = 'G'，TS 包同步字节） */
    const first = got.find((p) => p && p.byteLength);
    if (first && first[0] === 0x47 && HLSKit && HLSKit.transmuxTsToMp4) {
      const mux = (typeof muxjs !== 'undefined' && muxjs) ? muxjs : null;
      return { data: concatParts(HLSKit.transmuxTsToMp4(mux, got)), total: bytes };
    }
    return { data: concatParts(got), total: bytes };
  }

  /* 一条轨的「取数规格」：
     - 字符串        → 单个文件或一份清单（老路径）
     - { parts, initUrl } → 一串分片（DASH / 展开后的清单）
     返回值统一是 { data, total }，调用方不必关心来源形态。 */
  async function fetchTrackSpec(spec, signal, onProgress) {
    if (!spec) return null;
    if (typeof spec === 'string') return fetchTrack(spec, signal, onProgress);
    if (Array.isArray(spec)) return fetchParts(spec, '', signal, onProgress);
    if (spec.url && !spec.parts) return fetchTrack(spec.url, signal, onProgress);
    return fetchParts(spec.parts || [], spec.initUrl || '', signal, onProgress);
  }

  /* spec 对应的代表地址，用于任务里显示与错误信息 */
  function specLabel(spec) {
    if (!spec) return '';
    if (typeof spec === 'string') return spec;
    if (Array.isArray(spec)) return spec[0] || '';
    return spec.url || (spec.parts && spec.parts[0]) || spec.initUrl || '';
  }

  async function startMergeTask(msg) {
    const taskId = msg.taskId;
    const abort = new AbortController();
    tasks.set(taskId, { abort });

    const startedAt = Date.now();
    let lastNotify = 0;
    let lastBytes = 0;
    let lastBytesTime = Date.now();
    let speed = 0;

    function report(patch, force) {
      const now = Date.now();
      if (!force && now - lastNotify < 500) return;
      lastNotify = now;
      if (patch.bytes != null) {
        const dt = now - lastBytesTime;
        if (dt >= 300) {
          const inst = (patch.bytes - lastBytes) / (dt / 1000);
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
          lastBytes = patch.bytes;
          lastBytesTime = now;
        }
      }
      send({
        target: 'background',
        type: 'TASK_UPDATE',
        task: Object.assign({
          id: taskId,
          url: specLabel(msg.videoSpec || msg.videoUrl),
          name: msg.name || 'video',
          startedAt,
          elapsed: now - startedAt,
          merged: true
        }, patch, { speed: Math.round(speed) })
      });
    }

    try {
      const sig = anyTimeout(abort.signal, 40 * 60 * 1000);
      const vSpec = msg.videoSpec || msg.videoUrl;
      const aSpec = msg.audioSpec || msg.audioUrl;
      if (!aSpec) throw new Error('没有可合并的音频轨');

      /* 1. 视频轨（单文件 / HLS 清单 / 一串 DASH 分片 —— 由 fetchTrackSpec 统一处理） */
      report({ status: 'running', phase: '下载视频轨', done: 0, total: 0, bytes: 0 }, true);
      const v = await fetchTrackSpec(vSpec, sig, (bytes, total) => {
        report({ phase: '下载视频轨', bytes, total });
      });

      /* 2. 音频轨 */
      report({ phase: '下载音频轨', done: 1, total: 2, bytes: v.data.length }, true);
      const a = await fetchTrackSpec(aSpec, sig, (bytes) => {
        report({ phase: '下载音频轨', done: 1, total: 2, bytes: v.data.length + bytes });
      });

      /* 3. 合并 */
      report({ phase: '合并视频轨与音频轨', done: 2, total: 2, bytes: v.data.length + a.data.length }, true);
      let out = null;
      let note = '';
      let fallback = false;

      const describe = (r) => {
        const bits = [];
        if (r.video) {
          if (r.video.codec) bits.push(r.video.codec);
          if (r.video.width && r.video.height) bits.push(r.video.width + '×' + r.video.height);
        }
        if (r.audio) {
          if (r.audio.codec) bits.push(r.audio.codec);
          if (r.audio.channels) bits.push(r.audio.channels + 'ch');
        }
        return bits.length ? '（' + bits.join(' / ') + '）' : '';
      };

      /* 两条轨可能是 ISO BMFF（fMP4），也可能是 WebM —— 取决于站点用的编码
         （YouTube 的 VP9/Opus 就是 WebM）。按容器各试一次，哪个认得出用哪个；
         都不认就退化为分别保存，绝不静默产出坏文件。 */
      const mergers = [];
      if (typeof Fmp4Merge !== 'undefined' && Fmp4Merge) mergers.push({ name: 'MP4', fn: Fmp4Merge.mergeAv });
      if (typeof WebmMerge !== 'undefined' && WebmMerge) mergers.push({ name: 'WebM', fn: WebmMerge.mergeAv });
      const failures = [];
      for (const m of mergers) {
        try {
          const r = m.fn(v.data, a.data);
          out = r.data;
          note = (r.note || '已合并音视频轨') + describe(r);
          break;
        } catch (eTry) {
          failures.push(m.name + '：' + String((eTry && eTry.message) || eTry));
        }
      }
      if (!out) {
        fallback = true;
        out = v.data;
        note = '音视频合并失败（' + failures.join('；') + '），已单独保存视频轨';
      }

      const outExt = containerExtOf(out);
      const outMime = outExt === 'webm' ? 'video/webm' : (outExt === 'ts' ? 'video/mp2t' : 'video/mp4');
      const blob = new Blob([out], { type: outMime });

      report({ phase: '保存文件', bytes: v.data.length + a.data.length }, true);
      const finalName = sanitizePath(msg.name || 'video') + '.' + outExt;
      const folder = sanitizePath(msg.folder || '');
      const target = (folder ? folder + '/' : '') + finalName;
      const saved = await saveBlobToDisk(blob, target, finalName, msg.saveMethod || 'auto');

      /* 合并失败时把音频轨也单独存下来（两份文件都在，用户可自行用工具合并，不至于丢数据） */
      let audioSavedName = '';
      if (fallback && a.data && a.data.length) {
        try {
          const aExt = audioExtOf(a.data);
          const aName = sanitizePath(msg.name || 'video') + '.audio.' + aExt;
          const aTarget = (folder ? folder + '/' : '') + aName;
          const aMime = aExt === 'webm' ? 'audio/webm' : (aExt === 'mp3' ? 'audio/mpeg' : (aExt === 'ts' ? 'video/mp2t' : 'audio/mp4'));
          const aBlob = new Blob([a.data], { type: aMime });
          await saveBlobToDisk(aBlob, aTarget, aName, msg.saveMethod || 'auto');
          audioSavedName = aName;
          note += '；音频轨已另存为 ' + aName;
        } catch (eAudio) {
          note += '；音频轨另存失败（' + String((eAudio && eAudio.message) || eAudio) + '）';
        }
      }

      report({
        status: 'done',
        phase: fallback ? (audioSavedName ? '已完成（视频轨 + 音频轨分别保存）' : '已完成（仅视频轨）') : '已完成（音视频已合并）',
        sizeStr: fmtBytes(out.length),
        note,
        bytes: v.data.length + a.data.length,
        total: v.data.length + a.data.length,
        downloadId: saved.downloadId,
        saveVia: saved.saveVia,
        mergedOk: !fallback
      }, true);
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      report({
        status: aborted ? 'canceled' : 'error',
        phase: aborted ? '已取消' : '失败',
        error: aborted ? '' : String((e && e.message) || e)
      }, true);
    } finally {
      tasks.delete(taskId);
      scheduleClose();
    }
  }

  /* 单独下载一条「由多分片组成」的轨（DASH 音频轨等）：
     分片取回拼接后按内容判容器落盘。 */
  async function startPartsTask(msg) {
    const taskId = msg.taskId;
    const abort = new AbortController();
    tasks.set(taskId, { abort });

    const startedAt = Date.now();
    let lastNotify = 0;
    let lastBytes = 0;
    let lastBytesTime = Date.now();
    let speed = 0;
    const label = msg.url || (msg.parts && msg.parts[0]) || '';

    function report(patch, force) {
      const now = Date.now();
      if (!force && now - lastNotify < 500) return;
      lastNotify = now;
      if (patch.bytes != null) {
        const dt = now - lastBytesTime;
        if (dt >= 300) {
          const inst = (patch.bytes - lastBytes) / (dt / 1000);
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
          lastBytes = patch.bytes;
          lastBytesTime = now;
        }
      }
      send({
        target: 'background',
        type: 'TASK_UPDATE',
        task: Object.assign({
          id: taskId,
          url: label,
          name: msg.name || 'audio',
          startedAt,
          elapsed: now - startedAt
        }, patch, { speed: Math.round(speed) })
      });
    }

    try {
      const sig = anyTimeout(abort.signal, 40 * 60 * 1000);
      const totalParts = (msg.parts || []).length + (msg.initUrl ? 1 : 0);
      report({ status: 'running', phase: '下载分片', done: 0, total: totalParts, bytes: 0 }, true);
      const got = await fetchParts(msg.parts || [], msg.initUrl || '', sig, (bytes, _t, done) => {
        report({ phase: '下载分片', bytes, done, total: totalParts });
      });

      let ext = msg.ext || containerExtOf(got.data);
      /* 纯音频轨即使容器是 mp4，也该叫 .m4a —— 播放器与系统据此选解码器 */
      if (!msg.ext && msg.kind === 'audio' && ext === 'mp4') ext = 'm4a';
      const mime = ext === 'webm' ? (msg.kind === 'audio' ? 'audio/webm' : 'video/webm')
        : ext === 'mp3' ? 'audio/mpeg'
          : ext === 'ts' ? 'video/mp2t'
            : ext === 'm4a' ? 'audio/mp4'
              : (msg.kind === 'audio' ? 'audio/mp4' : 'video/mp4');
      const blob = new Blob([got.data], { type: mime });
      report({ phase: '保存文件', bytes: got.data.length }, true);

      const finalName = sanitizePath(msg.name || 'audio') + '.' + ext;
      const folder = sanitizePath(msg.folder || '');
      const target = (folder ? folder + '/' : '') + finalName;
      const saved = await saveBlobToDisk(blob, target, finalName, msg.saveMethod || 'auto');

      report({
        status: 'done',
        phase: '已完成',
        sizeStr: fmtBytes(got.data.length),
        note: '已下载 ' + totalParts + ' 个分片并拼接为一条完整轨道',
        bytes: got.data.length,
        total: got.data.length,
        downloadId: saved.downloadId,
        saveVia: saved.saveVia
      }, true);
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      report({
        status: aborted ? 'canceled' : 'error',
        phase: aborted ? '已取消' : '失败',
        error: aborted ? '' : String((e && e.message) || e)
      }, true);
    } finally {
      tasks.delete(taskId);
      scheduleClose();
    }
  }

  /* ---------------- 任务执行 ---------------- */

  async function startTask(msg) {
    const taskId = msg.taskId;
    const abort = new AbortController();
    tasks.set(taskId, { abort });

    const startedAt = Date.now();
    let lastNotify = 0;
    let lastBytes = 0;
    let lastBytesTime = Date.now();
    let speed = 0;

    function report(patch, force) {
      const now = Date.now();
      if (!force && now - lastNotify < 500) return;
      lastNotify = now;
      const bytes = patch.bytes != null ? patch.bytes : undefined;
      if (bytes != null) {
        const dt = now - lastBytesTime;
        if (dt >= 300) {
          const inst = (bytes - lastBytes) / (dt / 1000);
          speed = speed ? speed * 0.6 + inst * 0.4 : inst;
          lastBytes = bytes;
          lastBytesTime = now;
        }
      }
      send({
        target: 'background',
        type: 'TASK_UPDATE',
        task: Object.assign({
          id: taskId,
          url: msg.url,
          name: msg.name || 'video',
          startedAt,
          elapsed: now - startedAt,
          speed: Math.round(speed)
        }, patch)
      });
    }

    try {
      /* 1. 解析播放列表（若为 master 自动选最高码率） */
      report({ status: 'running', phase: '解析播放列表', done: 0, total: 0, bytes: 0 }, true);
      let text = await fetchText(msg.url, abort.signal);
      let parsed = HLSKit.parsePlaylist(text, msg.url);

      if (parsed.kind === 'master') {
        const variants = parsed.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth);
        const chosen = variants[0];
        const label = chosen.resolution || (chosen.bandwidth ? Math.round(chosen.bandwidth / 1000) + 'kbps' : '默认清晰度');
        report({ phase: '解析清晰度（' + label + '）', note: '已选择最高清晰度：' + label }, true);
        text = await fetchText(chosen.url, abort.signal);
        parsed = HLSKit.parsePlaylist(text, chosen.url);
      }
      if (parsed.kind !== 'media') throw new Error('无法识别的播放列表类型');

      if (parsed.keyMethods && parsed.keyMethods.some((m) => m !== 'AES-128')) {
        throw new Error('该视频使用了 DRM 版权保护加密（' + parsed.keyMethods.join('/') + '），无法下载');
      }

      /* 2. 下载分片 */
      report({
        phase: '下载分片',
        total: parsed.segments.length,
        done: 0,
        live: !!parsed.isLive,
        duration: Math.round(parsed.totalDuration)
      }, true);

      const result = await HLSKit.downloadAll(parsed, {
        concurrency: msg.concurrency || 6,
        signal: abort.signal,
        onProgress: (p) => report({ phase: '下载分片', done: p.done, total: p.total, bytes: p.bytes })
      });

      /* 3. 合并 / 转封装 */
      report({ phase: '合并文件', done: parsed.segments.length, total: parsed.segments.length, bytes: result.totalBytes }, true);

      const segBufs = result.segments;
      const format = msg.format || 'auto';
      const wantMp4 = format !== 'ts';

      let finalParts = null;
      let ext = '';
      let mime = 'video/mp4';
      let note = '';

      const firstExt = HLSKit.sniffExt(segBufs[0]);
      const tsInput = HLSKit.isTsData(segBufs[0]);

      if (parsed.initSegment) {
        /* fMP4（EXT-X-MAP）：init + 分片直接拼接即有效 MP4 */
        finalParts = result.initParts.concat(segBufs);
        ext = 'mp4';
      } else if (tsInput && wantMp4 && typeof muxjs !== 'undefined' && muxjs && muxjs.mp4) {
        report({ phase: '转封装为 MP4' }, true);
        try {
          finalParts = HLSKit.transmuxTsToMp4(muxjs, segBufs);
          ext = 'mp4';
        } catch (e) {
          finalParts = null;
        }
      }

      if (!finalParts) {
        if (parsed.initSegment) {
          finalParts = result.initParts.concat(segBufs);
          ext = 'mp4';
        } else {
          finalParts = result.initParts.concat(segBufs);
          ext = tsInput ? 'ts' : (firstExt || 'ts');
          if (tsInput && wantMp4) note = '自动转 MP4 未成功，已输出 TS 文件（可用播放器直接播放）';
        }
      }
      if (ext === 'ts') mime = 'video/mp2t';
      else if (ext === 'webm') mime = 'video/webm';
      else if (parsed.initSegment || ext === 'mp4') mime = 'video/mp4';

      const blob = new Blob(finalParts, { type: mime });

      /* 4. 保存 */
      report({ phase: '保存文件' }, true);
      const finalName = sanitizePath((msg.name || 'video')) + '.' + ext;
      const folder = sanitizePath(msg.folder || '');
      const target = (folder ? folder + '/' : '') + finalName;
      const saved = await saveBlobToDisk(blob, target, finalName, msg.saveMethod || 'auto');
      const downloadId = saved.downloadId;
      const saveVia = saved.saveVia;

      report({
        status: 'done',
        phase: '已完成',
        sizeStr: fmtBytes(blob.size),
        note,
        downloadId,
        saveVia,
        live: !!parsed.isLive
      }, true);
    } catch (e) {
      const aborted = e && (e.name === 'AbortError');
      report({
        status: aborted ? 'canceled' : 'error',
        phase: aborted ? '已取消' : '失败',
        error: aborted ? '' : String((e && e.message) || e)
      }, true);
    } finally {
      tasks.delete(taskId);
      scheduleClose();
    }
  }

  /* ---------------- 消息入口 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || msg.target !== 'offscreen') return;

    if (msg.type === 'START_HLS') {
      /* 立即应答"任务已受理"，实际下载异步执行（进度由 TASK_UPDATE 上报），
         避免消息通道挂起（popup 关闭时也不会影响下载） */
      startTask(msg).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'FETCH_FILE') {
      /* 单文件下载（携带 Referer 的扩展 fetch）——用于直接下载被防盗链拦截时的回退 */
      startFileTask(msg).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'START_MERGE') {
      /* DASH 音视频分离：下载两条轨并在本地合并为一个 MP4 */
      startMergeTask(msg).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'START_PARTS') {
      /* 单独下载一条由多分片组成的轨（DASH 音频轨 / 纯音频清单） */
      startPartsTask(msg).catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'CANCEL') {
      const t = tasks.get(msg.taskId);
      if (t) t.abort.abort();
      sendResponse({ ok: true });
      return;
    }
  });

  scheduleClose();
})();
