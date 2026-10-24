/* ============================================================
 * 凭证降级端到端测试（真 Chrome 内）
 * 运行：node test/e2e_cred_fallback.mjs
 *
 * 守护的 bug（真实站点复现）：某 HLS 站下载时第一步就失败。
 *   根因：CDN 只回 Access-Control-Allow-Origin: *、不回
 *   Access-Control-Allow-Credentials。扩展过去固定用
 *   credentials:'include' 发请求，被 CORS 直接掐断 —— 浏览器层面是
 *   TypeError: Failed to fetch，连状态码都拿不到。
 *   实测同一地址换 credentials:'omit' 立刻 200。
 *
 * 这里用本地服务器**精确复刻**那个 CDN 的响应头形态
 * （ACAO: *、无 ACAC），跑完整的 START_HLS 下载链路：
 *   能下完 → 修复有效；
 *   下不完 → 回归。
 *
 * 同时反向验证：给同一个流补上 ACAC 之后，原本的 include 路径依然通
 * （不能为了修一类站点把另一类站点弄坏）。
 *
 * 场景三：HEVC 流 —— 不许产出"只有声音的 MP4"。
 * ============================================================ */
import { readFileSync, mkdirSync, readdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.CRED_E2E_PORT || 10062);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.error('  ✗ ' + n + '\n      ' + ((e && (e.stack || e.message)) || e)); };

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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 120000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
async function ev(cdp, sid, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

/* 索引是否真的重建出来了（moov 带 stco、没有 moof） */
function isIndexedMp4(buf) {
  let hasStco = false, hasMoov = false, hasFtyp = false;
  const boxTree = (buf, start, end) => {
    const out = []; let p = start;
    const KIDS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
    while (p + 8 <= end) {
      const size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      if (size < 8 || p + size > end) break;
      out.push({ type, kids: KIDS.has(type) ? boxTree(buf, p + 8, p + size) : null });
      p += size;
    }
    return out;
  };
  const walk = (list) => {
    for (const b of list) {
      if (b.type === 'moof') return false;
      if (b.type === 'stco' || b.type === 'co64') hasStco = true;
      if (b.kids) walk(b.kids);
    }
  };
  const tops = boxTree(buf, 0, buf.length);
  for (const t of tops) {
    if (t.type === 'ftyp') hasFtyp = true;
    if (t.type === 'moov') hasMoov = true;
  }
  walk(tops);
  return hasFtyp && hasMoov && hasStco;
}

let server = null, chrome = null, cdp = null;
let PORT = 0, BASE = '';
let withAcac = false;      // 当前服务器是否回 Access-Control-Allow-Credentials
let hevcMode = false;      // 当前服务器是否改发 HEVC 分片

const segs = [0, 1, 2].map((i) => readFileSync(join(__dirname, 'fixtures', 'seg' + i + '.ts')));
if (!segs.length || !existsSync(join(__dirname, 'fixtures', 'seg0.ts'))) {
  console.error('缺少 TS 分片样本 test/fixtures/seg0.ts');
  process.exit(1);
}

/* 合成一份「HEVC 视频 + AAC 音频」的 TS：PAT + PMT(stream_type=0x24) + 填充包。
   用途：验证遇到 mux.js 转不动的编码时，产物是能播的 TS 而不是只剩声音的 MP4。 */
function makeTs(videoStreamType) {
  const packets = [];
  const mkPsi = (pid, section) => {
    const pkt = Buffer.alloc(188);
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((pid >> 8) & 0x1f);
    pkt[2] = pid & 0xff;
    pkt[3] = 0x10;
    pkt[4] = 0x00;
    section.copy(pkt, 5);
    for (let q = 5 + section.length; q < 188; q++) pkt[q] = 0xff;
    packets.push(new Uint8Array(pkt));
  };
  const pat = Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00, 0x00]);   /* PMT PID = 0x1000 */
  mkPsi(0x0000, pat);
  const es = Buffer.from([videoStreamType, 0xe1, 0x01, 0xf0, 0x00, 0x0f, 0xe1, 0x02, 0xf0, 0x00]);
  const pmt = Buffer.alloc(12 + es.length);
  pmt[0] = 0x02;
  pmt[1] = 0xb0; pmt[2] = 12 + es.length;
  pmt[3] = 0x00; pmt[4] = 0x01; pmt[5] = 0xc1; pmt[6] = 0x00; pmt[7] = 0x00;
  pmt[8] = 0xf0; pmt[9] = 0x00; pmt[10] = 0xf0; pmt[11] = 0x00;   /* PCR PID 与 PMT PID 都是 0x1000 */
  es.copy(pmt, 12);
  mkPsi(0x1000, pmt);
  for (let i = 0; i < 40; i++) {
    const pkt = Buffer.alloc(188);
    pkt[0] = 0x47;
    pkt[1] = 0x01; pkt[2] = 0x01; pkt[3] = 0x10;
    packets.push(new Uint8Array(pkt));
  }
  return Buffer.concat(packets);
}
const hevcSeg = makeTs(0x24);

