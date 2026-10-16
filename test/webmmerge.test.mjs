/* ============================================================
 * WebM 音视频轨识别与合并测试
 * 运行：node test/webmmerge.test.mjs
 *
 * 用真实的 WebM 字节验证（不靠手写假数据）：
 *   [1] 在无头 Chrome 里用 MediaRecorder 现场录制
 *       —— 画面：canvas 逐帧动画 → video/webm（VP8）
 *       —— 声音：振荡器 → audio/webm（Opus）
 *   [2] 两条轨分别解析：容器识别、轨道数、TrackType、编解码器、尺寸/声道
 *   [3] mergeAv 合并 → 结构校验（两个 TrackEntry、块轨道号已重写、时间戳有序）
 *   [4] 把合并结果丢回 Chrome 播放，验证画面与声音都真的解码出来
 *
 * 这一套覆盖的是 YouTube 这类「VP9/AV1 + Opus，两条独立 WebM 轨」的站点 ——
 * fmp4merge 只认 ISO BMFF，碰到 WebM 会直接失败，于是出现「轨都下到了却合不出声音」。
 * 环境变量：CHROME_PATH 可指定浏览器路径
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9388;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = readFileSync(join(ROOT, 'lib', 'webmmerge.js'), 'utf8');
const sb = { self: undefined, console };
new Function('self', 'globalThis', src + '\n;return self;')(sb, sb);
const WebmMerge = sb.WebmMerge || globalThis.WebmMerge;
if (!WebmMerge) { console.error('✗ 无法加载 lib/webmmerge.js'); process.exit(1); }

let pass = 0, fail = 0;
function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, why) { fail++; console.error('  ✗ ' + name + '\n      ' + (why && (why.stack || why.message) || why)); }

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.nextId = 1; this.pending = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => {
        this.ws.onmessage = (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.id && this.pending.has(m.id)) {
            const { res: r, rej: j } = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) j(new Error(JSON.stringify(m.error))); else r(m.result);
          }
        };
        res();
      };
      this.ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
      this.ws.onclose = () => { for (const { rej: j } of this.pending.values()) j(new Error('CDP 连接关闭')); this.pending.clear(); };
    });
  }
  send(method, params, sessionId) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 90000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function ev(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result.value;
}

/* ---------------- 录制页：现场生成真实的 WebM 双轨 ---------------- */

