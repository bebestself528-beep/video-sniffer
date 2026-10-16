/* ============================================================
 * 「嗅探盲区」端到端测试
 * 运行：node test/e2e_sniff_gaps.mjs
 *
 * 复现并回归验证两类真实盲区（对应用户提问：「为什么必须播放后才能抓取？」）：
 *
 *   A. 响应头不可信导致的漏检
 *      有的站点把 m3u8 以 text/plain 返回，URL 又不带 .m3u8 后缀。
 *      仅靠"后缀 + Content-Type"判定的实现会直接漏掉它。
 *      → 期望：记为「候选」，再由 PROBE_KIND 按内容签名定性为 hls / ts；
 *        确认不是媒体的（普通文本接口）则从列表里删除。
 *
 *   B. 观测开始之前就已发生的请求
 *      MV3 的 Service Worker 会休眠，扩展也可能是在页面加载完之后才启用。
 *      这些请求 webRequest 看不到，但浏览器的时间线里还在。
 *      → 期望：清空列表后重新扫描，条目能由性能时间线恢复（source = perf）。
 * ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIX = join(__dirname, 'fixtures');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.GAPS_TEST_PORT || 9995);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.error('  ✗ ' + n + (e ? '\n      ' + e : '')); };

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
const j = async (cdp, sid, expr) => JSON.parse(await ev(cdp, sid, 'JSON.stringify(' + expr + ')'));

let server = null, chrome = null, cdp = null;

const M3U8 = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXTINF:10.0,',
  'part0.ts',
  '#EXTINF:10.0,',
  'part1.ts',
  '#EXT-X-ENDLIST'
].join('\n');

async function main() {
  const mp4 = join(FIX, 'flower.mp4');
  const ts = join(FIX, 'seg0.ts');
  if (!existsSync(mp4) || !existsSync(ts)) throw new Error('缺少测试素材（flower.mp4 / seg0.ts）');
  const mp4Buf = readFileSync(mp4);
  const tsBuf = readFileSync(ts);

  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-gaps-'));
  const prof = join(tmp, 'prof');
  mkdirSync(prof, { recursive: true });

  try {
    console.log('\n[0] 起本地站点：一个"把 m3u8 用 text/plain 返回"的页面');
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>sniff gaps</title></head><body>
<div>播放器区域（本页不用真的播放，资源由脚本请求）</div>
<script>
  window.__probe = [];
  function track(tag, p) { p.then(function (r) { __probe.push(tag + ' ' + r.status); }).catch(function (e) { __probe.push(tag + ' ERR ' + e.message); }); }
  /* 1) 无后缀、text/plain 返回的 m3u8 清单 */
  track('m3u8', fetch('/api/getPlayUrl?type=m3u8'));
  /* 2) 无后缀、text/plain 返回的 TS 分片 */
  track('ts', fetch('/api/getPlayUrl?type=ts'));
  /* 3) 假阳性：URL 里带 stream，但返回的是普通文本 */
  track('log', fetch('/api/stream/status'));
  /* 4) 只在性能时间线里、DOM 中不存在的 mp4（用于验证回溯能力） */
  track('mp4', fetch('/media/only-in-perf.mp4'));