const playlist = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:9.0,', 'seg0.ts',
  '#EXTINF:9.0,', 'seg1.ts',
  '#EXTINF:9.0,', 'seg2.ts',
  '#EXT-X-ENDLIST'
].join('\n');

function startServer() {
  return new Promise((res) => {
    server = createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const h = { 'Content-Length': '0', 'Access-Control-Allow-Origin': '*' };
      /* 关键差别：开关注回 ACAC，关掉不回 —— 后者就是问题 CDN 的形态 */
      if (withAcac) h['Access-Control-Allow-Credentials'] = 'true';
      const send = (t, b) => { res.writeHead(200, Object.assign({}, h, { 'Content-Type': t, 'Content-Length': b.length })); res.end(b); };
      if (p === '/' || p === '/index.html') {
        return send('text/html; charset=utf-8', Buffer.from('<!DOCTYPE html><html><head><meta charset="utf-8"><title>cred hls</title></head><body>ok</body></html>'));
      }
      if (p === '/v/index.m3u8') {
        return send('application/vnd.apple.mpegurl',
          Buffer.from(hevcMode ? playlist.replace(/seg(\d)\.ts/g, 'hevc$1.ts') : playlist));
      }
      const mh = /^\/v\/hevc(\d)\.ts$/.exec(p);
      if (hevcMode && mh) return send('video/mp2t', hevcSeg);
      const m = /^\/v\/seg(\d)\.ts$/.exec(p);
      if (!hevcMode && m) return send('video/mp2t', segs[+m[1]]);
      res.writeHead(404); res.end('nf');
    });
    server.listen(0, '127.0.0.1', () => {
      PORT = server.address().port;
      BASE = 'http://127.0.0.1:' + PORT;
      res();
    });
  });
}

async function runDownload(name) {
  const started = JSON.parse(await ev(cdp, swS,
    'handleMessage(' + JSON.stringify({
      type: 'START_HLS', tabId: -1, url: BASE + '/v/index.m3u8', pageUrl: BASE + '/',
      name, folder: '', format: 'auto', concurrency: 3, saveMethod: 'anchor'
    }) + ',{}).then(r=>JSON.stringify(r))'));
  if (!started.taskId) throw new Error('任务创建失败: ' + JSON.stringify(started));
  let task = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const t = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get("tasks").then(a=>JSON.stringify(a))') || '{}').tasks || {};
    task = t[started.taskId];
    if (task && task.status !== 'running') break;
  }
  return task;
}

let swS = null, dlDir = null;