const RECORDER_HTML = `<!doctype html><meta charset="utf-8"><title>webm recorder</title>
<body style="font:14px sans-serif">
<canvas id="cv" width="192" height="144"></canvas>
<video id="v" playsinline style="width:192px"></video>
<script>
window.__rec = function () {
  return (async function () {
    var pick = function (list) {
      for (var i = 0; i < list.length; i++) {
        try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
      }
      return '';
    };
    var vmime = pick(['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']);
    var amime = pick(['audio/webm;codecs=opus', 'audio/webm']);
    if (!vmime || !amime) return { error: '浏览器不支持 MediaRecorder WebM（v=' + vmime + ' a=' + amime + '）' };

    var toB64 = function (blob) {
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result).split(',')[1]); };
        fr.onerror = function () { rej(new Error('读取 Blob 失败')); };
        fr.readAsDataURL(blob);
      });
    };

    var cv = document.getElementById('cv');
    var ctx = cv.getContext('2d');
    var n = 0;
    var vStream = cv.captureStream(0);
    var vTrack = vStream.getVideoTracks()[0];
    var drawTimer = setInterval(function () {
      ctx.fillStyle = 'hsl(' + ((n * 15) % 360) + ',70%,45%)';
      ctx.fillRect(0, 0, 192, 144);
      ctx.fillStyle = '#fff';
      ctx.fillRect(10 + ((n * 4) % 130), 40, 40, 60);
      n++;
      try { if (vTrack.requestFrame) vTrack.requestFrame(); } catch (e) {}
    }, 40);

    var ac = new (window.AudioContext || window.webkitAudioContext)();
    var dest = ac.createMediaStreamDestination();
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    gain.gain.value = 0.35;
    osc.frequency.value = 440;
    osc.connect(gain); gain.connect(dest);
    osc.start();
    if (ac.state === 'suspended') { try { await ac.resume(); } catch (e) {} }

    var record = function (stream, mime, ms) {
      return new Promise(function (res, rej) {
        var chunks = [];
        var rec;
        try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
        catch (e) { rej(new Error('MediaRecorder 创建失败: ' + e.message)); return; }
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onerror = function (e) { rej(new Error('录制出错: ' + (e.error && e.error.name))); };
        rec.onstop = function () { res(new Blob(chunks, { type: mime || 'video/webm' })); };
        rec.start(250);
        setTimeout(function () { try { rec.stop(); } catch (e) {} }, ms);
      });
    };

    var vBlob = await record(vStream, vmime, 5600);
    var aBlob = await record(dest.stream, amime, 5600);
    clearInterval(drawTimer);
    try { osc.stop(); } catch (e) {}
    try { ac.close(); } catch (e) {}

    return {
      vmime: vmime, amime: amime,
      vsize: vBlob.size, asize: aBlob.size,
      v: await toB64(vBlob), a: await toB64(aBlob)
    };
  })();
};
<\/script></body>`;

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'webmtest-'));
  let server = null, chrome = null, cdp = null;

  try {
    /* ---------------- 本地服务：录制页 + 合并结果回放 ---------------- */
    const merged = { data: null };
    server = createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u === '/' || u === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(RECORDER_HTML);
      } else if (u === '/merged.webm') {
        if (!merged.data) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': merged.data.length });
        res.end(Buffer.from(merged.data));
      } else if (u === '/vonly.webm') {
        if (!merged.vonly) { res.writeHead(404); res.end('no'); return; }
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': merged.vonly.length });
        res.end(Buffer.from(merged.vonly));
      } else {
        res.writeHead(404); res.end('404');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = 'http://127.0.0.1:' + port;

    /* ---------------- 启动无头 Chrome ---------------- */
    console.log('\n[1] 启动无头 Chrome，用 MediaRecorder 现场录制真实 WebM 双轨');
    const prof = mkdtempSync(join(tmp, 'prof-'));
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + prof, base + '/'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let ws = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { ws = (await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json()).webSocketDebuggerUrl; break; } catch (e) { /* retry */ }
    }
    if (!ws) throw new Error('浏览器未就绪');
    cdp = new CDP(ws); await cdp.connect();
    const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page' && t.url.indexOf('127.0.0.1') >= 0);
    if (!page) throw new Error('未找到录制页');
    const sid = (await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sid);
    await sleep(1500);

    const rec = await ev(cdp, sid, 'window.__rec()');
    if (!rec || rec.error) throw new Error('录制失败: ' + (rec && rec.error));

    const videoOnly = new Uint8Array(Buffer.from(rec.v, 'base64'));
    const audioOnly = new Uint8Array(Buffer.from(rec.a, 'base64'));
    ok('录制完成：画面轨 ' + rec.vmime + ' ' + (rec.vsize / 1024).toFixed(0) + ' KB' +
       '，声音轨 ' + rec.amime + ' ' + (rec.asize / 1024).toFixed(0) + ' KB');

    /* 固化样本，便于人工复核与后续回归 */
    const fixDir = join(ROOT, 'test', 'fixtures', 'webm');
    if (!existsSync(fixDir)) mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, 'rec_video_only.webm'), videoOnly);
    writeFileSync(join(fixDir, 'rec_audio_only.webm'), audioOnly);
    ok('真实字节已固化为 test/fixtures/webm/rec_{video,audio}_only.webm');

    /* ---------------- 解析与轨道识别 ---------------- */
    console.log('\n[2] 单独解析两条轨：容器 / 轨道数 / TrackType / 编解码器');

    if (WebmMerge.isWebmHead(videoOnly) && WebmMerge.isWebmHead(audioOnly)) {
      ok('两条轨都被认成 WebM/Matroska（EBML 头 1A 45 DF A3）');
    } else {
      bad('EBML 头识别失败');
    }

    const vf = WebmMerge.parseFile(videoOnly);
    const af = WebmMerge.parseFile(audioOnly);
    ok('画面轨：TrackEntry ' + vf.entries.length + ' 个，Cluster ' + vf.clusters.length + ' 个，TimestampScale ' + vf.timestampScale);
    ok('声音轨：TrackEntry ' + af.entries.length + ' 个，Cluster ' + af.clusters.length + ' 个，TimestampScale ' + af.timestampScale);

    const vEntry = vf.entries.find((e) => e.type === 1);
    const aEntry = af.entries.find((e) => e.type === 2);
    if (vEntry && vEntry.codec) ok('画面轨 TrackType=1，CodecID=' + vEntry.codec + (vEntry.width ? '，' + vEntry.width + '×' + vEntry.height : ''));
    else bad('画面轨没有 TrackType=1 的 TrackEntry');
    if (aEntry && aEntry.codec) ok('声音轨 TrackType=2，CodecID=' + aEntry.codec + (aEntry.channels ? '，' + aEntry.channels + 'ch ' + aEntry.sampleRate + 'Hz' : ''));
    else bad('声音轨没有 TrackType=2 的 TrackEntry');

    if (vf.timestampScale === af.timestampScale) ok('两条轨时间基准一致（' + vf.timestampScale + ' ns/刻度）');
    else bad('时间基准不一致，合并会失败: ' + vf.timestampScale + ' vs ' + af.timestampScale);

    const pv = WebmMerge.probe(videoOnly);
    const pa = WebmMerge.probe(audioOnly);
    if (pv.ok && pv.role === 'video') ok('probe(画面轨) → video / ' + pv.label + ' / ' + pv.detail);
    else bad('probe(画面轨) 结果异常: ' + JSON.stringify(pv));
    if (pa.ok && pa.role === 'audio') ok('probe(声音轨) → audio / ' + pa.label + ' / ' + pa.detail);
    else bad('probe(声音轨) 结果异常: ' + JSON.stringify(pa));

    if (!WebmMerge.probe(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4])).ok) {
      ok('非 WebM（如 fMP4）不会被误判成 WebM');
    } else {
      bad('fMP4 被误判成 WebM');
    }

    /* ---------------- 合并 ---------------- */
    console.log('\n[3] 合并两条 WebM 轨并校验结构');

    let mergedData = null, mergeInfo = null;
    try {
      mergeInfo = WebmMerge.mergeAv(videoOnly, audioOnly);
      mergedData = mergeInfo.data;
      mergeInfo.data = undefined;
      ok('mergeAv 成功：' + mergeInfo.note);
      ok('编解码信息：画面 ' + [mergeInfo.video.codec, mergeInfo.video.width + '×' + mergeInfo.video.height].filter(Boolean).join(' ') +
         '，声音 ' + [mergeInfo.audio.codec, mergeInfo.audio.channels + 'ch'].filter(Boolean).join(' '));
    } catch (e) {
      bad('mergeAv 失败', e);
    }

    if (mergedData) {
      const mf = WebmMerge.parseFile(mergedData);
      const vTracks = mf.entries.filter((e) => e.type === 1);
      const aTracks = mf.entries.filter((e) => e.type === 2);
      if (vTracks.length === 1 && aTracks.length === 1) {
        ok('合并结果含 1 条画面轨 + 1 条声音轨（TrackEntry 共 ' + mf.entries.length + ' 个）');
      } else {
        bad('合并结果的轨道数不对：画面 ' + vTracks.length + '，声音 ' + aTracks.length);
      }
      if (vTracks[0] && vTracks[0].number === 1 && aTracks[0] && aTracks[0].number === 2) {
        ok('轨道号已重编为 1（画面）/ 2（声音）');
      } else {
        bad('轨道号未按预期重编: ' + JSON.stringify(mf.entries.map((e) => ({ t: e.type, n: e.number }))));
      }

      /* 块的轨道号必须跟着改 —— 不改的话解码器会把音频块喂给画面解码器。
         块的轨道号是 vint 编码，这里自己解一遍，跟被测实现相互独立。 */
      const vintAt = (buf, pos) => {
        const b = buf[pos];
        let len = 1;
        for (let m = 0x80; m && !(b & m); m >>= 1) len++;
        let v = b & (0xFF >> len);
        for (let i = 1; i < len; i++) v = v * 256 + buf[pos + i];
        return v;
      };
      const counts = { v: 0, a: 0, other: 0 };
      for (const c of mf.clusters) {
        for (const k of WebmMerge.children(mergedData, c.dataStart, c.dataEnd)) {
          const blocks = [];
          if (k.id === WebmMerge.ID.SIMPLE_BLOCK) blocks.push(k.dataStart);
          else if (k.id === WebmMerge.ID.BLOCK_GROUP) {
            for (const g of WebmMerge.children(mergedData, k.dataStart, k.dataEnd)) {
              if (g.id === WebmMerge.ID.BLOCK) blocks.push(g.dataStart);
            }
          }
          for (const pos of blocks) {
            const tn = vintAt(mergedData, pos);
            if (tn === 1) counts.v++;
            else if (tn === 2) counts.a++;
            else counts.other++;
          }
        }
      }
      if (counts.v > 0 && counts.a > 0 && counts.other === 0) {
        ok('所有数据块的轨道号已重写：画面块 ' + counts.v + ' 个、声音块 ' + counts.a + ' 个，无遗留其他轨道号');
      } else {
        bad('数据块轨道号异常: ' + JSON.stringify(counts));
      }

      /* Cluster 必须按时间戳单调递增，否则拖动与解码都会出问题 */
      const times = mf.clusters.map((c) => WebmMerge.clusterTimestamp(mergedData, c));
      let mono = true;
      for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) mono = false;
      if (mono && times.length >= 2) ok('交织后 Cluster 时间戳单调递增（共 ' + times.length + ' 个簇：' + times.join(', ') + '）');
      else if (times.length < 2) bad('合并结果的簇数不足（' + times.length + '）');
      else bad('Cluster 时间戳不是单调递增: ' + times.join(','));

      /* 画面与声音的簇要真的交织在一起，不能各自堆成一段 */
      const firstA = mf.clusters.findIndex((c) => {
        for (const k of WebmMerge.children(mergedData, c.dataStart, c.dataEnd)) {
          if (k.id === WebmMerge.ID.SIMPLE_BLOCK) return vintAt(mergedData, k.dataStart) === 2;
        }
        return false;
      });
      if (firstA >= 0 && firstA <= Math.max(3, Math.ceil(times.length / 2))) {
        ok('声音簇在开头附近就出现（第 ' + (firstA + 1) + ' 个簇），两轨确已交织');
      } else {
        bad('声音簇位置异常（第 ' + (firstA + 1) + ' 个），可能没交织: 共 ' + times.length + ' 个簇');
      }

      if (mf.duration > 0) ok('合并结果声明了时长：' + (mf.duration * mf.timestampScale / 1e9).toFixed(2) + ' s');
      else bad('合并结果没有时长');

      merged.data = mergedData;
    }

    /* ---------------- 回放验证 ---------------- */
    console.log('\n[4] 把合并结果丢回 Chrome 播放，验证画面与声音都真的解码出来');

    merged.vonly = videoOnly;

    /* 播放一个地址并采样状态 */
    const playAndSample = async (url) => {
      await cdp.send('Page.navigate', { url: base + '/index.html' }, sid);
      await sleep(1200);
      await ev(cdp, sid, `(function(){
        var v = document.getElementById('v');
        v.src = ${JSON.stringify(url)};
        v.muted = true;
        v.load();
        return v.play().then(function(){ return 'playing'; }).catch(function(e){ return 'play-error:' + e.message; });
      })()`);
      await sleep(4500);
      return JSON.parse(await ev(cdp, sid, `JSON.stringify((function(){
        var v = document.getElementById('v');
        return {
          duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
          currentTime: v.currentTime,
          audioBytes: (typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : -1),
          videoBytes: (typeof v.webkitVideoDecodedByteCount === 'number' ? v.webkitVideoDecodedByteCount : -1),
          err: v.error ? (v.error.code + ':' + v.error.message) : ''
        };
      })())`));
    };

    if (merged.data) {
      /* 对照：只播原始画面轨。用来判定「末尾解码报错」是合并引入的，还是
         录制本身末尾就有一帧不完整（MediaRecorder 收尾的正常现象）。 */
      const ctl = await playAndSample('/vonly.webm');
      console.log('    对照（只播原始画面轨）: ' + JSON.stringify(ctl));

      const st = await playAndSample('/merged.webm');
      console.log('    播放状态（合并结果）: ' + JSON.stringify(st));

      if (st.videoWidth > 0) ok('画面真实解码：' + st.videoWidth + '×' + st.videoHeight + '（已解码视频字节 ' + st.videoBytes + '）');
      else bad('画面未解码（videoWidth=' + st.videoWidth + '）' + (st.err ? ' 错误: ' + st.err : ''));
      if (st.audioBytes > 0) ok('声音真实解码：已解码音频字节 ' + st.audioBytes + '（' + (st.audioBytes / 1024).toFixed(0) + ' KB）');
      else bad('声音未解码（webkitAudioDecodedByteCount=' + st.audioBytes + '）' + (st.err ? ' 错误: ' + st.err : ''));
      if (st.currentTime > 0.3) ok('播放进度推进到 ' + st.currentTime.toFixed(2) + ' s / 总时长 ' + (st.duration > 0 ? st.duration.toFixed(2) + ' s' : '未知'));
      else bad('播放没有推进（currentTime=' + st.currentTime + '）' + (st.err ? ' 错误: ' + st.err : ''));
      if (st.duration > 0) ok('合并结果时长可被播放器直接读出：' + st.duration.toFixed(2) + ' s');
      else bad('播放器读不出合并结果的时长');
      if (!st.err) {
        ok('整段播放无解码错误');
      } else if (ctl.err) {
        ok('末尾报 ' + st.err.split(':')[1] + '，但原始画面轨同样如此 —— 是录制收尾的残帧，与合并无关');
      } else {
        bad('合并结果出现解码错误，而原始轨没有：' + st.err);
      }
    }

    /* ---------------- 错误路径 ---------------- */
    console.log('\n[5] 错误路径：不能静默产出坏文件');

    try {
      WebmMerge.mergeAv(audioOnly, videoOnly);
      bad('把「声音在前、画面在后」传反时应当报错，却成功了');
    } catch (e) {
      if (/没有视频轨/.test(e.message)) ok('顺序传反时报错清楚：' + e.message);
      else bad('顺序传反时的报错不清楚: ' + e.message);
    }
    try {
      WebmMerge.mergeAv(videoOnly, videoOnly);
      bad('两条画面轨混搭时应当报错，却成功了');
    } catch (e) {
      if (/没有音频轨/.test(e.message)) ok('两条画面轨时报错清楚：' + e.message);
      else bad('两条画面轨时的报错不清楚: ' + e.message);
    }
    try {
      WebmMerge.parseFile(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
      bad('非 WebM 数据应当报错，却解析成功了');
    } catch (e) {
      ok('非 WebM 数据报错清楚：' + e.message);
    }

  } catch (e) {
    bad('测试流程', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(600);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log('WebM 轨道识别与合并：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
