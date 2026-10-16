/* ============================================================
 * HLS AES-128 加密流「下载 → 解密 → 转封装」端到端测试（真 Chrome 内）
 * 运行：node test/e2e_hls_aes.mjs
 *
 * 为什么单独做这个：解密代码在 Node 与浏览器里的行为**不一致** ——
 * 浏览器按 W3C 规范原样返回「明文 + PKCS#7 填充」，Node 的 webcrypto 走
 * OpenSSL 会顺手把填充也去掉。只看 Node 单测会漏掉浏览器这条真实路径，
 * 而二次去填充会静默吃掉分片末尾 1~16 个字节（只在末尾字节恰好像填充时暴露，
 * 极难复现）。这里用真 Chrome 跑一遍，把行为钉死。
 *
 * 流程：
 *   1. 本地托管一份 AES-128 加密的真实 HLS 流（分片用 test/fixtures/seg*.ts）
 *   2. Node 侧用 node:crypto 独立解密 + mux.js 转封装，算出参照产物
 *   3. 扩展侧走 START_HLS（offscreen 文档里下载 + 解密 + 转封装 + 落盘）
 *   4. 两者必须逐字节一致
 * ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.AES_E2E_PORT || 10052);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.error('  ✗ ' + n + '\n      ' + (e && (e.stack || e.message) || e)); };

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

let server = null, chrome = null, cdp = null;

async function main() {
  const plain = [0, 1, 2].map((i) => readFileSync(join(__dirname, 'fixtures', 'seg' + i + '.ts')));
  if (!plain.length || !existsSync(join(__dirname, 'fixtures', 'seg0.ts'))) throw new Error('缺少 TS 分片样本');

  const KEY = randomBytes(16);
  const ivFor = (n) => { const iv = Buffer.alloc(16); iv.writeUInt32BE(n, 12); return iv; };
  const enc = plain.map((p, i) => {   // 与规范一致：AES-128-CBC + PKCS#7
    const c = createCipheriv('aes-128-cbc', KEY, ivFor(i));
    return Buffer.concat([c.update(p), c.final()]);
  });

  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-aes-e2e-'));
  const dlDir = join(tmp, 'dl');
  const prof = join(tmp, 'prof');
  mkdirSync(dlDir, { recursive: true });
  mkdirSync(prof, { recursive: true });

  try {
    console.log('\n[0] Node 侧独立算出参照产物（解密用 node:crypto，转封装用 mux.js）');
    /* 独立解密：不经过扩展的代码，只有密钥与 IV 约定是共同的 */
    const decoded = plain.map((_, i) => {
      const d = createDecipheriv('aes-128-cbc', KEY, ivFor(i));
      return Buffer.concat([d.update(enc[i]), d.final()]);
    });
    const plainOk = decoded.every((b, i) => b.equals(plain[i]));
    if (plainOk) ok('参照解密正确（' + decoded.map((b) => b.length).join('/') + ' 字节）');
    else bad('参照解密失败，测试前提不成立');

    const hlsSrc = readFileSync(join(ROOT, 'lib', 'hls.js'), 'utf8');
    const sb = { self: undefined, console };
    new Function('self', 'globalThis', hlsSrc + '\n;return self;')(sb, sb);
    const HLSKit = sb.HLSKit || globalThis.HLSKit;
    globalThis.window = globalThis;
    vm.runInThisContext(readFileSync(join(ROOT, 'lib', 'mux.min.js'), 'utf8'));
    const muxjs = globalThis.muxjs;
    const refParts = HLSKit.transmuxTsToMp4(muxjs, decoded);
    const ref = Buffer.concat(refParts.map((p) => Buffer.from(p.buffer || p, p.byteOffset || 0, p.byteLength)));
    console.log('  参照产物: ' + (ref.length / 1024).toFixed(0) + ' KB（' + refParts.length + ' 段）');
    ok('参照转封装完成');

    console.log('\n[1] 托管 AES-128 加密 HLS 流');
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:9.0,', 'seg0.ts',
      '#EXTINF:9.0,', 'seg1.ts',
      '#EXTINF:9.0,', 'seg2.ts',
      '#EXT-X-ENDLIST'
    ].join('\n');

    server = createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const send = (t, b) => { res.writeHead(200, { 'Content-Type': t, 'Content-Length': b.length, 'Access-Control-Allow-Origin': '*' }); res.end(b); };
      if (p === '/' || p === '/index.html') {
        return send('text/html; charset=utf-8', Buffer.from('<!DOCTYPE html><html><head><meta charset="utf-8"><title>aes hls</title></head><body>ok</body></html>'));
      }
      if (p === '/v/index.m3u8') return send('application/vnd.apple.mpegurl', Buffer.from(playlist));
      if (p === '/v/key.bin') return send('application/octet-stream', KEY);
      const m = /^\/v\/seg(\d)\.ts$/.exec(p);
      if (m) return send('video/mp2t', enc[+m[1]]);
      res.writeHead(404); res.end('nf');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const BASE = 'http://127.0.0.1:' + PORT;
    console.log('  流地址: ' + BASE + '/v/index.m3u8（3 个加密分片）');
    ok('本地已托管 AES-128 加密流');

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
    const swS = (await cdp.send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swS);
    ok('扩展已加载');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    /* 先在页面里问一次浏览器：crypto.subtle 解密会不会顺手去掉填充？
       做法：页内自己加密 16 字节明文的两个块，再解密回来，看长度。
       这是环境行为的分水岭，直接量出来，别猜。 */
    console.log('\n[3] 量出 Chrome 的 crypto.subtle 填充行为（不猜，实测）');
    const pT = (await cdp.send('Target.createTarget', { url: BASE + '/' })).targetId;
    const pS = (await cdp.send('Target.attachToTarget', { targetId: pT, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pS);
    await sleep(800);
    const probe = await ev(cdp, pS, `(function(){
      var key,iv=new Uint8Array(16),plain=new Uint8Array(32);
      for(var i=0;i<32;i++) plain[i]=i+7;
      return crypto.subtle.generateKey({name:'AES-CBC',length:128},false,['encrypt','decrypt']).then(function(k){
        key=k;
        return crypto.subtle.encrypt({name:'AES-CBC',iv:iv},key,plain);
      }).then(function(ct){
        return crypto.subtle.decrypt({name:'AES-CBC',iv:iv},key,ct).then(function(pt){
          return { ctLen: ct.byteLength, ptLen: pt.byteLength };
        });
      });
    })()`);
    console.log('  明文 32 B → 密文 ' + probe.ctLen + ' B → 解密回 ' + probe.ptLen + ' B');
    if (probe.ptLen === probe.ctLen) ok('Chrome 按 W3C 规范原样返回（含填充）→ 库里的「自己去填充」是必需的');
    else if (probe.ptLen < probe.ctLen) ok('Chrome 也自动去填充（与 Node 一致）→ 库里按长度判断跳过二次裁剪');
    else bad('解密长度异常: ' + JSON.stringify(probe));

    console.log('\n[4] 走扩展的 START_HLS：下载 + 解密 + 转封装 + 落盘');
    const started = JSON.parse(await ev(cdp, swS,
      'handleMessage(' + JSON.stringify({
        type: 'START_HLS', tabId: -1, url: BASE + '/v/index.m3u8', pageUrl: BASE + '/',
        name: 'hls-aes-e2e', folder: '', format: 'auto', concurrency: 3, saveMethod: 'anchor'
      }) + ',{}).then(r=>JSON.stringify(r))'));
    if (!started.taskId) throw new Error('任务创建失败: ' + JSON.stringify(started));

    let task = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const t = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get("tasks").then(a=>JSON.stringify(a))') || '{}').tasks || {};
      task = t[started.taskId];
      if (task && task.status !== 'running') break;
    }
    console.log('  任务结果: ' + JSON.stringify(task));
    if (task && task.status === 'done') ok('任务完成：' + (task.sizeStr || '') + '（' + task.phase + '）');
    else bad('任务未完成: ' + JSON.stringify(task));

    console.log('\n[5] 产物必须与参照逐字节一致');
    await sleep(2500);
    const files = readdirSync(dlDir, { recursive: true });
    console.log('  下载目录: ' + (files.join(', ') || '(空)'));
    const f = files.find((x) => /\.mp4$/.test(x));
    if (!f) throw new Error('没有落盘 mp4');
    const got = readFileSync(join(dlDir, f));
    console.log('  扩展产物: ' + (got.length / 1024).toFixed(0) + ' KB   参照: ' + (ref.length / 1024).toFixed(0) + ' KB');
    if (got.equals(ref)) ok('解密 + 转封装结果与独立参照逐字节一致（分片没有被多切或少切）');
    else {
      bad('产物与参照不一致：' + got.length + ' B vs ' + ref.length + ' B');
      /* 定位差异位置，方便排查是「少了尾部」还是「内容错位」 */
      const n = Math.min(got.length, ref.length);
      let firstDiff = -1;
      for (let i = 0; i < n; i++) if (got[i] !== ref[i]) { firstDiff = i; break; }
      console.log('    首个差异字节位置: ' + firstDiff + '（差 ' + (got.length - ref.length) + ' B）');
    }

    console.log('\n[6] Chrome 能解码落盘文件');
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
    if (st.w > 0 && !st.err) ok('可解析播放：' + st.w + '×' + st.h + '，时长 ' + (st.duration || 0).toFixed(2) + 's');
    else bad('播放异常: ' + JSON.stringify(st));
    if (st.audio > 0) ok('解码出音频数据 ' + (st.audio / 1024).toFixed(0) + ' KB');
  } catch (e) {
    bad('端到端流程', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(800);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log('HLS AES-128 端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