async function main() {
  await startServer();
  console.log('[1] 本地已托管 HLS 流（3 个 TS 分片，明文不加密）: ' + BASE + '/v/index.m3u8');

  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-cred-e2e-'));
  dlDir = join(tmp, 'dl');
  const prof = join(tmp, 'prof');
  mkdirSync(dlDir, { recursive: true });
  mkdirSync(prof, { recursive: true });

  try {
    console.log('\n[2] 启动无头浏览器并加载扩展');
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
    await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    await sleep(1500);
    const swT = (await cdp.send('Target.getTargets')).targetInfos.find((x) => x.type === 'service_worker' && /background/.test(x.url));
    if (!swT) throw new Error('扩展未加载');
    swS = (await cdp.send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swS);
    ok('扩展已加载');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    /* ---- 场景一：CDN 不回 ACAC（问题站点的形态） ---- */
    console.log('\n[3] 场景一：CDN 只回 ACAO: *、不回 ACAC（问题站点形态）');
    withAcac = false;
    const t1 = await runDownload('cred-no-acac');
    console.log('  任务结果: ' + JSON.stringify({ status: t1 && t1.status, phase: t1 && t1.phase, size: t1 && t1.sizeStr, err: t1 && t1.error, note: t1 && t1.note }));
    if (t1 && t1.status === 'done') ok('不带 ACAC 的 CDN 也能下载完成（' + t1.sizeStr + '）');
    else bad('下载失败，凭证降级没有生效', t1 && t1.error);

    await sleep(2000);
    let files = [];
    try { files = readdirSync(dlDir); } catch (e) { }
    const f1 = files.find((x) => /\.mp4$/.test(x));
    if (f1) {
      const got = readFileSync(join(dlDir, f1));
      console.log('  产物: ' + f1 + '  ' + (got.length / 1024).toFixed(0) + ' KB');
      if (isIndexedMp4(got)) ok('产物是带帧索引的标准 MP4（进度条能拖）');
      else bad('产物不是索引完好的 MP4');
      if (/vide/.test(got.toString('latin1', 0, Math.min(got.length, 200000)))) ok('产物里含视频轨');
      else bad('产物里没有视频轨（正是"只有音频"那类失真）');
    } else bad('没有落盘 mp4');

    /* ---- 场景二：同样的流，补上 ACAC（正常站点形态） ---- */
    console.log('\n[4] 场景二：同样的流补上 ACAC（正常站点形态，不能修坏）');
    withAcac = true;
    const t2 = await runDownload('cred-with-acac');
    console.log('  任务结果: ' + JSON.stringify({ status: t2 && t2.status, phase: t2 && t2.phase, size: t2 && t2.sizeStr, err: t2 && t2.error }));
    if (t2 && t2.status === 'done') ok('带 ACAC 的 CDN 照样下载完成（' + t2.sizeStr + '）');
    else bad('带 ACAC 的站点被修坏了', t2 && t2.error);

    await sleep(2000);
    try { files = readdirSync(dlDir); } catch (e) { }
    const f2 = files.filter((x) => /cred-with-acac.*\.mp4$/.test(x))[0];
    if (f2) {
      const got2 = readFileSync(join(dlDir, f2));
      if (isIndexedMp4(got2)) ok('第二种形态的产物同样是索引完好的 MP4');
      else bad('第二种形态的产物索引不完整');
    } else bad('第二种形态没有落盘');

    /* ---- 场景三：HEVC 流 —— 不许产出"只有声音的 MP4" ---- */
    console.log('\n[5] 场景三：HEVC(H.265) 流，mux.js 转不动');
    hevcMode = true;
    const t3 = await runDownload('cred-hevc');
    console.log('  任务结果: ' + JSON.stringify({ status: t3 && t3.status, phase: t3 && t3.phase, size: t3 && t3.sizeStr, err: t3 && t3.error, note: t3 && t3.note }));
    hevcMode = false;
    if (t3 && t3.status === 'done') ok('HEVC 流下载任务完成');
    else bad('HEVC 流下载失败', t3 && t3.error);
    if (t3 && t3.note && /HEVC/.test(t3.note)) ok('任务说明里点明了是 HEVC、为什么没转 MP4');
    else bad('没有说明 HEVC 的情况', t3 && t3.note);

    await sleep(2000);
    try { files = readdirSync(dlDir); } catch (e) { }
    const hevcFiles = files.filter((x) => /cred-hevc/.test(x));
    console.log('  HEVC 产物: ' + JSON.stringify(hevcFiles));
    if (hevcFiles.some((x) => /\.mp4$/.test(x))) bad('产出了 MP4 —— 这正是"只有音频"那类静默失真', hevcFiles.join(','));
    else ok('没有产出 MP4（没把用户骗进"只有声音"的坑）');
    const tsOut = hevcFiles.filter((x) => /\.ts$/.test(x))[0];
    if (tsOut) {
      const tsBuf = readFileSync(join(dlDir, tsOut));
      if (tsBuf[0] === 0x47) ok('产出的是原始 TS（首字节 0x47，播放器能直接打开）');
      else bad('产出的 TS 内容异常');
    } else bad('没有产出 TS 文件');
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { if (chrome) chrome.kill(); } catch (e) { /* ignore */ }
    try { if (server) server.close(); } catch (e) { /* ignore */ }
    await sleep(300);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
