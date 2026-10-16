/* ============================================================
 * DASH 音视频轨「合并下载」端到端测试
 * 运行：node test/e2e_merge.mjs
 *
 * 复现并回归验证用户反馈的问题：
 *   "B站把视频和音频分开下载了，这不合理"
 * 流程：
 *   1. 本地服务托管 B站 真实的视频轨 / 音频轨样本（test/fixtures/dash/）
 *   2. 页面同时请求两条轨，扩展应嗅探到 2 条 .m4s
 *   3. 调用 PROBE_HEADS：应正确识别出一条视频轨、一条音频轨
 *   4. 调用 START_MERGE：下载两条轨 → 本地合并 → 落盘为一个文件
 *   5. 校验落盘文件含 vide + soun 两条 trak（即"有画面也有声音"）
 * ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DASH = join(__dirname, 'fixtures', 'dash');
const VF = join(DASH, 'bili_video_30032_head.m4s');
const AF = join(DASH, 'bili_audio_30216_head.m4s');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.MERGE_E2E_PORT || 9999);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 以 Node 方式加载纯逻辑库，用于校验输出文件结构 */
const libSrc = readFileSync(join(ROOT, 'lib', 'fmp4merge.js'), 'utf8');
const sb = { self: undefined, console };
new Function('self', 'globalThis', libSrc + '\n;return self;')(sb, sb);
const Fmp4Merge = sb.Fmp4Merge || globalThis.Fmp4Merge;

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
  if (!existsSync(VF) || !existsSync(AF)) throw new Error('缺少测试样本，请检查 test/fixtures/dash/');

  const vBuf = readFileSync(VF);
  const aBuf = readFileSync(AF);
  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-merge-e2e-'));
  const dlDir = join(tmp, 'dl');
  const prof = join(tmp, 'prof');
  mkdirSync(dlDir, { recursive: true });
  mkdirSync(prof, { recursive: true });

  try {
    console.log('\n[0] 准备本地素材服务');
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>dash merge test</title></head><body>
<script>
  Promise.all([fetch('/v-30032.m4s'), fetch('/a-30216.m4s')]).then(function(){ document.title = 'fetched'; });
<\/script></body></html>`;

    server = createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const map = {
        '/': ['text/html; charset=utf-8', Buffer.from(page)],
        '/v-30032.m4s': ['video/mp4', vBuf],
        '/a-30216.m4s': ['video/mp4', aBuf]
      };
      if (!map[p]) { res.writeHead(404); res.end('nf'); return; }
      const [type, body] = map[p];
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const PAGE_URL = 'http://127.0.0.1:' + PORT + '/';
    console.log('  页面: ' + PAGE_URL + '（视频轨 ' + (vBuf.length / 1024).toFixed(0) + ' KB，音频轨 ' + (aBuf.length / 1024).toFixed(0) + ' KB）');
    ok('本地已托管 B站 真实音视频轨样本');

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
    const extId = loaded.id;
    await sleep(1500);

    const swT = (await cdp.send('Target.getTargets')).targetInfos.find((x) => x.type === 'service_worker' && /background/.test(x.url));
    if (!swT) throw new Error('扩展未加载');
    const swS = (await cdp.send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swS);
    ok('扩展已加载（ID: ' + extId + '）');

    /* 关键：background 里必须成功 importScripts 了 fmp4merge */
    const hasLib = await ev(cdp, swS, 'typeof Fmp4Merge !== "undefined" && typeof Fmp4Merge.classifyHead === "function"');
    if (hasLib) ok('后台 Service Worker 已载入 fmp4merge 库（importScripts 成功）');
    else bad('后台 Service Worker 未载入 fmp4merge 库');

    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    console.log('\n[2] 打开页面，验证两条轨均被嗅探');
    const pT = (await cdp.send('Target.createTarget', { url: PAGE_URL })).targetId;
    const pS = (await cdp.send('Target.attachToTarget', { targetId: pT, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pS);
    await sleep(4000);

    const dump = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get(null).then(a=>JSON.stringify(a).slice(0,30000))') || '{}');
    const items = [];
    for (const k of Object.keys(dump)) {
      if (!k.startsWith('tab:')) continue;
      const it = (dump[k] && dump[k].items) || {};
      for (const u of Object.keys(it)) items.push(it[u]);
    }
    const fmp4 = items.filter((i) => i.kind === 'fmp4');
    console.log('  嗅探结果: ' + (items.map((i) => i.kind + ':' + i.url.split('/').pop()).join(', ') || '(空)'));
    if (fmp4.length >= 2) ok('嗅探到 ' + fmp4.length + ' 条 .m4s 条目'); else bad('.m4s 条目不足：' + fmp4.length);

    console.log('\n[3] 轨道识别（PROBE_HEADS）');
    const probeRes = JSON.parse(await ev(cdp, swS,
      `handleMessage({type:'PROBE_HEADS',pageUrl:${JSON.stringify(PAGE_URL)},items:${JSON.stringify(fmp4.map((i) => ({ url: i.url, pageUrl: PAGE_URL })))}},{}).then(r=>JSON.stringify(r))`));
    const heads = (probeRes && probeRes.heads) || {};
    for (const u of Object.keys(heads)) {
      const h = heads[u];
      console.log('  ' + u.split('/').pop() + '  →  ' + (h.ok ? (h.label + ' ' + (h.detail || '') + ' ' + (h.codec || '')) : ('识别失败: ' + h.error)));
    }
    const roles = Object.values(heads).filter((h) => h.ok).map((h) => h.role).sort();
    if (roles.join(',') === 'audio,video') ok('正确识别出 1 条视频轨 + 1 条音频轨');
    else bad('轨道识别结果异常: ' + JSON.stringify(roles));

    const vUrl = Object.keys(heads).find((u) => heads[u].ok && heads[u].role === 'video');
    const aUrl = Object.keys(heads).find((u) => heads[u].ok && heads[u].role === 'audio');
    if (!vUrl || !aUrl) throw new Error('未能同时找到视频轨与音频轨');

    console.log('\n[4] 触发合并下载（START_MERGE）');
    const started = JSON.parse(await ev(cdp, swS,
      `handleMessage({type:'START_MERGE',tabId:-1,videoUrl:${JSON.stringify(vUrl)},audioUrl:${JSON.stringify(aUrl)},pageUrl:${JSON.stringify(PAGE_URL)},name:'merge-e2e',folder:'',saveMethod:'anchor'},{}).then(r=>JSON.stringify(r))`));
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
    if (task && /合并/.test(task.note || '')) ok('任务说明：' + task.note); else bad('任务未报告合并信息: ' + (task && task.note));

    console.log('\n[5] 校验落盘文件确实"有画面也有声音"');
    await sleep(2500);
    const files = readdirSync(dlDir, { recursive: true });
    console.log('  下载目录: ' + (files.join(', ') || '(空)'));
    const f = files.find((x) => /\.mp4$/.test(x));
    if (!f) throw new Error('下载目录没有 mp4 文件');
    const buf = new Uint8Array(readFileSync(join(dlDir, f)));
    const info = Fmp4Merge.inspect(buf);
    if (!info.ok) throw new Error('落盘文件不是合法 fMP4');
    const handlers = info.traks.map((t) => t.handler).sort();
    console.log('  文件: ' + f + '  ' + (buf.length / 1024).toFixed(0) + ' KB  轨道: ' + handlers.join(' + '));
    if (handlers.join(',') === 'soun,vide') ok('落盘文件同时含视频轨与音频轨（单文件，无需手动拼装）');
    else bad('落盘文件轨道异常: ' + handlers.join(','));
    const w = info.video && info.video.width, h = info.video && info.video.height;
    if (w && h) ok('视频轨信息：' + w + '×' + h + ' ' + info.video.codec);
    if (info.audio && info.audio.channels) ok('音频轨信息：' + info.audio.channels + 'ch ' + info.audio.sampleRate + 'Hz ' + info.audio.codec);
    if (files.filter((x) => /\.mp4$/.test(x)).length === 1) ok('只产生 1 个文件（不再出现音视频两个文件）');
    else bad('产生了多个文件: ' + files.join(', '));

    /* 顺带确认：下载到本地后波形/画面真的能播（用 Chrome 直接打开该文件） */
    console.log('\n[6] 用 Chrome 打开落盘文件，确认可播放');
    const fileUrl = 'file:///' + join(dlDir, f).split('\\').join('/');
    const fT = (await cdp.send('Target.createTarget', { url: fileUrl })).targetId;
    const fS = (await cdp.send('Target.attachToTarget', { targetId: fT, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, fS);
    await sleep(4000);
    const st = JSON.parse(await ev(cdp, fS, `JSON.stringify((function(){
      var v=document.querySelector('video');
      if(!v) return {none:true};
      return { duration:v.duration, w:v.videoWidth, h:v.videoHeight, readyState:v.readyState };
    })())`));
    console.log('  播放状态: ' + JSON.stringify(st));
    if (st.w > 0 && st.duration > 4) ok('本地文件可正常解析播放：' + st.w + '×' + st.h + '，时长 ' + st.duration.toFixed(1) + 's');
    else bad('本地文件播放异常: ' + JSON.stringify(st));
  } catch (e) {
    bad('端到端流程', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(800);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log('音视频合并端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
