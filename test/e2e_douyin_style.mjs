/* ============================================================
 * 抖音形态（无后缀分离轨）端到端测试
 * 运行：node test/e2e_douyin_style.mjs
 *
 * 背景：用户反馈「抖音下载的视频没有声音」。核查发现：
 *   - 抖音网页版把画面与声音拆成两条无后缀的独立流：
 *       .../media-video-hvc1/?...   （Content-Type: video/mp4）
 *       .../media-audio-und-mp4a/?...（Content-Type: audio/mp4）
 *   - 我们的嗅探只处理 video/*，audio/mp4 的响应被完全忽略 → 音频轨从未进入列表；
 *   - 且配对池只认 fmp4 类型（B站 .m4s 场景），无后缀的 video/audio 条目不参与配对；
 *   - 两条轨的 URL 路径结构完全不同，按路径分组永远配不上 → 即使抓到了也配不成对。
 *
 * 本测试用本地服务精确复现上述形态（无后缀 URL + video/mp4 + audio/mp4），验证：
 *   1. 音频轨（audio/mp4）能被嗅探到，且记为 kind=audio
 *   2. 视频轨（video/mp4，无后缀）记为 kind=video
 *   3. PROBE_HEADS 能识别出两者各自的轨道角色
 *   4. START_MERGE 能把两条轨合并落盘为一个含画面与声音的 MP4
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VF = join(__dirname, 'fixtures', 'dash', 'bili_video_30032_head.m4s');
const AF = join(__dirname, 'fixtures', 'dash', 'bili_audio_30216_head.m4s');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.DOUYIN_E2E_PORT || 9999);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.error('  ✗ ' + n + '\n      ' + (e && (e.stack || e.message) || e)); };
const eq = (a, b, n) => { if (a === b) ok(n + ' = ' + JSON.stringify(a)); else bad(n + '：期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); };
const truthy = (v, n) => { if (v) ok(n); else bad(n); };

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

/* 用扩展自带的 Fmp4Merge 解析合并产物，确认双轨齐全。
   fmp4merge.js 是 UMD 风格（挂到 self 或 globalThis）：Node 里没有 self，会挂到 globalThis。 */
async function inspectMerged(file) {
  const buf = new Uint8Array(readFileSync(file));
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  req(join(ROOT, 'lib', 'fmp4merge.js'));
  const shared = globalThis.Fmp4Merge;
  if (!shared) throw new Error('无法载入 lib/fmp4merge.js');
  const info = shared.inspect(buf);
  return { ok: info.ok, hasVideo: info.hasVideo, hasAudio: info.hasAudio, kind: info.kind, reason: info.reason || '' };
}

let server = null, chrome = null, cdp = null;

