/* ============================================================
 * YouTube 形态端到端：无后缀 + &mime= 声明角色 + &range= 分片 + WebM 轨合并
 * 运行：node test/e2e_youtube_style.mjs
 *
 * 这是「音视频分离」里信息量最大的一种形态，四个坑叠在一起：
 *   ① 两条轨的路径完全相同（/videoplayback），只能靠 query 区分
 *   ② 角色不写在路径里，靠 &mime=video%2Fwebm / audio%2Fwebm 声明
 *   ③ 一条轨被切成多个 &range=0-999999 请求 —— 若各算一条，下载只有前 1MB
 *   ④ 轨是 WebM（VP8/Opus）不是 fMP4 —— 合并器必须认得出容器
 *
 * 顺带把「WebM 合并」这条链路放进真 Chrome 里跑一遍：此前只在 Node 单测里验证过。
 * ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEBM = join(__dirname, 'fixtures', 'webm');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.YT_E2E_PORT || 10063);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLib(file, name) {
  const src = readFileSync(join(ROOT, 'lib', file), 'utf8');
  const sb = { self: undefined, console };
  new Function('self', 'globalThis', src + '\n;return self;')(sb, sb);
  return sb[name] || globalThis[name];
}
const WebmMerge = loadLib('webmmerge.js', 'WebmMerge');
const MediaRole = loadLib('mediarole.js', 'MediaRole');

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

let server = null, chrome = null, cdp = null;

async function main() {
  const vBuf = readFileSync(join(WEBM, 'rec_video_only.webm'));
  const aBuf = readFileSync(join(WEBM, 'rec_audio_only.webm'));
  const VID = 'o-E2ETESTID';
  const CLEN_V = vBuf.length, CLEN_A = aBuf.length;

  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-yt-e2e-'));
  const dlDir = join(tmp, 'dl');
  const prof = join(tmp, 'prof');
  mkdirSync(dlDir, { recursive: true });
  mkdirSync(prof, { recursive: true });

  try {
    console.log('\n[0] 参照产物：Node 侧直接合并两条 WebM 轨');
    const refMerge = WebmMerge.mergeAv(new Uint8Array(vBuf), new Uint8Array(aBuf));
    const ref = Buffer.from(refMerge.data);
    console.log('  参照: ' + (ref.length / 1024).toFixed(0) + ' KB · ' + (refMerge.note || ''));
    ok('参照合并完成');

    console.log('\n[1] 托管 YouTube 形态的地址（同路径、query 区分、range 切片）');
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>yt style</title></head><body><script>
    (function(){
      var V='${VID}';
      var ranges=[[0,9999],[10000,19999],[20000,0]];   /* 0 表示到末尾 */
      var ps=[];
      for (var i=0;i<ranges.length;i++){
        var lo=ranges[i][0], hi=ranges[i][1];
        ps.push(fetch('/videoplayback?id='+V+'&itag=248&mime=video%2Fwebm&clen=${CLEN_V}&dur=5.6&range='+lo+'-'+(hi||(''+( ${CLEN_V} -1)))));
        ps.push(fetch('/videoplayback?id='+V+'&itag=251&mime=audio%2Fwebm&clen=${CLEN_A}&dur=5.6&range='+lo+'-'+(hi||(''+( ${CLEN_A} -1)))));
      }
      Promise.all(ps).then(function(rs){ return Promise.all(rs.map(function(r){return r.arrayBuffer();})); })
        .then(function(){ document.title='fetched'; });
    })();
    <\/script></body></html>`;

    server = createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(page);
      }
      if (u.pathname === '/videoplayback') {
        const mime = u.searchParams.get('mime') || '';
        const isAudio = /audio/.test(mime);
        const full = isAudio ? aBuf : vBuf;
        let body = full;
        const r = u.searchParams.get('range');
        if (r) {
          const m = /^(\d+)-(\d*)$/.exec(r);
          if (m) {
            const lo = parseInt(m[1], 10);
            const hi = m[2] ? Math.min(parseInt(m[2], 10), full.length - 1) : full.length - 1;
            body = full.subarray(lo, hi + 1);
          }
        }
        res.writeHead(200, {
          'Content-Type': mime || 'application/octet-stream',
          'Content-Length': body.length,
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(body);
      }
      res.writeHead(404); res.end('nf');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const BASE = 'http://127.0.0.1:' + server.address().port;
    console.log('  页面: ' + BASE + '/（画面轨 ' + (CLEN_V / 1024).toFixed(0) + ' KB / 声音轨 ' + (CLEN_A / 1024).toFixed(0) + ' KB，各切 3 段取）');
    ok('本地已托管 YouTube 形态地址');

    console.log('\n[2] 光靠 URL 能否判出角色（不依赖任何响应头）');
    const probeRole = (itag, mime) => MediaRole.roleFromUrl(BASE + '/videoplayback?id=' + VID + '&itag=' + itag + '&mime=' + mime + '&clen=1&dur=5.6&range=0-9999');
    eq(probeRole(248, 'video%2Fwebm'), 'video', 'itag=248 + mime=video/webm');
    eq(probeRole(251, 'audio%2Fwebm'), 'audio', 'itag=251 + mime=audio/webm');
    eq(MediaRole.roleFromUrl(BASE + '/videoplayback?id=' + VID + '&itag=137'), 'video', '只有 itag=137 时靠编号表');
    const stripped = MediaRole.stripSliceParams(BASE + '/videoplayback?id=' + VID + '&itag=251&mime=audio%2Fwebm&clen=1&range=0-9999');
    if (!/range=/.test(stripped)) ok('分片参数可被摘掉：' + stripped.split('?')[1]);
    else bad('分片参数未摘掉: ' + stripped);

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
    await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    await sleep(1500);
    const swT = (await cdp.send('Target.getTargets')).targetInfos.find((x) => x.type === 'service_worker' && /background/.test(x.url));
    if (!swT) throw new Error('扩展未加载');
    const swS = (await cdp.send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swS);
    ok('扩展已加载');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    console.log('\n[4] 打开页面：同一路径的多个 range 请求应归并成 2 条轨');
    const pT = (await cdp.send('Target.createTarget', { url: BASE + '/' })).targetId;
    const pS = (await cdp.send('Target.attachToTarget', { targetId: pT, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pS);
    await sleep(4000);

    const dump = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get(null).then(a=>JSON.stringify(a).slice(0,60000))') || '{}');
    const items = [];
    for (const k of Object.keys(dump)) {
      if (!k.startsWith('tab:')) continue;
      const it = (dump[k] && dump[k].items) || {};
      for (const u of Object.keys(it)) items.push(it[u]);
    }
    console.log('  嗅探: ' + (items.map((i) => i.kind + '(' + (i.role || '-') + ')' + ':' + (i.url.match(/itag=(\d+)/) || [, '?'])[1]).join('  ') || '(空)'));
    eq(items.length, 2, '列表条目数（6 个 range 请求归并为 2 条）');
    const vIt = items.find((i) => i.role === 'video');
    const aIt = items.find((i) => i.role === 'audio');
    if (vIt && aIt) ok('两条轨的角色都已判定（video / audio）');
    else bad('角色判定失败: ' + JSON.stringify(items.map((i) => ({ k: i.kind, r: i.role }))));
    if (vIt && !/range=/.test(vIt.url)) ok('存储的地址已摘掉 &range=（否则只会下到第一个分片）');
    else bad('地址仍带 range: ' + (vIt && vIt.url));
    eq(vIt && vIt.size, CLEN_V, '画面轨体积取自 clen（整轨，不是分片）');
    eq(aIt && aIt.size, CLEN_A, '声音轨体积取自 clen');

    console.log('\n[5] 轨道识别（PROBE_HEADS）：WebM 轨要走 WebM 分支');
    const probeRes = JSON.parse(await ev(cdp, swS,
      'handleMessage(' + JSON.stringify({
        type: 'PROBE_HEADS', pageUrl: BASE + '/',
        items: [{ url: vIt.url, pageUrl: BASE + '/' }, { url: aIt.url, pageUrl: BASE + '/' }]
      }) + ',{}).then(r=>JSON.stringify(r))'));
    const heads = (probeRes && probeRes.heads) || {};
    for (const u of Object.keys(heads)) {
      const h = heads[u];
      console.log('  itag=' + (u.match(/itag=(\d+)/) || [, '?'])[1] + '  →  ' +
        (h.ok ? (h.label + ' ' + (h.detail || '') + ' ' + (h.codec || '') + ' ' + (h.container || '')) : ('失败: ' + h.error)));
    }
    const hv = heads[vIt.url], ha = heads[aIt.url];
    if (hv && hv.ok && hv.role === 'video' && hv.container === 'webm') ok('画面轨识别为 WebM 视频轨（' + hv.codec + ' ' + hv.detail + '）');
    else bad('画面轨识别异常: ' + JSON.stringify(hv));
    if (ha && ha.ok && ha.role === 'audio' && ha.container === 'webm') ok('声音轨识别为 WebM 音频轨（' + ha.codec + ' ' + ha.detail + '）');
    else bad('声音轨识别异常: ' + JSON.stringify(ha));

    console.log('\n[6] START_MERGE：两条 WebM 轨在扩展里合并');
    const started = JSON.parse(await ev(cdp, swS,
      'handleMessage(' + JSON.stringify({
        type: 'START_MERGE', tabId: -1, videoUrl: vIt.url, audioUrl: aIt.url,
        pageUrl: BASE + '/', name: 'yt-style-e2e', folder: '', saveMethod: 'anchor'
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
    if (task && task.status === 'done') ok('合并任务完成：' + (task.sizeStr || '') + '（' + task.phase + '）');
    else bad('合并任务未完成: ' + JSON.stringify(task));
    if (task && /合并/.test(task.note || '')) ok('任务说明：' + task.note);
    else bad('任务未报告合并信息: ' + (task && task.note));

    console.log('\n[7] 产物校验：必须是 WebM（不能错标成 .mp4），且与参照一致');
    await sleep(2500);
    const files = readdirSync(dlDir, { recursive: true });
    console.log('  下载目录: ' + (files.join(', ') || '(空)'));
    const f = files.find((x) => /\.webm$/.test(x));
    if (f) ok('落盘后缀为 .webm（按内容判容器，没有硬写 .mp4）: ' + f);
    else bad('未找到 .webm 文件：' + files.join(', '));
    if (files.some((x) => /\.mp4$/.test(x))) bad('出现了 .mp4 —— 后缀骗人，播放器会用错解码器');
    else ok('没有错标成 .mp4 的文件');
    if (f) {
      const got = readFileSync(join(dlDir, f));
      console.log('  扩展产物: ' + (got.length / 1024).toFixed(0) + ' KB   参照: ' + (ref.length / 1024).toFixed(0) + ' KB');
      if (got.equals(ref)) ok('产物与 Node 侧参照逐字节一致');
      else {
        bad('产物与参照不一致：' + got.length + ' B vs ' + ref.length + ' B');
        const n = Math.min(got.length, ref.length);
        let firstDiff = -1;
        for (let i = 0; i < n; i++) if (got[i] !== ref[i]) { firstDiff = i; break; }
        console.log('    首个差异字节位置: ' + firstDiff);
      }
      /* 用 Chrome 打开，确认画面与声音都在 */
      console.log('\n[8] Chrome 打开产物：画面 + 声音都要有');
      const fileUrl = 'file:///' + join(dlDir, f).split('\\').join('/');
      const fT = (await cdp.send('Target.createTarget', { url: fileUrl })).targetId;
      const fS = (await cdp.send('Target.attachToTarget', { targetId: fT, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, fS);
      await sleep(5000);
      const st = JSON.parse(await ev(cdp, fS, `JSON.stringify((function(){
        var v=document.querySelector('video');
        if(!v) return {none:true};
        return { duration:v.duration, w:v.videoWidth, h:v.videoHeight, audio:v.webkitAudioDecodedByteCount||0, err:v.error?v.error.code:0 };
      })())`));
      console.log('  播放状态: ' + JSON.stringify(st));
      if (st.w > 0 && st.h > 0 && !st.err) ok('画面可解码：' + st.w + '×' + st.h + '，时长 ' + (st.duration || 0).toFixed(2) + 's');
      else bad('画面解码异常: ' + JSON.stringify(st));
      if (st.audio > 0) ok('声音可解码 ' + (st.audio / 1024).toFixed(0) + ' KB（不再是「视频没有声音」）');
      else bad('未解码出声音数据: ' + JSON.stringify(st));
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
    console.log('YouTube 形态端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
