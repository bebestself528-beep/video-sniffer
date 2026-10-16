/* ============================================================
 * 抖音真实分离轨样本：解析 + 合并 + Chrome 播放验证
 * 运行：node test/douyin_real_sample.test.mjs
 *
 * 样本来源（2026-10-15 实抓，见 test/douyin_probe.mjs）：
 *   视频轨  https://v26-web.douyinvod.com/.../media-video-avc1/?...    → douyin_video_avc1_head.m4s（512 KB 头部）
 *   音频轨  https://v26-web.douyinvod.com/.../media-audio-und-mp4a/?... → douyin_audio_mp4a_head.m4s（512 KB 头部）
 * 两条轨均为 fMP4 分片（ftyp+moov(mvex)+sidx+moof/mdat 序列），
 * Content-Type 均为 video/mp4，URL 均无媒体后缀 —— 这正是用户下载无声的根因形态。
 *
 * 本测试验证「合并引擎对这一真实形态可用」：解析 → mergeAv → 结构校验 → Chrome 解码校验。
 * ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VF = join(__dirname, 'fixtures', 'dash', 'douyin_video_avc1_head.m4s');
const AF = join(__dirname, 'fixtures', 'dash', 'douyin_audio_mp4a_head.m4s');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.DOUYIN_SAMPLE_PORT || 10001);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.error('  ✗ ' + n + '\n      ' + (e && (e.stack || e.message) || e)); };

const req = createRequire(import.meta.url);
req(join(ROOT, 'lib', 'fmp4merge.js'));
const Fmp4Merge = globalThis.Fmp4Merge;
if (!Fmp4Merge) { console.error('无法载入 lib/fmp4merge.js'); process.exit(1); }

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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
async function ev(cdp, sid, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

async function main() {
  if (!existsSync(VF) || !existsSync(AF)) throw new Error('缺少抖音真实样本，请先跑 test/douyin_probe.mjs');
  const V = new Uint8Array(readFileSync(VF));
  const A = new Uint8Array(readFileSync(AF));

  let merged = null;
  try {
    console.log('\n[1] 解析真实样本（应识别出各自的轨道角色）');
    const vi = Fmp4Merge.inspect(V);
    const ai = Fmp4Merge.inspect(A);
    console.log('  视频样本: kind=' + vi.kind + ' codec=' + (vi.video && vi.video.codec) + ' ' + (vi.video && vi.video.width) + '×' + (vi.video && vi.video.height) + ' timescale=' + (vi.video && vi.video.timescale));
    console.log('  音频样本: kind=' + ai.kind + ' codec=' + (ai.audio && ai.audio.codec) + ' ' + (ai.audio && ai.audio.channels) + 'ch ' + (ai.audio && ai.audio.sampleRate) + 'Hz timescale=' + (ai.audio && ai.audio.timescale));

    if (vi.ok && vi.hasVideo && !vi.hasAudio) ok('视频样本 = 纯视频轨（handler=vide）'); else bad('视频样本角色异常: ' + vi.kind);
    if (ai.ok && ai.hasAudio && !ai.hasVideo) ok('音频样本 = 纯音频轨（handler=soun）'); else bad('音频样本角色异常: ' + ai.kind);
    if (vi.mvex && ai.mvex) ok('两条轨都含 mvex（fMP4 分片，mergeAv 的前置条件满足）'); else bad('缺少 mvex');
    ok('分片结构: 视频 ' + Fmp4Merge._internal.collectFragments(V, vi).length + ' 个 moof/mdat 片段，音频 ' + Fmp4Merge._internal.collectFragments(A, ai).length + ' 个');

    console.log('\n[2] 合并（mergeAv）');
    const r = Fmp4Merge.mergeAv(V, A);
    merged = r;
    console.log('  ' + r.note + '，时长 ' + r.durationSec.toFixed(1) + 's，输出 ' + (r.data.length / 1024).toFixed(0) + ' KB');
    if (r.merged) ok('合并成功（真机场景中即「下载（含声音）」按钮的核心路径）'); else bad('未真正合并');
    if (r.audio && r.audio.codec === 'mp4a') ok('音频轨编解码器保留: mp4a'); else bad('音频编解码器异常');

    console.log('\n[3] 合并产物结构校验');
    const out = Fmp4Merge.inspect(r.data);
    if (out.ok && out.hasVideo && out.hasAudio) ok('产物含 vide + soun 两条轨（kind=' + out.kind + '）'); else bad('产物轨道异常: ' + JSON.stringify(out.kind));
    if (out.trexes && out.trexes.length === 2) ok('mvex 含 2 个 trex（每条轨一个）'); else bad('trex 数量异常: ' + (out.trexes || []).length);
    if (out.video && out.audio && out.video.trackId !== out.audio.trackId) ok('两条轨 track_ID 互不冲突（#' + out.video.trackId + ' / #' + out.audio.trackId + '）'); else bad('track_ID 冲突');
  } catch (e) { bad('解析/合并流程', e); }

  console.log('\n[4] Chrome 实际播放合并产物（验证画面与声音都能解码）');
  let server = null, chrome = null, cdp = null;
  const prof = mkdtempSync(join(tmpdir(), 'vsniffer-douyin-sample-'));
  try {
    const payload = Buffer.from(merged.data);
    server = createServer((req, res) => {
      if (req.url === '/merged.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
        res.end(payload);
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><video id="v" src="/merged.mp4" preload="auto"></video>');
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + join(prof, 'p'),
      'http://127.0.0.1:' + port + '/'], { stdio: ['ignore', 'ignore', 'ignore'] });

    let ws = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { ws = (await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json()).webSocketDebuggerUrl; break; } catch (e) { /* retry */ }
    }
    if (!ws) throw new Error('浏览器未就绪');
    cdp = new CDP(ws); await cdp.connect();
    const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page' && t.url.indexOf('127.0.0.1') >= 0);
    if (!page) throw new Error('未找到播放页面');
    const sid = (await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sid);
    await sleep(4000);

    await ev(cdp, sid, `(function(){var v=document.getElementById('v');v.muted=true;v.play();return 'ok'})()`);
    await sleep(3500);

    const st = JSON.parse(await ev(cdp, sid, `JSON.stringify((function(){
      var v=document.getElementById('v');
      return {
        duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
        currentTime: v.currentTime,
        audioBytes: (typeof v.webkitAudioDecodedByteCount==='number'? v.webkitAudioDecodedByteCount : -1),
        videoBytes: (typeof v.webkitVideoDecodedByteCount==='number'? v.webkitVideoDecodedByteCount : -1),
        err: v.error? v.error.message : ''
      };
    })())`));
    console.log('  播放状态: ' + JSON.stringify(st));

    if (st.videoWidth > 0) ok('视频轨真实解码: ' + st.videoWidth + '×' + st.videoHeight + '（已解码字节 ' + st.videoBytes + '）');
    else bad('视频轨未解码（videoWidth=' + st.videoWidth + '）' + (st.err ? ' 错误: ' + st.err : ''));
    if (st.audioBytes > 0) ok('音频轨真实解码: 已解码音频字节 ' + st.audioBytes + '（' + (st.audioBytes / 1024).toFixed(0) + ' KB）');
    else bad('音频轨未解码（webkitAudioDecodedByteCount=' + st.audioBytes + '）');
    if (isFinite(st.duration) && st.duration > 5) ok('时长可正确解析: ' + st.duration.toFixed(2) + ' 秒');
    else bad('时长异常: ' + st.duration);
  } catch (e) {
    bad('Chrome 播放验证', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(500);
    try { rmSync(prof, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n========================================');
  console.log('抖音真实分离轨样本：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

main();
