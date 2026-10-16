/* ============================================================
 * fMP4 音视频轨合并测试
 * 运行：node test/fmp4merge.test.mjs
 *
 * 素材：test/fixtures/dash/*.m4s —— 从哔哩哔哩真实抓取的音视频轨样本
 *       （各取前 1MB / 512KB，结构完整、可独立成为合法 fMP4）
 * ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DASH = join(__dirname, 'fixtures', 'dash');
const VF = join(DASH, 'bili_video_30032_head.m4s');
const AF = join(DASH, 'bili_audio_30216_head.m4s');

/* 以 Node 方式加载纯逻辑库 */
const libSrc = readFileSync(join(ROOT, 'lib', 'fmp4merge.js'), 'utf8');
const sandbox = { self: undefined, console };
new Function('self', 'globalThis', libSrc + '\n;return self;')(sandbox, sandbox);
const Fmp4Merge = sandbox.Fmp4Merge || globalThis.Fmp4Merge;
assert.ok(Fmp4Merge, '应能从 lib/fmp4merge.js 载入 Fmp4Merge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.error('  ✗ ' + n + '\n      ' + (e && (e.stack || e.message) || e)); };

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.MERGE_DEBUG_PORT || 9888);

/* ---------------- 迷你 CDP ---------------- */
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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('超时 ' + method)); } }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
async function ev(cdp, sid, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

/* 独立校验：重新解析输出文件的结构 */
function verifyStructure(buf) {
  const info = Fmp4Merge.inspect(buf);
  assert.ok(info.ok, '输出应为合法 fMP4（含完整 moov）');
  const traks = info.traks;
  assert.strictEqual(traks.length, 2, '输出应有 2 条 trak，实际 ' + traks.length);
  const handlers = traks.map((t) => t.handler).sort();
  assert.deepStrictEqual(handlers, ['soun', 'vide'], 'handler 应为 soun + vide，实际 ' + handlers.join(','));
  const ids = traks.map((t) => t.trackId);
  assert.strictEqual(new Set(ids).size, 2, '两条 trak 的 track_ID 必须不同，实际 ' + ids.join(','));

  /* 每个 moof 的 tfhd track_ID 都必须能对应到某个 trak */
  const valid = new Set(ids);
  const tops = Fmp4Merge.parseBoxes(buf, 0, buf.length);
  const moofs = tops.filter((t) => t.type === 'moof');
  assert.ok(moofs.length >= 6, 'moof 数量应 >= 6，实际 ' + moofs.length);
  const seenIds = new Set();
  for (const moof of moofs) {
    const trafList = Fmp4Merge.parseBoxes(buf, moof.start + moof.header, moof.start + moof.size).filter((x) => x.type === 'traf');
    assert.ok(trafList.length >= 1, '每个 moof 应至少有一个 traf');
    for (const traf of trafList) {
      const tfhd = Fmp4Merge.parseBoxes(buf, traf.start + traf.header, traf.start + traf.size).find((x) => x.type === 'tfhd');
      assert.ok(tfhd, 'traf 内应有 tfhd');
      const id = buf[tfhd.start + tfhd.header + 4] << 24 | buf[tfhd.start + tfhd.header + 5] << 16 | buf[tfhd.start + tfhd.header + 6] << 8 | buf[tfhd.start + tfhd.header + 7];
      assert.ok(valid.has(id >>> 0), 'tfhd 引用了不存在的 track_ID=' + (id >>> 0));
      seenIds.add(id >>> 0);
    }
  }
  assert.strictEqual(seenIds.size, 2, '两个 trak 都应出现在分片里，实际用到 ' + [...seenIds].join(','));

  /* mvex 里应有 2 个 trex，且 track_ID 与 trak 对应 */
  const moovKids = Fmp4Merge.parseBoxes(buf, info.moov.start + info.moov.header, info.moov.start + info.moov.size);
  const mvex = moovKids.find((x) => x.type === 'mvex');
  assert.ok(mvex, '输出应含 mvex');
  const trexes = Fmp4Merge.parseBoxes(buf, mvex.start + mvex.header, mvex.start + mvex.size).filter((x) => x.type === 'trex');
  assert.strictEqual(trexes.length, 2, 'mvex 应有 2 个 trex，实际 ' + trexes.length);
  const trexIds = trexes.map((t) => [t.start + t.header + 4].map((o) => (buf[o] << 24 | buf[o + 1] << 16 | buf[o + 2] << 8 | buf[o + 3]) >>> 0)[0]);
  assert.deepStrictEqual(trexIds.slice().sort(), ids.slice().sort(), 'trex.track_ID 应与 trak 一致');

  return info;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  console.log('\n=== [1] 解析真实 B站 音视频轨 ===');
  if (!existsSync(VF) || !existsSync(AF)) {
    console.error('  缺少测试样本 ' + DASH + '（第三方版权内容，未随仓库分发，获取方法见 test/fixtures/README.md）');
    process.exit(1);
  }
  const vBuf = new Uint8Array(readFileSync(VF));
  const aBuf = new Uint8Array(readFileSync(AF));
  const vi = Fmp4Merge.classifyHead(vBuf);
  const ai = Fmp4Merge.classifyHead(aBuf);
  console.log('  视频轨: ' + vi.label + '  codec=' + vi.codec + '  ' + vi.detail);
  console.log('  音频轨: ' + ai.label + '  codec=' + ai.codec + '  ' + ai.detail);

  if (vi.role === 'video' && vi.codec === 'avc1') ok('视频轨识别正确（avc1 / ' + vi.detail + '）'); else bad('视频轨识别错误: ' + JSON.stringify(vi));
  if (ai.role === 'audio' && ai.codec === 'mp4a') ok('音频轨识别正确（mp4a / ' + ai.detail + '）'); else bad('音频轨识别错误: ' + JSON.stringify(ai));

  const vInfo = Fmp4Merge.inspect(vBuf);
  if (!vInfo.hasAudio) ok('视频轨确实不含音频轨（这就是"下载下来没声音"的根因）');
  else bad('视频轨竟然含音频，样本不符预期');

  console.log('\n=== [2] 执行合并 ===');
  const t0 = Date.now();
  const merged = Fmp4Merge.mergeAv(vBuf, aBuf);
  console.log('  ' + merged.note);
  console.log('  输出 ' + (merged.data.length / 1024).toFixed(0) + ' KB，用时 ' + (Date.now() - t0) + ' ms，估算时长 ' + merged.durationSec.toFixed(1) + ' 秒');
  /* sidx / free 会被丢弃，末尾截断的 mdat 也会被裁掉，因此输出略小于输入之和 */
  const ratio = merged.data.length / (vBuf.length + aBuf.length);
  if (merged.merged && ratio > 0.85 && ratio <= 1.02) ok('合并完成，输出体积合理（输入之和的 ' + (ratio * 100).toFixed(1) + '%）');
  else bad('输出体积异常：' + merged.data.length + ' vs 输入之和 ' + (vBuf.length + aBuf.length) + '（比率 ' + ratio.toFixed(3) + '）');

  console.log('\n=== [3] 结构校验 ===');
  let structureOk = true;
  try {
    verifyStructure(merged.data);
    ok('输出含 2 条 trak（vide + soun），track_ID 唯一，mvex/trex 对应正确');
    ok('每个 moof 的 tfhd 都指向有效 trak，两条轨的分片都在输出中');
  } catch (e) { structureOk = false; bad('结构校验', e); }

  try {
    const outDir = join(ROOT, 'test', 'evidence');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'merged_bili_av_sample.mp4'), merged.data);
    ok('合并结果已写出：test/evidence/merged_bili_av_sample.mp4');
  } catch (e) { bad('写出文件', e); }

  console.log('\n=== [4] 用 Chrome 实际播放验证（关键一步）===');
  let server = null, chrome = null, cdp = null;
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

    const prof = join(tmpdir(), 'vsniffer-merge-' + Date.now());
    mkdirSync(prof, { recursive: true });
    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + prof,
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

    /* 让它播一会儿，确保音频解码器真的被喂了数据 */
    await ev(cdp, sid, `(function(){var v=document.getElementById('v');v.muted=true;v.play();return 'ok'})()`);
    await sleep(3500);

    const st = JSON.parse(await ev(cdp, sid, `JSON.stringify((function(){
      var v=document.getElementById('v');
      return {
        duration: v.duration, readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
        currentTime: v.currentTime,
        audioBytes: (typeof v.webkitAudioDecodedByteCount==='number'? v.webkitAudioDecodedByteCount : -1),
        videoBytes: (typeof v.webkitVideoDecodedByteCount==='number'? v.webkitVideoDecodedByteCount : -1),
        err: v.error? v.error.message : ''
      };
    })())`));
    console.log('  播放状态: ' + JSON.stringify(st));

    if (st.videoWidth > 0 && st.videoHeight > 0) ok('视频轨可解码：' + st.videoWidth + '×' + st.videoHeight + '，时长 ' + (st.duration || 0).toFixed(1) + 's');
    else bad('视频轨未解码（videoWidth=' + st.videoWidth + '）' + (st.err ? ' 错误: ' + st.err : ''));

    if (st.audioBytes > 0) ok('音频轨可解码：已解码音频字节 ' + st.audioBytes + '（' + (st.audioBytes / 1024).toFixed(0) + ' KB）');
    else bad('音频轨未解码（webkitAudioDecodedByteCount=' + st.audioBytes + '）');

    if (isFinite(st.duration) && st.duration > 4) ok('时长可正确解析：' + st.duration.toFixed(2) + ' 秒');
    else bad('时长异常: ' + st.duration);

    if (st.currentTime > 0.5) ok('实际播放推进正常（currentTime=' + st.currentTime.toFixed(2) + 's）');
    else bad('播放未推进（currentTime=' + st.currentTime + '）');
  } catch (e) {
    bad('Chrome 播放验证', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(500);
  }

  console.log('\n========================================');
  console.log('fMP4 合并测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

main();
