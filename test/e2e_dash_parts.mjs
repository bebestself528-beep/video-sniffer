/* ============================================================
 * DASH(.mpd) 清单 → 分片下载 → 合并 端到端测试
 * 运行：node test/e2e_dash_parts.mjs
 *
 * 覆盖「音视频分离」的第三种形态：**清单驱动的分片轨**。
 * 前两种（fMP4 整轨 / 无后缀分离轨）是「一条轨 = 一个文件」，
 * 这种是「一条轨 = init 段 + N 个分片」，必须先读清单才知道要下什么。
 *
 * 做法（用真实素材，不造假数据）：
 *   1. 把 B站 真实的 fMP4 音/视频轨按 moof 边界切开，
 *      还原成 DASH 的真实形态：init(ftyp+moov+sidx) + moof+mdat 分片
 *   2. 本地服务托管一份 MPD（SegmentList 形态）+ 全部分片
 *   3. 扩展解析清单 → START_MERGE（两条轨各是一串分片）→ 落盘一个文件
 *   4. 校验：产物与「直接合并两条整轨」逐字节一致（拼接无损）
 *   5. 另测 START_PARTS：单独下载多分片音频轨 → .m4a
 * ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DASH = join(__dirname, 'fixtures', 'dash');
const VF = join(DASH, 'bili_video_30032_head.m4s');
const AF = join(DASH, 'bili_audio_30216_head.m4s');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.DASH_E2E_PORT || 10041);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 以 Node 方式加载纯逻辑库（与扩展内是同一份代码） */
function loadLib(file, name) {
  const src = readFileSync(join(ROOT, 'lib', file), 'utf8');
  const sb = { self: undefined, console };
  new Function('self', 'globalThis', src + '\n;return self;')(sb, sb);
  return sb[name] || globalThis[name];
}
const Fmp4Merge = loadLib('fmp4merge.js', 'Fmp4Merge');
const MpdKit = loadLib('mpd.js', 'MpdKit');

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.error('  ✗ ' + n + '\n      ' + (e && (e.stack || e.message) || e)); };
const eq = (a, b, label) => { if (a === b) ok(label + ' = ' + JSON.stringify(a)); else bad(label, '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); };

class CDP {
  constructor(u) { this.ws = new WebSocket(u); this.n = 1; this.p = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => {
        this.ws.onmessage = (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.id && this.p.has(m.id)) {
            const { res: r, rej: j } = this.p.get(m.id); this.p.delete(m.id);
            m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
          }
        };
        res();
      };
      this.ws.onerror = () => rej(new Error('CDP 连接失败'));
    });
  }
  send(method, params, sid) {
    const id = this.n++;
    return new Promise((res, rej) => {
      this.p.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId: sid }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 90000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
async function ev(cdp, sid, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

/* 按 box 边界把一条真实 fMP4 轨切成 DASH 形态：init + 分片[] */
function splitTrack(buf, ext) {
  const boxes = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8 || p + size > buf.length) break;   // 尾部被截断的半截 box，丢掉
    boxes.push({ type, start: p, size });
    p += size;
  }
  const firstMoof = boxes.findIndex((b) => b.type === 'moof');
  if (firstMoof < 0) throw new Error(ext + ' 里找不到 moof，无法切片');

  const initEnd = boxes[firstMoof].start;
  const init = buf.subarray(0, initEnd);

  const segments = [];
  let i = firstMoof;
  while (i < boxes.length) {
    const b = boxes[i];
    if (b.type !== 'moof') { i++; continue; }
    const next = boxes[i + 1];
    /* 一个分片 = moof + 紧随的 mdat */
    if (!next || next.type !== 'mdat') break;
    const end = next.start + next.size;
    segments.push(buf.subarray(b.start, end));
    i += 2;
  }
  return { init, segments, completeEnd: initEnd + segments.reduce((n, s) => n + s.length, 0), boxes };
}

let server = null, chrome = null, cdp = null;

async function main() {
  if (!existsSync(VF) || !existsSync(AF)) throw new Error('缺少测试样本 test/fixtures/dash/');

  const vRaw = readFileSync(VF);
  const aRaw = readFileSync(AF);
  const V = splitTrack(vRaw, '视频轨');
  const A = splitTrack(aRaw, '音频轨');

  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-dash-e2e-'));
  const dlDir = join(tmp, 'dl');
  const prof = join(tmp, 'prof');
  mkdirSync(dlDir, { recursive: true });
  mkdirSync(prof, { recursive: true });

  try {
    console.log('\n[0] 把真实音视频轨切成 DASH 形态');
    console.log('  视频轨: init ' + V.init.length + ' B + ' + V.segments.length + ' 个分片，共 ' + (V.completeEnd / 1024).toFixed(0) + ' KB');
    console.log('  音频轨: init ' + A.init.length + ' B + ' + A.segments.length + ' 个分片，共 ' + (A.completeEnd / 1024).toFixed(0) + ' KB');
    if (V.segments.length >= 3 && A.segments.length >= 3) ok('音视频轨各自切出多个分片（真实 DASH 形态）');
    else bad('分片数不足：' + V.segments.length + '/' + A.segments.length);

    /* 拼接无损性：init + 全部分片 必须逐字节等于原文件的前缀 */
    const vJoined = Buffer.concat([V.init].concat(V.segments));
    const aJoined = Buffer.concat([A.init].concat(A.segments));
    if (vJoined.equals(vRaw.subarray(0, vJoined.length))) ok('视频轨：init + 分片 拼接后与原文件逐字节一致');
    else bad('视频轨切片有损（拼接结果 ≠ 原文件前缀）');
    if (aJoined.equals(aRaw.subarray(0, aJoined.length))) ok('音频轨：init + 分片 拼接后与原文件逐字节一致');
    else bad('音频轨切片有损');

    /* 同一条轨，直接合并整轨得到的参照产物（与分片下载路径的结果必须一致） */
    let refMerge = null;
    try {
      const r = Fmp4Merge.mergeAv(new Uint8Array(vJoined), new Uint8Array(aJoined));
      refMerge = Buffer.from(r.data);
      console.log('  参照产物（整轨合并）: ' + (refMerge.length / 1024).toFixed(0) + ' KB · ' + (r.note || ''));
    } catch (e) {
      throw new Error('参照合并失败，测试前提不成立：' + e.message);
    }

    console.log('\n[1] 托管 MPD 清单 + 分片');
    const name = (p, i) => p + '/' + String(i + 1).padStart(5, '0') + '.m4s';
    const mpd = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S" minBufferTime="PT2S">\n' +
      '  <Period id="0" duration="PT20S">\n' +
      '    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">\n' +
      '      <Representation id="v30032" bandwidth="1200000" codecs="avc1.64001f" width="1280" height="720">\n' +
      '        <SegmentList>\n' +
      '          <Initialization sourceURL="video/init.mp4"/>\n' +
      V.segments.map((s, i) => '          <SegmentURL media="' + name('video', i) + '"/>').join('\n') + '\n' +
      '        </SegmentList>\n' +
      '      </Representation>\n' +
      '    </AdaptationSet>\n' +
      '    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="zh">\n' +
      '      <Representation id="a30216" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="44100">\n' +
      '        <SegmentList>\n' +
      '          <Initialization sourceURL="audio/init.mp4"/>\n' +
      A.segments.map((s, i) => '          <SegmentURL media="' + name('audio', i) + '"/>').join('\n') + '\n' +
      '        </SegmentList>\n' +
      '      </Representation>\n' +
      '    </AdaptationSet>\n' +
      '  </Period>\n' +
      '</MPD>';

    const routes = new Map();
    routes.set('/stream.mpd', ['application/dash+xml', Buffer.from(mpd)]);
    routes.set('/video/init.mp4', ['video/mp4', Buffer.from(V.init)]);
    routes.set('/audio/init.mp4', ['video/mp4', Buffer.from(A.init)]);
    V.segments.forEach((s, i) => routes.set('/' + name('video', i), ['video/mp4', Buffer.from(s)]));
    A.segments.forEach((s, i) => routes.set('/' + name('audio', i), ['video/mp4', Buffer.from(s)]));

    const page = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>dash parts test</title></head><body>' +
      '<script>fetch("/stream.mpd").then(function(r){return r.text();}).then(function(t){document.title="mpd "+(t.length>0?"ok":"empty");});<\/script>' +
      '</body></html>';
    routes.set('/', ['text/html; charset=utf-8', Buffer.from(page)]);

    server = createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const hit = routes.get(p);
      if (!hit) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': hit[0], 'Content-Length': hit[1].length, 'Access-Control-Allow-Origin': '*' });
      res.end(hit[1]);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const BASE = 'http://127.0.0.1:' + PORT;
    const PAGE_URL = BASE + '/';
    console.log('  页面: ' + PAGE_URL + '（清单 + ' + routes.size + ' 个资源）');
    ok('本地已托管 MPD 与全部分片');

    /* 清单先自己解一遍，拿到「popup 会发给引擎的取数规格」 */
    console.log('\n[2] 解析清单得到取数规格（与 popup 的 repSpec 同形）');
    const parsed = MpdKit.parseMpd(mpd, BASE + '/stream.mpd');
    const vRep = parsed.representations.find((r) => r.role === 'video');
    const aRep = parsed.representations.find((r) => r.role === 'audio');
    eq(vRep.segmentUrls.length, V.segments.length, '清单里的视频分片数');
    eq(aRep.segmentUrls.length, A.segments.length, '清单里的音频分片数');
    if (/\/video\/init\.mp4$/.test(vRep.initUrl)) ok('init 段地址解析正确：' + vRep.initUrl);
    else bad('init 地址异常: ' + vRep.initUrl);
    if (/\/video\/00001\.m4s$/.test(vRep.segmentUrls[0])) ok('首片地址解析正确：' + vRep.segmentUrls[0].split('/').slice(-2).join('/'));
    else bad('首片地址异常: ' + vRep.segmentUrls[0]);
    const vSpec = { parts: vRep.segmentUrls.slice(), initUrl: vRep.initUrl };
    const aSpec = { parts: aRep.segmentUrls.slice(), initUrl: aRep.initUrl };

    console.log('\n[3] 启动无头浏览器并加载扩展');
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + prof,
      '--enable-unsafe-extension-debugging', '--load-extension=' + ROOT, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let ws = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { ws = (await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json()).webSocketDebuggerUrl; break; } catch (e) { /* retry */ }
    }
    if (!ws) throw new Error('浏览器未就绪');
    cdp = new CDP(ws); await cdp.connect();

    const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    await sleep(1500);
    const swT = (await cdp.send('Target.getTargets')).targetInfos.find((x) => x.type === 'service_worker' && /background/.test(x.url));
    if (!swT) throw new Error('扩展未加载');
    const swS = (await cdp.send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swS);
    ok('扩展已加载');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    console.log('\n[4] 打开页面：.mpd 应被嗅探为 dash 类型');
    const pT = (await cdp.send('Target.createTarget', { url: PAGE_URL })).targetId;
    const pS = (await cdp.send('Target.attachToTarget', { targetId: pT, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pS);
    await sleep(3500);

    const dump = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get(null).then(a=>JSON.stringify(a).slice(0,60000))') || '{}');
    const items = [];
    for (const k of Object.keys(dump)) {
      if (!k.startsWith('tab:')) continue;
      const it = (dump[k] && dump[k].items) || {};
      for (const u of Object.keys(it)) items.push(it[u]);
    }
    const dashItems = items.filter((i) => i.kind === 'dash');
    const segItems = items.filter((i) => i.kind === 'fmp4' || i.kind === 'cand');
    console.log('  嗅探: ' + (items.map((i) => i.kind + ':' + i.url.split('/').slice(-2).join('/')).join('  ') || '(空)'));
    if (dashItems.length >= 1) ok('.mpd 被识别为 dash 类型');
    else bad('未嗅探到 .mpd 条目：' + JSON.stringify(items.map((i) => i.kind)));

    console.log('\n[5] START_MERGE：两条轨各是一串分片 → 合并落盘');
    const started = JSON.parse(await ev(cdp, swS,
      'handleMessage(' + JSON.stringify({
        type: 'START_MERGE', tabId: -1,
        videoUrl: vSpec.parts[0], audioUrl: aSpec.parts[0],
        videoSpec: vSpec, audioSpec: aSpec,
        pageUrl: PAGE_URL, name: 'dash-parts-e2e', folder: '', saveMethod: 'anchor'
      }) + ',{}).then(r=>JSON.stringify(r))'));
    if (!started.taskId) throw new Error('任务创建失败: ' + JSON.stringify(started));

    let task = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const t = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get("tasks").then(a=>JSON.stringify(a))') || '{}').tasks || {};
      task = t[started.taskId];
      if (task && task.status !== 'running') break;
      if (i % 4 === 0 && task) console.log('    … ' + task.phase + '  ' + ((task.bytes || 0) / 1024).toFixed(0) + ' KB');
    }
    console.log('  任务结果: ' + JSON.stringify(task));
    if (task && task.status === 'done') ok('合并任务完成：' + (task.sizeStr || '') + '（' + task.phase + '）');
    else bad('合并任务未完成: ' + JSON.stringify(task));
    if (task && /合并/.test(task.note || '')) ok('任务说明：' + task.note);
    else bad('任务未报告合并信息: ' + (task && task.note));

    console.log('\n[6] 校验产物：结构 + 与整轨合并逐字节一致');
    await sleep(2500);
    const files = readdirSync(dlDir, { recursive: true });
    console.log('  下载目录: ' + (files.join(', ') || '(空)'));
    const f = files.find((x) => /\.mp4$/.test(x));
    if (!f) throw new Error('下载目录没有 mp4 文件');
    const got = readFileSync(join(dlDir, f));
    const info = Fmp4Merge.inspect(new Uint8Array(got));
    if (info.ok) ok('落盘文件是合法 fMP4');
    else bad('落盘文件不是合法 fMP4');
    const handlers = info.traks.map((t) => t.handler).sort().join(',');
    if (handlers === 'soun,vide') ok('同时含视频轨与音频轨：' + handlers);
    else bad('轨道异常: ' + handlers);
    if (info.video && info.video.width) ok('画面 ' + info.video.width + '×' + info.video.height + ' ' + info.video.codec);
    if (info.audio && info.audio.channels) ok('声音 ' + info.audio.channels + 'ch ' + info.audio.sampleRate + 'Hz ' + info.audio.codec);
    if (got.equals(refMerge)) ok('分片下载合并的产物与整轨合并逐字节一致（分片拼接无损）');
    else bad('分片路径产物与参照产物不一致：' + got.length + ' B vs ' + refMerge.length + ' B');

    /* 落盘文件能不能真播 */
    console.log('\n[7] 用 Chrome 打开落盘文件，确认可播放');
    const fileUrl = 'file:///' + join(dlDir, f).split('\\').join('/');
    const fT = (await cdp.send('Target.createTarget', { url: fileUrl })).targetId;
    const fS = (await cdp.send('Target.attachToTarget', { targetId: fT, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, fS);
    await sleep(4500);
    const st = JSON.parse(await ev(cdp, fS, `JSON.stringify((function(){
      var v=document.querySelector('video');
      if(!v) return {none:true};
      return { duration:v.duration, w:v.videoWidth, h:v.videoHeight, audio:v.webkitAudioDecodedByteCount||0, err:v.error?v.error.code:0 };
    })())`));
    console.log('  播放状态: ' + JSON.stringify(st));
    if (st.w > 0 && st.duration > 0 && !st.err) ok('本地文件可解析播放：' + st.w + '×' + st.h + '，时长 ' + st.duration.toFixed(2) + 's');
    else bad('本地文件播放异常: ' + JSON.stringify(st));
    if (st.audio > 0) ok('解码出音频数据 ' + (st.audio / 1024).toFixed(0) + ' KB（确实有声音）');
    else bad('未解码出音频数据，可能没声音');

    console.log('\n[8] START_PARTS：单独下载多分片音频轨');
    const started2 = JSON.parse(await ev(cdp, swS,
      'handleMessage(' + JSON.stringify({
        type: 'START_PARTS', tabId: -1,
        parts: aSpec.parts, initUrl: aSpec.initUrl, kind: 'audio',
        pageUrl: PAGE_URL, name: 'dash-audio-only', folder: '', saveMethod: 'anchor'
      }) + ',{}).then(r=>JSON.stringify(r))'));
    if (!started2.taskId) throw new Error('单轨任务创建失败: ' + JSON.stringify(started2));
    let task2 = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const t = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get("tasks").then(a=>JSON.stringify(a))') || '{}').tasks || {};
      task2 = t[started2.taskId];
      if (task2 && task2.status !== 'running') break;
    }
    console.log('  任务结果: ' + JSON.stringify(task2));
    if (task2 && task2.status === 'done') ok('单轨任务完成：' + (task2.sizeStr || ''));
    else bad('单轨任务未完成: ' + JSON.stringify(task2));
    await sleep(2500);

    const files2 = readdirSync(dlDir, { recursive: true });
    console.log('  下载目录: ' + files2.join(', '));
    const fa = files2.find((x) => /\.m4a$/.test(x));
    if (fa) ok('纯音频轨落盘为 .m4a（不是 .mp4）：' + fa);
    else bad('未找到 .m4a 文件：' + files2.join(', '));
    if (fa) {
      const ab = readFileSync(join(dlDir, fa));
      const aInfo = Fmp4Merge.inspect(new Uint8Array(ab));
      const aHandlers = aInfo.traks.map((t) => t.handler).sort().join(',');
      eq(aHandlers, 'soun', '纯音频文件的轨道');
      /* 音频单独下载 = init + 分片，应与原音频文件前缀逐字节一致 */
      if (ab.equals(aJoined)) ok('音频轨分片拼接与原文件逐字节一致（' + (ab.length / 1024).toFixed(0) + ' KB）');
      else bad('音频拼接结果与原文件不一致：' + ab.length + ' B vs ' + aJoined.length + ' B');
      /* 单个分片请求不应被当成整轨（分片是 fmp4 但不是完整轨，探测应判不出角色） */
      const segDone = segItems.length;
      if (segDone >= 1) ok('分片请求也被嗅探到（' + segDone + ' 条），未干扰主流程');
    }
  } catch (e) {
    bad('端到端流程', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(800);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log('DASH 分片下载与合并端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
