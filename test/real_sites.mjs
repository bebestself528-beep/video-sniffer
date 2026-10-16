/* ============================================================
 * 视频嗅探下载器 - 真实视频网站嗅探测试
 * 流程：无头 Chrome（带系统代理 + 扩展 + 普通 UA）依次访问目标站点，
 *       收集扩展的嗅探结果、页面 video 元素状态、页面截图，
 *       并对可下载的候选资源尝试真实下载验证。
 * 运行：node test/real_sites.mjs
 * 结果：test/evidence/real_sites_result.json + 站点截图
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
const DEBUG_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

/* ---------------- 迷你 CDP 客户端 ---------------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => {
        this.ws.onmessage = (ev) => {
          let m;
          try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.id && this.pending.has(m.id)) {
            const { res: r, rej: j } = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) j(new Error(JSON.stringify(m.error))); else r(m.result);
          }
        };
        res();
      };
      this.ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
      this.ws.onclose = () => {
        for (const { rej: j } of this.pending.values()) j(new Error('CDP 连接关闭'));
        this.pending.clear();
      };
    });
  }
  send(method, params, sessionId) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); }
      }, 90000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

/* ---------------- 目标站点 ---------------- */
const SITES = [
  { name: '哔哩哔哩', key: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD', wait: 20000 },
  { name: '抖音', key: 'douyin', url: 'https://www.douyin.com/', wait: 20000 },
  { name: '西瓜视频', key: 'ixigua', url: 'https://www.ixigua.com/', wait: 16000 },
  { name: '腾讯视频', key: 'qqvideo', url: 'https://v.qq.com/', wait: 14000 }
];

/* ---------------- 主流程 ---------------- */
let chromeProc = null;
let server = null;
let cdp = null;
const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-sites-'));
const dlDir = join(tmp, 'downloads');
const serveDir = join(tmp, 'serve');
const profileDir = join(tmp, 'profile');
mkdirSync(dlDir, { recursive: true });
mkdirSync(serveDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const result = { time: new Date().toISOString(), proxy: PROXY, sites: {}, downloads: [], genericHls: null };

function log(...a) { console.log(...a); }

async function main() {
  try {
    /* ---------- 本地测试资源（通用 HLS 验证用） ---------- */
    log('\n[0] 准备通用 HLS 测试资源（远程真实分片）');
    const MASTER = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    const masterText = await (await fetch(MASTER)).text();
    const variantLine = masterText.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    const variantUrl = new URL(variantLine, MASTER).href;
    const mediaText = await (await fetch(variantUrl)).text();
    const segUrls = [];
    for (const line of mediaText.split('\n')) {
      const l = line.trim();
      if (l && !l.startsWith('#')) segUrls.push(new URL(l, variantUrl).href);
      if (segUrls.length >= 3) break;
    }
    writeFileSync(join(serveDir, 'stream-remote.m3u8'), [
      '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:10.0,', segUrls[0],
      '#EXTINF:10.0,', segUrls[1],
      '#EXTINF:10.0,', segUrls[2],
      '#EXT-X-ENDLIST'
    ].join('\n'));
    writeFileSync(join(serveDir, 'page.html'), `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>HLS 通用场景测试</title></head><body>
<video id="v" controls muted playsinline style="width:640px"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<script>
  var v = document.getElementById('v');
  var url = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  if (window.Hls && Hls.isSupported()) { var h = new Hls(); h.loadSource(url); h.attachMedia(v); }
</script>
</body></html>`);

    server = createServer((req, res) => {
      let p = new URL(req.url, 'http://127.0.0.1').pathname;
      if (p === '/') p = '/page.html';
      const map = { '/page.html': 'text/html; charset=utf-8', '/stream-remote.m3u8': 'application/vnd.apple.mpegurl' };
      if (map[p]) {
        const body = readFileSync(join(serveDir, p.slice(1)));
        res.writeHead(200, { 'Content-Type': map[p], 'Content-Length': body.length });
        res.end(body);
        return;
      }
      res.writeHead(404); res.end('nf');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    log('  本地服务已就绪: http://127.0.0.1:' + PORT);

    /* ---------- 启动浏览器 ---------- */
    log('\n[1] 启动无头浏览器（代理: ' + PROXY + '）并加载扩展');
    const chromeArgs = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=' + DEBUG_PORT,
      '--user-data-dir=' + profileDir,
      '--enable-unsafe-extension-debugging',
      '--load-extension=' + ROOT,
      '--user-agent=' + UA,
      'about:blank'
    ];
    if (PROXY) {
      chromeArgs.push('--proxy-server=' + PROXY);
      chromeArgs.push('--proxy-bypass-list=127.0.0.1;localhost');
    }
    chromeProc = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'ignore'] });

    let browserWs = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        const j = await r.json();
        browserWs = j.webSocketDebuggerUrl;
        log('  浏览器就绪: ' + j.Browser);
        break;
      } catch (e) { /* wait */ }
    }
    if (!browserWs) throw new Error('浏览器未就绪');

    cdp = new CDP(browserWs);
    await cdp.connect();
    try {
      const r = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
      log('  扩展已加载: ' + r.id);
    } catch (e) {
      log('  （扩展可能已通过命令行加载）');
    }

    let swTarget = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await cdp.send('Target.getTargets');
      swTarget = t.targetInfos.find((x) => x.type === 'service_worker' && /background\.js/.test(x.url));
      if (swTarget) break;
    }
    if (!swTarget) throw new Error('扩展 Service Worker 未出现');
    const swSession = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swSession);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    /* 先验证一个通用场景：本页加载远程 HLS（走代理） */
    log('\n[2] 通用 HLS 场景（真实远程流经代理加载）');
    const hlsTarget = (await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/page.html` })).targetId;
    const hlsSession = (await cdp.send('Target.attachToTarget', { targetId: hlsTarget, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, hlsSession);
    await sleep(15000);
    const hlsState = await evalIn(cdp, hlsSession, `JSON.stringify((()=>{ const v=document.querySelector('video'); return { title: document.title, src: v ? (v.currentSrc||v.src||'').slice(0,120) : '', readyState: v?v.readyState:0, duration: v?Math.round(v.duration||0):0, buffered: v&&v.buffered.length? Math.round(v.buffered.end(0)) : 0 }; })())`);
    log('  页面 video 状态: ' + hlsState);
    result.genericHls = JSON.parse(hlsState);

    /* 通用 HLS：真实远程分片下载全流程（走代理） */
    log('  → 触发远程 HLS 下载任务（3 个真实远程分片）');
    const startRes = await evalIn(cdp, swSession,
      `handleMessage({ type: 'START_HLS', tabId: -1, url: 'http://127.0.0.1:${PORT}/stream-remote.m3u8', pageUrl: 'http://127.0.0.1:${PORT}/page.html', name: 'generic-hls-remote', folder: '', format: 'auto', concurrency: 6 }, {}).then(r => JSON.stringify(r))`);
    const started = JSON.parse(startRes);
    let task = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const tdump = await evalIn(cdp, swSession, 'chrome.storage.session.get("tasks").then(a => JSON.stringify(a))');
      task = (JSON.parse(tdump || '{}').tasks || {})[started.taskId];
      if (task && task.status !== 'running') break;
    }
    log('  远程 HLS 下载任务: ' + (task ? task.status + ' ' + (task.sizeStr || '') : '未知'));
    result.genericHls.downloadTask = task ? { status: task.status, sizeStr: task.sizeStr, note: task.note, saveVia: task.saveVia } : null;

    /* ---------- 逐站点测试 ---------- */
    for (const site of SITES) {
      log(`\n[站点] ${site.name} — ${site.url}`);
      const siteResult = { name: site.name, url: site.url, loaded: false, pageTitle: '', video: null, items: [], counts: {}, samples: {}, errors: [] };

      let targetId = null, sessionId = null;
      try {
        targetId = (await cdp.send('Target.createTarget', { url: site.url })).targetId;
        sessionId = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
        await cdp.send('Runtime.enable', {}, sessionId);
      } catch (e) {
        siteResult.errors.push('打开失败: ' + e.message);
        result.sites[site.key] = siteResult;
        continue;
      }

      await sleep(site.wait);

      /* 页面状态 */
      try {
        const pageState = await evalIn(cdp, sessionId, `JSON.stringify((()=>{
          const vs = [...document.querySelectorAll('video')];
          const v = vs[0];
          return {
            title: document.title || '',
            videoCount: vs.length,
            src: v ? (v.currentSrc || v.src || '').slice(0, 150) : '',
            isBlob: v ? (v.currentSrc || '').startsWith('blob:') : false,
            readyState: v ? v.readyState : 0,
            duration: v ? Math.round(v.duration || 0) : 0,
            error: v && v.error ? v.error.message || v.error.code : ''
          };
        })())`);
        const ps = JSON.parse(pageState);
        siteResult.loaded = true;
        siteResult.pageTitle = ps.title;
        siteResult.video = ps;
        log('  页面标题: ' + ps.title);
        log('  video 元素: ' + ps.videoCount + ' 个 | readyState=' + ps.readyState + ' | duration=' + ps.duration + 's | blob=' + ps.isBlob);
      } catch (e) {
        siteResult.errors.push('页面状态读取失败: ' + e.message);
      }

      /* 截图 */
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, sessionId);
        writeFileSync(join(EVIDENCE, site.key + '.jpg'), Buffer.from(shot.data, 'base64'));
        log('  截图已保存: evidence/' + site.key + '.jpg');
      } catch (e) { siteResult.errors.push('截图失败: ' + e.message); }

      /* 嗅探结果（按 pageUrl 匹配） */
      try {
        const dump = await evalIn(cdp, swSession, 'chrome.storage.session.get(null).then(a => JSON.stringify(a))');
        const store = JSON.parse(dump || '{}');
        for (const key of Object.keys(store)) {
          if (!key.startsWith('tab:')) continue;
          const tabData = store[key];
          if (!tabData.pageUrl || !tabData.pageUrl.includes(new URL(site.url).hostname.split('.').slice(-2).join('.'))) continue;
          const items = Object.values(tabData.items || {});
          siteResult.items = items.map((it) => ({ url: it.url, kind: it.kind, size: it.size, source: it.source }));
        }
        for (const it of siteResult.items) siteResult.counts[it.kind] = (siteResult.counts[it.kind] || 0) + 1;
        for (const kind of Object.keys(siteResult.counts)) {
          if (kind === 'ts' || kind === 'fmp4') {
            siteResult.samples[kind] = siteResult.items.filter((i) => i.kind === kind).slice(0, 2).map((i) => i.url.slice(0, 160));
          } else {
            siteResult.samples[kind] = siteResult.items.filter((i) => i.kind === kind).slice(0, 4).map((i) => i.url.slice(0, 220));
          }
        }
        log('  嗅探条目: ' + (siteResult.items.length ? JSON.stringify(siteResult.counts) : '（无）'));
        for (const kind of Object.keys(siteResult.samples)) {
          for (const u of siteResult.samples[kind]) log('    [' + kind + '] ' + u);
        }
      } catch (e) {
        siteResult.errors.push('嗅探结果读取失败: ' + e.message);
      }

      result.sites[site.key] = siteResult;
    }

    /* ---------- 候选资源真实下载验证 ---------- */
    log('\n[3] 候选资源下载验证');
    const candidates = [];
    for (const key of Object.keys(result.sites)) {
      const s = result.sites[key];
      /* 优先挑非分片的直链类资源 */
      const direct = s.items.find((i) => ['mp4', 'webm', 'flv', 'video', 'hls'].includes(i.kind) && !/\.m4s|\.ts(\?|$)/.test(i.url));
      if (direct) candidates.push({ site: key, type: 'direct-' + direct.kind, url: direct.url });
      /* B站额外验证一个 m4s 分片（证明分片可达 + referer 规则有效） */
      if (key === 'bilibili') {
        const seg = s.items.find((i) => i.kind === 'fmp4' || /\.m4s/.test(i.url));
        if (seg) candidates.push({ site: key, type: 'bili-m4s-segment', url: seg.url });
      }
    }

    for (const c of candidates) {
      const before = new Set(readdirSync(dlDir));
      let downloadResult = { site: c.site, type: c.type, url: c.url.slice(0, 160), ok: false, file: '', size: 0, note: '' };
      try {
        const fn = 'test-' + c.site + '-' + c.type.replace(/[^a-z0-9-]/gi, '') + (c.type.includes('mp4') || c.type.includes('fmp4') ? '.mp4' : (c.type.includes('hls') ? '.mp4' : '.bin'));
        const r = await evalIn(cdp, swSession,
          `handleMessage({ type: 'DIRECT_DOWNLOAD', url: ${JSON.stringify(c.url)}, filename: ${JSON.stringify(fn)}, pageUrl: ${JSON.stringify(result.sites[c.site].url)} }, {}).then(r => JSON.stringify(r))`);
        const rr = JSON.parse(r);
        if (rr.error) throw new Error(rr.error);
        /* 等待下载落盘 */
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          const files = readdirSync(dlDir).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
          if (files.length) {
            const f = files[0];
            const st = statSync(join(dlDir, f));
            if (st.size > 0 && st.size === statSync(join(dlDir, f)).size) {
              downloadResult.ok = true;
              downloadResult.file = f;
              downloadResult.size = st.size;
              break;
            }
          }
        }
        if (!downloadResult.ok) {
          downloadResult.note = '下载未落盘（可能被拦截或超时）';
        } else {
          const buf = readFileSync(join(dlDir, downloadResult.file));
          const head = buf.slice(0, 16);
          const isMp4 = head.toString('latin1', 4, 8) === 'ftyp';
          const isTs = head[0] === 0x47;
          downloadResult.validMedia = isMp4 ? 'mp4/ftyp' : (isTs ? 'ts' : 'unknown(' + head.toString('hex').slice(0, 16) + ')');
        }
      } catch (e) {
        downloadResult.note = '异常: ' + String(e.message || e).slice(0, 200);
      }
      log(`  [${c.site}][${c.type}] ${downloadResult.ok ? '✓ 成功 ' + (downloadResult.size / 1024).toFixed(0) + 'KB ' + downloadResult.validMedia : '✗ 失败 ' + downloadResult.note}`);
      result.downloads.push(downloadResult);
    }

    writeFileSync(join(EVIDENCE, 'real_sites_result.json'), JSON.stringify(result, null, 2));
    log('\n结果已保存: test/evidence/real_sites_result.json');
  } catch (e) {
    console.error('测试流程异常: ' + (e.stack || e.message));
    try { writeFileSync(join(EVIDENCE, 'real_sites_result.json'), JSON.stringify(result, null, 2)); } catch (_) { /* ignore */ }
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { if (server) server.close(); } catch (e) { /* ignore */ }
    if (chromeProc && chromeProc.pid) {
      try { spawn('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
    await sleep(800);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n完成。');
    process.exit(0);
  }
}

main();
