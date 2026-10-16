/* ============================================================
 * Referer 规则作用域探针 + 真实站点补充测试
 *  实验 A：downloads API 下载一个"必须带 Referer"的本地资源 → 验证 DNR 是否作用于下载请求
 *  实验 B：扩展 fetch 同一资源 → 验证 DNR 作用于扩展自身请求
 *  实验 C：真实 B站 m4s 分片下载（带 Referer 规则）
 *  实验 D：抖音首页滚动加载 → 观察真实视频流是否可被嗅探
 * 运行：node test/dnr_probe.mjs
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EVIDENCE = join(__dirname, 'evidence');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const DEBUG_PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const BILI_URL = 'https://www.bilibili.com/video/BV1xx411c7mD';

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.nextId = 1; this.pending = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => {
        this.ws.onmessage = (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.id && this.pending.has(m.id)) {
            const { res: r, rej: j } = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) j(new Error(JSON.stringify(m.error))); else r(m.result);
          }
        };
        res();
      };
      this.ws.onerror = () => rej(new Error('CDP 连接失败'));
      this.ws.onclose = () => { for (const { rej: j } of this.pending.values()) j(new Error('CDP 关闭')); this.pending.clear(); };
    });
  }
  send(method, params, sessionId) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 120000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

let chromeProc = null, server = null, cdp = null;
const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-probe-'));
const dlDir = join(tmp, 'downloads');
const profileDir = join(tmp, 'profile');
mkdirSync(dlDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });
const out = { time: new Date().toISOString(), experiments: {} };

async function main() {
  try {
    /* ---------- 本地服务器：必须带 Referer 才放行 ---------- */
    let lastReferer = '';
    server = createServer((req, res) => {
      if (req.url.startsWith('/need-ref')) {
        const referer = req.headers.referer || '';
        lastReferer = referer;
        if (referer.includes('bilibili.com')) {
          const body = Buffer.alloc(2048, 7);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
          res.end(body);
        } else {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('403: referer required, got=' + JSON.stringify(referer));
        }
        return;
      }
      res.writeHead(404); res.end('nf');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const LOCAL_URL = `http://localtest.local:${PORT}/need-ref.bin`;
    console.log('本地探针服务: ' + LOCAL_URL);

    /* ---------- 启动浏览器 ---------- */
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + DEBUG_PORT,
      '--user-data-dir=' + profileDir,
      '--enable-unsafe-extension-debugging',
      '--load-extension=' + ROOT,
      '--user-agent=' + UA,
      '--host-resolver-rules=MAP localtest.local 127.0.0.1',
      'about:blank'
    ];
    if (PROXY) {
      args.push('--proxy-server=' + PROXY);
      args.push('--proxy-bypass-list=127.0.0.1;localhost;localtest.local');
    }
    chromeProc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore'] });

    let browserWs = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const j = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
        browserWs = j.webSocketDebuggerUrl;
        console.log('浏览器就绪: ' + j.Browser);
        break;
      } catch (e) { /* wait */ }
    }
    if (!browserWs) throw new Error('浏览器未就绪');
    cdp = new CDP(browserWs);
    await cdp.connect();
    try { await cdp.send('Extensions.loadUnpacked', { path: ROOT }); } catch (e) { /* cmd-line fallback */ }

    let swTarget = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await cdp.send('Target.getTargets');
      swTarget = t.targetInfos.find((x) => x.type === 'service_worker' && /background\.js/.test(x.url));
      if (swTarget) break;
    }
    if (!swTarget) throw new Error('Service Worker 未出现');
    const sw = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sw);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    /* ---------- 实验 A：downloads API 下载（验证 DNR 是否作用于下载请求） ---------- */
    console.log('\n[实验 A] downloads API 下载需 Referer 的资源');
    const aRes = await evalIn(cdp, sw,
      `handleMessage({ type: 'DIRECT_DOWNLOAD', url: ${JSON.stringify(LOCAL_URL)}, filename: 'dnr-dl-test.bin', pageUrl: ${JSON.stringify(BILI_URL)} }, {}).then(r => JSON.stringify(r))`);
    console.log('  DIRECT_DOWNLOAD 返回: ' + aRes);
    const aRet = JSON.parse(aRes);
    let aState = 'unknown';
    if (aRet.downloadId) {
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const s = await evalIn(cdp, sw, `chrome.downloads.search({id: ${aRet.downloadId}}).then(l => JSON.stringify(l[0] || {}))`);
        const item = JSON.parse(s);
        if (item.state && item.state !== 'in_progress') { aState = item.state + (item.error ? ' / ' + item.error : ''); break; }
      }
    } else if (aRet.error) {
      aState = 'API错误: ' + aRet.error;
    }
    /* 等待自动回退（引擎 fetch 带 Referer）完成 */
    let aOk = false;
    for (let i = 0; i < 45; i++) {
      if (readdirSync(dlDir).includes('dnr-dl-test.bin')) { aOk = true; break; }
      await sleep(1000);
    }
    const aTasks = await evalIn(cdp, sw, 'chrome.storage.session.get("tasks").then(a => JSON.stringify(a))');
    const aTaskList = Object.values(JSON.parse(aTasks || '{}').tasks || {});
    const aLastTask = aTaskList.sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0))[0] || null;
    console.log('  downloads API 结果: ' + aState);
    console.log('  回退任务: ' + (aLastTask ? aLastTask.status + ' / ' + aLastTask.phase : '无'));
    console.log('  最终文件落盘: ' + (aOk ? '✓ 是' : '✗ 否') + ' | 服务器收到 Referer: ' + JSON.stringify(lastReferer));
    out.experiments.downloadWithRefererRule = {
      downloadId: aRet.downloadId || null,
      state: aState,
      fallbackTask: aLastTask ? { status: aLastTask.status, phase: aLastTask.phase, error: aLastTask.error || '', saveVia: aLastTask.saveVia || '' } : null,
      fileCreated: aOk,
      refererSeen: lastReferer
    };

    /* ---------- 实验 B：扩展 fetch（验证 DNR 是否作用于扩展自身请求） ---------- */
    console.log('\n[实验 B] 扩展 fetch 同一资源（观察 Referer 是否被注入）');
    lastReferer = '';
    const bStatus = await evalIn(cdp, sw,
      `fetch(${JSON.stringify(LOCAL_URL)}).then(r => r.status + '').catch(e => 'ERR ' + e)`);
    console.log('  fetch 状态: ' + bStatus + ' | 服务器收到 Referer: ' + JSON.stringify(lastReferer));
    out.experiments.extensionFetchWithRefererRule = { status: bStatus, refererSeen: lastReferer };

    /* ---------- 实验 C：真实 B站 m4s 分片下载 ---------- */
    console.log('\n[实验 C] 真实 B站 m4s 分片下载（先重新抓取新鲜 URL）');
    try {
      const biliTab = (await cdp.send('Target.createTarget', { url: BILI_URL })).targetId;
      const biliSession = (await cdp.send('Target.attachToTarget', { targetId: biliTab, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, biliSession);
      await sleep(14000);
      const dumpB = await evalIn(cdp, sw, 'chrome.storage.session.get(null).then(a => JSON.stringify(a))');
      const storeB = JSON.parse(dumpB || '{}');
      let biliItems = [];
      for (const key of Object.keys(storeB)) {
        if (!key.startsWith('tab:')) continue;
        const td = storeB[key];
        if (!td.pageUrl || !td.pageUrl.includes('bilibili.com')) continue;
        biliItems = Object.values(td.items || {});
      }
      console.log('  B站嗅探条目: ' + biliItems.length);
      const seg = biliItems.find((i) => i.url.includes('bilivideo.com') && i.url.includes('.m4s')) ||
                  biliItems.find((i) => i.url.includes('.m4s'));
      if (!seg) throw new Error('未嗅探到 m4s 分片（页面可能未开始播放）');
      console.log('  使用分片: ' + seg.url.slice(0, 110) + '...');
      const cRes = await evalIn(cdp, sw,
        `handleMessage({ type: 'DIRECT_DOWNLOAD', url: ${JSON.stringify(seg.url)}, filename: 'bili-seg-test.m4s', pageUrl: ${JSON.stringify(BILI_URL)} }, {}).then(r => JSON.stringify(r))`);
      const cRet = JSON.parse(cRes);
      let cState = 'no-download-id';
      if (cRet.downloadId) {
        for (let i = 0; i < 90; i++) {
          await sleep(1000);
          const s = await evalIn(cdp, sw, `chrome.downloads.search({id: ${cRet.downloadId}}).then(l => JSON.stringify(l[0] || {}))`);
          const item = JSON.parse(s);
          if (item.state && item.state !== 'in_progress') { cState = item.state + (item.error ? ' / ' + item.error : ''); break; }
        }
      } else {
        cState = 'API错误: ' + cRet.error;
      }
      /* 等待自动回退下载完成（m4s 分片，经代理约 30KB/s） */
      let cFiles = [];
      for (let i = 0; i < 150; i++) {
        cFiles = readdirSync(dlDir).filter((f) => f.startsWith('bili-seg-test') && !f.endsWith('.crdownload'));
        if (cFiles.length) break;
        await sleep(1000);
      }
      const cSize = cFiles.length ? (statSync(join(dlDir, cFiles[0])).size / 1024).toFixed(0) + 'KB' : '无';
      console.log('  downloads API 结果: ' + cState + ' | 回退后文件: ' + (cFiles.join(',') || '无') + ' (' + cSize + ')');
      out.experiments.biliSegmentDownload = { state: cState, files: cFiles, size: cSize };
    } catch (e) {
      console.log('  失败: ' + e.message);
      out.experiments.biliSegmentDownload = { error: e.message };
    }

    /* ---------- 实验 D：抖音首页滚动加载 ---------- */
    console.log('\n[实验 D] 抖音首页滚动，观察真实视频流嗅探');
    const dyTarget = (await cdp.send('Target.createTarget', { url: 'https://www.douyin.com/' })).targetId;
    const dy = (await cdp.send('Target.attachToTarget', { targetId: dyTarget, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, dy);
    await sleep(8000);
    for (let i = 0; i < 8; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: 1500 }, dy);
      await sleep(2200);
    }
    const dys = await evalIn(cdp, dy, `JSON.stringify((()=>{
      const vs=[...document.querySelectorAll('video')]; const v=vs[0];
      return { title: document.title, count: vs.length, src: v?(v.currentSrc||v.src||'').slice(0,100):'', readyState: v?v.readyState:0, currentTime: v?Math.round(v.currentTime):0 };
    })())`);
    console.log('  页面状态: ' + dys);
    const dump = await evalIn(cdp, sw, 'chrome.storage.session.get(null).then(a => JSON.stringify(a))');
    const store = JSON.parse(dump || '{}');
    let dyItems = [];
    for (const key of Object.keys(store)) {
      if (!key.startsWith('tab:')) continue;
      const td = store[key];
      if (!td.pageUrl || !td.pageUrl.includes('douyin.com')) continue;
      dyItems = Object.values(td.items || {});
    }
    const feedUrls = dyItems.filter((i) => /douyinvod|aweme|video\/tos|\/play\//.test(i.url));
    console.log('  抖音嗅探条目: ' + dyItems.length + ' 个（候选视频流: ' + feedUrls.length + '）');
    for (const it of dyItems.slice(0, 12)) console.log('    [' + it.kind + '] ' + it.url.slice(0, 150));
    out.experiments.douyinScroll = { pageState: JSON.parse(dys), items: dyItems.map((i) => ({ kind: i.kind, url: i.url.slice(0, 200) })) };

    writeFileSync(join(EVIDENCE, 'dnr_probe_result.json'), JSON.stringify(out, null, 2));
    console.log('\n探针结果已保存: test/evidence/dnr_probe_result.json');
  } catch (e) {
    console.error('探针异常: ' + (e.stack || e.message));
    try { writeFileSync(join(EVIDENCE, 'dnr_probe_result.json'), JSON.stringify(out, null, 2)); } catch (_) { /* ignore */ }
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { if (server) server.close(); } catch (e) { /* ignore */ }
    if (chromeProc && chromeProc.pid) {
      try { spawn('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
    await sleep(800);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('完成。');
    process.exit(0);
  }
}

main();