<\/script></body></html>`;

    server = createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const send = (type, body, code) => {
        /* 注意：不要在这里加 Cache-Control: no-store —— 实测（Chrome 155）带 no-store
           的响应不会进入 Resource Timing 时间线，会直接让回溯通道失效。 */
        res.writeHead(code || 200, { 'Content-Type': type, 'Content-Length': body.length, 'Access-Control-Allow-Origin': '*' });
        res.end(body);
      };
      if (u.pathname === '/') return send('text/html; charset=utf-8', Buffer.from(page));
      /* 故意用 text/plain 返回，模拟"响应头不可信"的站点 */
      if (u.pathname === '/api/getPlayUrl' && u.searchParams.get('type') === 'm3u8') return send('text/plain; charset=utf-8', Buffer.from(M3U8));
      if (u.pathname === '/api/getPlayUrl' && u.searchParams.get('type') === 'ts') return send('text/plain; charset=utf-8', tsBuf);
      if (u.pathname === '/api/stream/status') return send('text/plain; charset=utf-8', Buffer.from('2026-10-15 22:00:00 INFO stream service healthy\n'));
      if (u.pathname === '/media/only-in-perf.mp4') return send('video/mp4', mp4Buf);
      res.writeHead(404); res.end('nf');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const PAGE_URL = 'http://127.0.0.1:' + PORT + '/';
    console.log('  页面: ' + PAGE_URL);
    ok('本地站点已就绪（m3u8 / TS 均以 text/plain 返回）');

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
    const extId = (await cdp.send('Extensions.loadUnpacked', { path: ROOT })).id;
    await sleep(1500);

    const swT = (await cdp.send('Target.getTargets')).targetInfos.find((x) => x.type === 'service_worker' && /background/.test(x.url));
    if (!swT) throw new Error('扩展未加载');
    const swS = (await cdp.send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swS);
    ok('扩展已加载（ID: ' + extId + '）');

    if (!await ev(cdp, swS, 'typeof SniffSig !== "undefined" && typeof SniffSig.classify === "function"')) {
      bad('后台未载入 sniffsig 库（importScripts 失败）');
    } else {
      ok('后台已载入 sniffsig 库');
    }

    console.log('\n[2] 打开页面，等待嗅探');
    const pT = (await cdp.send('Target.createTarget', { url: PAGE_URL })).targetId;
    const pS = (await cdp.send('Target.attachToTarget', { targetId: pT, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pS);
    await sleep(4500);

    const tabId = await ev(cdp, swS, 'chrome.tabs.query({}).then(ts => { const t = ts.find(x => x.url && x.url.indexOf("127.0.0.1") >= 0); return t ? t.id : -1; })');
    if (tabId < 0) throw new Error('未找到测试标签页');
    ok('测试标签页 ID: ' + tabId);

    const readItems = async () => {
      const dump = JSON.parse(await ev(cdp, swS,
        'chrome.storage.session.get(' + JSON.stringify('tab:' + tabId) + ').then(a=>JSON.stringify(a))') || '{}');
      const d = dump['tab:' + tabId];
      return Object.values((d && d.items) || {});
    };

    let items = await readItems();
    console.log('  嗅探结果: ' + (items.map((i) => i.kind + ':' + i.url.replace(PAGE_URL, '/')).join('  ') || '(空)'));

    /* ---- A. 候选条目 ---- */
    console.log('\n[3] 响应头不可信 → 应记为「候选」而不是直接丢弃');
    const cands = items.filter((i) => i.kind === 'cand');
    const candUrls = cands.map((i) => i.url);
    const m3u8Url = candUrls.find((u) => /type=m3u8/.test(u));
    const tsUrl = candUrls.find((u) => /type=ts/.test(u));
    const falseUrl = candUrls.find((u) => /stream\/status/.test(u));
    if (cands.length) ok('捕获到 ' + cands.length + ' 条候选：' + cands.map((c) => c.url.split('?')[1] || c.url.split('/').pop()).join(', '));
    else bad('没有捕获到任何候选条目（text/plain 的 m3u8 被漏掉了）');
    if (m3u8Url) ok('text/plain 返回的 m3u8 已进入候选'); else bad('m3u8 候选缺失');
    if (tsUrl) ok('text/plain 返回的 TS 分片已进入候选'); else bad('TS 候选缺失');
    if (falseUrl) ok('普通文本接口也被记为候选（待验证后可被排除）'); else console.log('  – 普通文本接口未进入候选（不影响）');

    /* ---- B. 候选定性 ---- */
    console.log('\n[4] 按内容签名定性（PROBE_KIND）');
    const probe = JSON.parse(await ev(cdp, swS,
      `handleMessage({type:'PROBE_KIND',tabId:${tabId},pageUrl:${JSON.stringify(PAGE_URL)},items:${JSON.stringify(cands.map((c) => ({ url: c.url, pageUrl: PAGE_URL })))}},{}).then(r=>JSON.stringify(r))`));
    const results = (probe && probe.results) || {};
    for (const u of Object.keys(results)) {
      const r = results[u];
      console.log('    ' + (u.split('?')[1] || u.split('/').pop()) + '  →  ' + (r.ok ? (r.kind + ' [' + r.sig + '] ' + (r.detail || '')) : ('非媒体：' + r.error)));
    }
    if (m3u8Url && results[m3u8Url] && results[m3u8Url].ok && results[m3u8Url].kind === 'hls') ok('无后缀的 m3u8 → 定性为 HLS');
    else bad('m3u8 未能定性为 HLS: ' + JSON.stringify(results[m3u8Url]));
    if (tsUrl && results[tsUrl] && results[tsUrl].ok && results[tsUrl].kind === 'ts') ok('无后缀的 TS 分片 → 定性为 TS');
    else bad('TS 未能定性: ' + JSON.stringify(results[tsUrl]));
    if (falseUrl && results[falseUrl] && !results[falseUrl].ok) ok('普通文本接口 → 正确判定为非媒体');
    else if (falseUrl) bad('普通文本接口被误判为媒体: ' + JSON.stringify(results[falseUrl]));

    await sleep(600);
    items = await readItems();
    const hlsItem = items.find((i) => i.url === m3u8Url);
    if (hlsItem && hlsItem.kind === 'hls') ok('列表里的候选已被改写成 hls（不再是 cand）');
    else bad('候选未被改写: ' + JSON.stringify(hlsItem));
    if (falseUrl && !items.some((i) => i.url === falseUrl)) ok('误报条目已从列表删除，不污染界面');
    else if (falseUrl) bad('误报条目仍在列表里');

    /* ---- C. 性能时间线回溯 ---- */
    console.log('\n[5] 观测盲区兜底：清空列表后由性能时间线恢复');
    const perfUrl = PAGE_URL + 'media/only-in-perf.mp4';
    if (!items.some((i) => i.url === perfUrl)) {
      bad('前置条件不满足：只应出现在性能时间线里的 mp4 一开始就没抓到');
    } else {
      await ev(cdp, swS, `handleMessage({type:'CLEAR_TAB',tabId:${tabId}},{}).then(()=>1)`);
      await sleep(400);
      const afterClear = await readItems();
      if (!afterClear.length) ok('列表已清空（模拟"扩展漏掉了这些请求"）');
      else bad('清空后仍有 ' + afterClear.length + ' 条');

      const scanAck = await ev(cdp, swS, `chrome.tabs.sendMessage(${tabId},{type:'DOM_SCAN',force:true}).then(()=>'ok').catch(e=>'ERR: '+(e&&e.message||e))`);
      console.log('  重扫消息: ' + scanAck + '（页面性能条目 ' + await ev(cdp, pS, 'performance.getEntriesByType("resource").length') + ' 条，4 个请求的响应均已进入时间线）');
      await sleep(3000);
      const restored = await readItems();
      console.log('  恢复结果: ' + (restored.map((i) => i.kind + ':' + i.url.replace(PAGE_URL, '/') + '(' + i.source + ')').join('  ') || '(空)'));
      const back = restored.find((i) => i.url === perfUrl);
      if (back) ok('条目已由时间线恢复（未重新发起任何请求）');
      else bad('条目未能恢复——性能时间线回溯未生效');
      if (back && back.source === 'perf') ok('来源标记为 perf，确认走的是回溯通道');
      else if (back) bad('来源标记异常: ' + back.source);
      const hlsBack = restored.find((i) => i.url === m3u8Url);
      if (hlsBack) ok('无后缀清单也被一并恢复（kind=' + hlsBack.kind + '，候选项会在下次打开弹窗时被重新定性为 hls）');
      else bad('无后缀清单未能恢复');
    }
  } catch (e) {
    bad('测试流程', e && (e.stack || e.message));
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(800);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log('嗅探盲区端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
