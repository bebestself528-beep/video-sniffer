/* ============================================================
 * 本地验证页自检（离线，无需手动点击）
 * 运行：
 *   1) 另开一个终端：node test/serve_local.mjs
 *   2) node test/verify_local_page.mjs
 *
 * 作用：用无头浏览器模拟"打开本地验证页 → 点按钮 → 点扩展 → 下载"
 *       的完整流程，确认这条链路在你当前机器上确实能跑通。
 *       手动验证之前先跑一遍，可以排除环境问题（端口/权限/浏览器版本）。
 * 环境变量：PORT 指定本地服务端口（默认 8765）；CHROME_PATH 指定浏览器。
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 8765);
const PAGE = 'http://127.0.0.1:' + PORT + '/';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.VERIFY_PORT || 9666);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pass = [], fail = [];
const P = (s) => { pass.push(s); console.log('  ✓ ' + s); };
const F = (s) => { fail.push(s); console.error('  ✗ ' + s); };

/* 以 Node 方式加载纯逻辑库（与扩展内是同一份代码），用于解析清单与校验产物结构 */
function loadLib(file, name) {
  const src = readFileSync(join(ROOT, 'lib', file), 'utf8');
  const sb = { self: undefined, console };
  new Function('self', 'globalThis', src + '\n;return self;')(sb, sb);
  return sb[name] || globalThis[name];
}
const MpdKit = loadLib('mpd.js', 'MpdKit');
const Fmp4Merge = loadLib('fmp4merge.js', 'Fmp4Merge');

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
      this.ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
    });
  }
  send(method, params, sid) {
    const id = this.n++;
    return new Promise((res, rej) => {
      this.p.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId: sid }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
async function ev(cdp, sid, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

/* 先确认本地服务在线（避免把"服务没开"误判成"扩展有问题"） */
try {
  const r = await fetch(PAGE, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  console.log('本地验证服务在线: ' + PAGE);
} catch (e) {
  console.error('\n✗ 无法访问 ' + PAGE + '：' + (e.message || e));
  console.error('  请先另开一个终端运行：node test/serve_local.mjs\n');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-local-'));
const dlDir = join(tmp, 'dl');
mkdirSync(dlDir, { recursive: true });
let proc = null, cdp = null;

async function main() {
  proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + join(tmp, 'prof'),
    '--enable-unsafe-extension-debugging', '--load-extension=' + ROOT, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let ws = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { ws = (await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json()).webSocketDebuggerUrl; break; } catch (e) { /* retry */ }
  }
  if (!ws) throw new Error('浏览器调试端口未就绪');
  cdp = new CDP(ws); await cdp.connect();

  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
  await sleep(1500);

  const swT = (await cdp.send('Target.getTargets')).targetInfos.find((x) => x.type === 'service_worker' && /background/.test(x.url));
  if (!swT) throw new Error('扩展 Service Worker 未启动');
  const swS = (await cdp.send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, swS);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  P('扩展已加载并启动（ID: ' + extId + '）');

  /* 打开本地验证页 */
  const pT = (await cdp.send('Target.createTarget', { url: PAGE })).targetId;
  const pS = (await cdp.send('Target.attachToTarget', { targetId: pT, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, pS);
  await sleep(2500);

  const title = await ev(cdp, pS, 'document.title');
  if (/离线验证页/.test(title)) P('验证页打开正常：' + title); else F('页面标题异常: ' + title);

  /* 点击页面上的按钮，制造 HLS 网络请求 */
  await ev(cdp, pS, `document.getElementById('btnHls').click(), 'ok'`);
  console.log('  已点击「请求 m3u8 + 3 个 TS 分片」，等待嗅探…');
  await sleep(4000);

  const dump = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get(null).then(a => JSON.stringify(a).slice(0,30000))') || '{}');
  const items = [];
  for (const k of Object.keys(dump)) {
    if (!k.startsWith('tab:')) continue;
    const it = (dump[k] && dump[k].items) || {};
    for (const u of Object.keys(it)) items.push(it[u]);
  }
  console.log('  嗅探结果: ' + (items.map((i) => i.kind + ':' + i.url.split('/').pop()).join(', ') || '(空)'));

  const m3u8 = items.find((i) => /stream\.m3u8/.test(i.url));
  if (m3u8 && m3u8.kind === 'hls') P('嗅探到 stream.m3u8（类型 hls）'); else F('未嗅探到 stream.m3u8');
  const tsCount = items.filter((i) => /\.ts$/.test(i.url)).length;
  if (tsCount >= 3) P('嗅探到 ' + tsCount + ' 个 TS 分片'); else F('TS 分片仅 ' + tsCount + ' 个');
  const mp4 = items.find((i) => /flower\.mp4/.test(i.url));
  if (mp4 && mp4.kind === 'mp4') P('嗅探到 flower.mp4（类型 mp4）'); else F('未嗅探到 flower.mp4');

  /* 触发 HLS 下载（等价于点「选择清晰度」→「直接下载」） */
  console.log('\n  触发 HLS 合并下载（分片下载 → 合并 → TS 转 MP4 → 落盘）…');
  const started = JSON.parse(await ev(cdp, swS,
    `handleMessage({type:'START_HLS',tabId:-1,url:${JSON.stringify(PAGE + 'stream.m3u8')},pageUrl:${JSON.stringify(PAGE)},name:'local-verify',folder:'',format:'auto',concurrency:6,saveMethod:'anchor'},{}).then(r=>JSON.stringify(r))`));
  if (!started.taskId) throw new Error('任务创建失败: ' + JSON.stringify(started));

  let task = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const t = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get("tasks").then(a=>JSON.stringify(a))') || '{}').tasks || {};
    task = t[started.taskId];
    if (task && task.status !== 'running') break;
    if (i % 5 === 0 && task) console.log('    … ' + task.phase + ' ' + (task.done || 0) + '/' + (task.total || '?') + ' ' + ((task.bytes || 0) / 1024).toFixed(0) + 'KB');
  }
  if (task && task.status === 'done') P('下载任务完成：' + (task.sizeStr || '') + '（保存方式 ' + (task.saveVia || '?') + '）');
  else F('下载未完成: ' + JSON.stringify(task));

  await sleep(2500);
  const files = readdirSync(dlDir, { recursive: true });
  const f = files.find((x) => /\.mp4$|\.ts$/.test(x));
  if (f) {
    const buf = readFileSync(join(dlDir, f));
    const isFtyp = buf.toString('latin1', 4, 8) === 'ftyp';
    if (isFtyp && buf.length > 100 * 1024) P('文件已落盘且为有效 MP4：' + f + ' (' + (buf.length / 1024).toFixed(0) + ' KB，头含 ftyp)');
    else F('落盘文件异常：' + f + ' (' + (buf.length / 1024).toFixed(0) + ' KB，' + (isFtyp ? '含 ftyp' : '无 ftyp') + ')');
  } else F('下载目录中没有视频文件（内容: ' + files.join(', ') + '）');

  /* ---------------- DASH 音视频分离场景（测试 4） ---------------- */
  console.log('\n  点击「请求 mpd + 两条独立轨」，验证 DASH 音视频分离场景…');
  await ev(cdp, pS, `document.getElementById('btnDash').click(), 'ok'`);
  await sleep(4000);

  const dump2 = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get(null).then(a => JSON.stringify(a).slice(0,30000))') || '{}');
  const items2 = [];
  for (const k of Object.keys(dump2)) {
    if (!k.startsWith('tab:')) continue;
    const it = (dump2[k] && dump2[k].items) || {};
    for (const u of Object.keys(it)) items2.push(it[u]);
  }
  const tracks = items2.filter((i) => /movie-1-\d+\.m4s$/.test(i.url));
  console.log('  DASH 相关条目: ' + (items2.filter((i) => /dash\//.test(i.url)).map((i) => i.kind + ':' + i.url.split('/').pop()).join(', ') || '(空)'));

  const mpdItem = items2.find((i) => /stream\.mpd/.test(i.url));
  if (mpdItem && mpdItem.kind === 'dash') P('嗅探到 stream.mpd（DASH 清单）'); else F('未嗅探到 stream.mpd');
  if (tracks.length >= 2) P('嗅探到 ' + tracks.length + ' 条独立轨（.m4s）'); else F('独立轨仅 ' + tracks.length + ' 条（应为 2）');

  if (tracks.length >= 2) {
    const probe = JSON.parse(await ev(cdp, swS,
      `handleMessage({type:'PROBE_HEADS',pageUrl:${JSON.stringify(PAGE)},items:${JSON.stringify(tracks.map((i) => ({ url: i.url, pageUrl: PAGE })))}},{}).then(r=>JSON.stringify(r))`));
    const heads = (probe && probe.heads) || {};
    for (const u of Object.keys(heads)) {
      const h = heads[u];
      console.log('    ' + u.split('/').pop() + '  →  ' + (h.ok ? (h.role + '  ' + (h.detail || '') + ' ' + (h.codec || '')) : ('识别失败: ' + h.error)));
    }
    const roles = Object.values(heads).filter((h) => h.ok).map((h) => h.role).sort().join(',');
    if (roles === 'audio,video') P('轨道识别正确：1 条视频轨 + 1 条音频轨（可自动配对合并）');
    else F('轨道识别异常: ' + JSON.stringify(roles));
    const vInfo = Object.values(heads).find((h) => h.ok && h.role === 'video');
    const aInfo = Object.values(heads).find((h) => h.ok && h.role === 'audio');
    if (vInfo && vInfo.width) P('视频轨信息：' + vInfo.width + '×' + vInfo.height + ' ' + vInfo.codec);
    if (aInfo && aInfo.channels) P('音频轨信息：' + aInfo.channels + 'ch ' + aInfo.sampleRate + 'Hz ' + aInfo.codec);
  }

  /* ---------------- DASH 分片形态（测试 5）：清单 → 分片下载 → 合并 ---------------- */
  console.log('\n  点击「请求分片形态的 mpd + 全部 init/分片」，验证清单驱动的分片轨…');
  await ev(cdp, pS, `document.getElementById('btnDash2').click(), 'ok'`);
  await sleep(5000);

  const dump3 = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get(null).then(a => JSON.stringify(a).slice(0,60000))') || '{}');
  const items3 = [];
  for (const k of Object.keys(dump3)) {
    if (!k.startsWith('tab:')) continue;
    const it = (dump3[k] && dump3[k].items) || {};
    for (const u of Object.keys(it)) items3.push(it[u]);
  }
  const mpd2 = items3.find((i) => /dash2\/stream\.mpd/.test(i.url));
  const segs = items3.filter((i) => /dash2\/(video|audio)\/\d{5}\.m4s$/.test(i.url));
  const inits = items3.filter((i) => /dash2\/(video|audio)\/init\.mp4$/.test(i.url));
  console.log('  嗅探结果: ' + (mpd2 ? 'DASH 清单 1 份' : '无清单') + '，分片 ' + segs.length + ' 个，init 段 ' + inits.length + ' 个');
  if (mpd2 && mpd2.kind === 'dash') P('嗅探到 dash2 的 stream.mpd（类型 dash）'); else F('未嗅探到 dash2 的 stream.mpd');
  if (segs.length >= 15) P('嗅探到 ' + segs.length + ' 个分片（清单里共 15 个）'); else F('分片仅 ' + segs.length + ' 个');

  /* 用清单解析器复算一遍：地址拼装与分片数应与服务端列出的完全一致 */
  const mpdText = await (await fetch(PAGE + 'dash2/stream.mpd')).text();
  const parsed = MpdKit.parseMpd(mpdText, PAGE + 'dash2/stream.mpd');
  const rv = parsed.representations.find((r) => r.role === 'video');
  const ra = parsed.representations.find((r) => r.role === 'audio');
  if (rv && rv.segmentUrls.length === 7) P('清单解析：画面轨 7 个分片，init 段 ' + rv.initUrl.split('/').slice(-2).join('/'));
  else F('画面轨分片数异常: ' + (rv && rv.segmentUrls.length));
  if (ra && ra.segmentUrls.length === 8) P('清单解析：声音轨 8 个分片'); else F('声音轨分片数异常: ' + (ra && ra.segmentUrls.length));

  /* 真走一遍：分片下载 → 各自拼接 → 合并 → 落盘 */
  if (rv && ra) {
    console.log('\n  触发 DASH 合并下载（16 个分片 → 两条完整轨 → 合并 → 落盘）…');
    const specs = JSON.stringify({
      videoSpec: { parts: rv.segmentUrls, initUrl: rv.initUrl },
      audioSpec: { parts: ra.segmentUrls, initUrl: ra.initUrl }
    });
    const st2 = JSON.parse(await ev(cdp, swS,
      `handleMessage(Object.assign({type:'START_MERGE',tabId:-1,videoUrl:${JSON.stringify(rv.segmentUrls[0])},audioUrl:${JSON.stringify(ra.segmentUrls[0])},pageUrl:${JSON.stringify(PAGE)},name:'local-verify-dash',folder:'',saveMethod:'anchor'},${specs}),{}).then(r=>JSON.stringify(r))`));
    if (!st2.taskId) throw new Error('DASH 任务创建失败: ' + JSON.stringify(st2));
    let t2 = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const t = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get("tasks").then(a=>JSON.stringify(a))') || '{}').tasks || {};
      t2 = t[st2.taskId];
      if (t2 && t2.status !== 'running') break;
    }
    if (t2 && t2.status === 'done') P('DASH 合并任务完成：' + (t2.sizeStr || '') + '（' + t2.phase + '）');
    else F('DASH 合并任务未完成: ' + JSON.stringify(t2));
    if (t2 && /合并/.test(t2.note || '')) P('任务说明：' + t2.note);

    await sleep(2500);
    const files2 = readdirSync(dlDir, { recursive: true });
    const fd = files2.find((x) => /local-verify-dash\.\w+$/.test(x));
    if (fd) {
      const buf = readFileSync(join(dlDir, fd));
      const info = Fmp4Merge.inspect(new Uint8Array(buf));
      const handlers = info.traks.map((x) => x.handler).sort().join(',');
      if (handlers === 'soun,vide') P('DASH 产物含画面与声音两条轨：' + fd + ' (' + (buf.length / 1024).toFixed(0) + ' KB)');
      else F('DASH 产物轨道异常: ' + handlers);
    } else F('未找到 DASH 产物文件（目录: ' + files2.join(', ') + '）');
  }
}

try {
  await main();
} catch (e) {
  F('异常: ' + (e && (e.message || e)));
} finally {
  try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
  if (proc && proc.pid) { try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
  await sleep(600);
  try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n========================================');
  console.log('本地链路自检：通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
  if (!fail.length) console.log('结论：这条链路在你当前机器上可用，可以开始手动验证。');
  console.log('========================================');
  process.exit(fail.length ? 1 : 0);
}