async function main() {
  if (!existsSync(VF) || !existsSync(AF)) throw new Error('缺少测试样本，请检查 test/fixtures/dash/');

  const vBuf = readFileSync(VF);
  const aBuf = readFileSync(AF);
  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-douyin-e2e-'));
  const dlDir = join(tmp, 'dl');
  const prof = join(tmp, 'prof');
  mkdirSync(dlDir, { recursive: true });
  mkdirSync(prof, { recursive: true });

  try {
    console.log('\n[0] 准备本地素材服务（精确复现抖音形态：无后缀 URL + video/mp4 + audio/mp4）');
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>douyin style test</title></head><body>
<script>
  /* 抖音用 MSE 播分离轨；此处用 fetch 模拟同样的两条独立请求 */
  Promise.all([
    fetch('/tos-cn-ve-15/oQv001/media-video-hvc1/?a=6383&ch=26&sig=demo-v'),
    fetch('/tos-cn-ve-15/oQa002/media-audio-und-mp4a/?a=6383&ch=26&sig=demo-a')
  ]).then(function(){ document.title = 'fetched'; });
<\/script></body></html>`;

    server = createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      /* 两条轨都是无后缀地址，仅靠 Content-Type 区分（与抖音一致） */
      if (p === '/tos-cn-ve-15/oQv001/media-video-hvc1/') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': vBuf.length, 'Access-Control-Allow-Origin': '*' });
        res.end(vBuf);
        return;
      }
      if (p === '/tos-cn-ve-15/oQa002/media-audio-und-mp4a/') {
        res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': aBuf.length, 'Access-Control-Allow-Origin': '*' });
        res.end(aBuf);
        return;
      }
      if (p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(page);
        return;
      }
      res.writeHead(404); res.end('nf');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const PAGE_URL = 'http://127.0.0.1:' + PORT + '/';
    console.log('  页面: ' + PAGE_URL + '（视频轨 ' + (vBuf.length / 1024).toFixed(0) + ' KB，音频轨 ' + (aBuf.length / 1024).toFixed(0) + ' KB）');
    ok('本地已托管抖音形态的双轨样本');

    console.log('\n[1] 启动无头浏览器并加载扩展');
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
    ok('扩展已加载（ID: ' + loaded.id + '）');

    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    console.log('\n[2] 打开页面，验证两条无后缀轨均被嗅探（核心修复点）');
    const pT = (await cdp.send('Target.createTarget', { url: PAGE_URL })).targetId;
    await cdp.send('Target.attachToTarget', { targetId: pT, flatten: true });
    await sleep(4500);

    const dump = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get(null).then(a=>JSON.stringify(a).slice(0,30000))') || '{}');
    const items = [];
    for (const k of Object.keys(dump)) {
      if (!k.startsWith('tab:')) continue;
      const it = (dump[k] && dump[k].items) || {};
      for (const u of Object.keys(it)) items.push(it[u]);
    }
    console.log('  嗅探结果: ' + (items.map((i) => i.kind + ' : ' + i.url.replace(/^https?:\/\/[^/]+/, '')).join('\n            ') || '(空)'));

    const videoItem = items.find((i) => /media-video-hvc1/.test(i.url));
    const audioItem = items.find((i) => /media-audio-und-mp4a/.test(i.url));

    truthy(videoItem, '无后缀视频轨（video/mp4）被嗅探到');
    if (videoItem) eq(videoItem.kind, 'video', '视频轨类型');
    else bad('视频轨未抓到');

    /* 这一条是本次修复的核心：修复前 audio/mp4 的响应会被完全忽略，条目根本不存在 */
    truthy(audioItem, '无后缀音频轨（audio/mp4）被嗅探到 ← 修复前此条完全丢失');
    if (audioItem) eq(audioItem.kind, 'audio', '音频轨类型（新增的 audio 类别）');
    else bad('音频轨未抓到 —— audio/mp4 响应仍被忽略');

    console.log('\n[3] 轨道识别（PROBE_HEADS 覆盖 video/audio 类型条目）');
    const probeRes = JSON.parse(await ev(cdp, swS,
      `handleMessage({type:'PROBE_HEADS',pageUrl:${JSON.stringify(PAGE_URL)},items:${JSON.stringify(items.filter((i) => i.kind === 'video' || i.kind === 'audio' || i.kind === 'fmp4').map((i) => ({ url: i.url, pageUrl: PAGE_URL })))}},{}).then(r=>JSON.stringify(r))`));
    const heads = (probeRes && probeRes.heads) || {};
    for (const u of Object.keys(heads)) {
      const h = heads[u];
      console.log('  ' + u.replace(/^https?:\/\/[^/]+/, '').slice(0, 60) + '  →  ' + (h.ok ? (h.label + ' ' + (h.detail || '') + ' ' + (h.codec || '')) : ('识别失败: ' + h.error)));
    }
    const vHeads = Object.keys(heads).filter((u) => heads[u].ok && heads[u].role === 'video');
    const aHeads = Object.keys(heads).filter((u) => heads[u].ok && heads[u].role === 'audio');
    eq(vHeads.length, 1, '识别出的视频轨数量');
    eq(aHeads.length, 1, '识别出的音频轨数量');

    console.log('\n[4] 触发合并下载（START_MERGE）');
    const started = JSON.parse(await ev(cdp, swS,
      `handleMessage({type:'START_MERGE',tabId:-1,videoUrl:${JSON.stringify(vHeads[0] || '')},audioUrl:${JSON.stringify(aHeads[0] || '')},pageUrl:${JSON.stringify(PAGE_URL)},name:'douyin-e2e',folder:'',saveMethod:'anchor'},{}).then(r=>JSON.stringify(r))`));
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

    console.log('\n[5] 校验落盘文件确实"有画面也有声音"');
    await sleep(2500);
    const files = readdirSync(dlDir, { recursive: true });
    console.log('  下载目录: ' + (files.join(', ') || '(空)'));
    const f = files.find((x) => /\.mp4$/.test(x));
    if (!f) throw new Error('下载目录没有 mp4 文件');

    const info = await inspectMerged(join(dlDir, f));
    console.log('  合并文件结构: ' + JSON.stringify(info));
    truthy(info.ok, '合并产物是有效 MP4（moov 解析成功）');
    truthy(info.hasVideo, '合并产物含视频轨（handler=vide）');
    truthy(info.hasAudio, '合并产物含音频轨（handler=soun）← 修复前这一步无从谈起（音频轨都抓不到）');
    eq(info.kind, 'both', '轨道构成');

    const size = readFileSync(join(dlDir, f)).length;
    ok('文件大小 ' + (size / 1024).toFixed(0) + ' KB（视频轨 ' + (vBuf.length / 1024).toFixed(0) + ' + 音频轨 ' + (aBuf.length / 1024).toFixed(0) + '）');
  } catch (e) {
    bad('测试流程', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(600);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log('抖音形态（无后缀分离轨）：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
