/* ============================================================
 * 商店截图生成器 —— 无头浏览器驱动（开发工具，不随商店包分发）
 * 运行：node tools/make_shots.mjs
 * 产物：store/screenshots/*.png
 *   - 5 张 1280×800 应用截图（Chrome 应用商店要求 1280×800 或 640×400）
 *   - 1 张 440×280 小宣传图
 * 实现：本地静态服务托管扩展目录 → 无头 Chrome 打开 tools/shot.html?shot=<id>
 *       → 等 window.__SHOT_READY → Page.captureScreenshot 精确截取视口
 * ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'store', 'screenshots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.SHOT_DEBUG_PORT || 9444);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

/* ---------------- 迷你 CDP 客户端 ---------------- */
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.nextId = 1; this.pending = new Map(); }
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
      }, 45000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

/* ---------------- PNG 尺寸校验（读取 IHDR） ---------------- */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/* ---------------- 主流程 ---------------- */
let chromeProc = null;
let server = null;
let cdp = null;
let fail = 0;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'vsniffer-shot-'));
  const results = [];

  try {
    /* ---------- 静态服务器（托管扩展目录） ---------- */
    server = createServer((req, res) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (e) { p = '/'; }
      if (p === '/') p = '/tools/shot.html';
      const file = join(ROOT, p.replace(/^\/+/, ''));
      if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      try {
        const body = readFileSync(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
        res.end(body);
      } catch (e) { res.writeHead(500); res.end('read error'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    console.log('本地预览服务: http://127.0.0.1:' + PORT + '/tools/shot.html');

    /* ---------- 启动无头浏览器 ---------- */
    chromeProc = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=' + DEBUG_PORT,
      '--user-data-dir=' + profileDir,
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let browserWs = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const j = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json();
        browserWs = j.webSocketDebuggerUrl;
        console.log('浏览器已就绪: ' + j.Browser);
        break;
      } catch (e) { /* 继续等待 */ }
    }
    if (!browserWs) throw new Error('浏览器调试端口未就绪，启动失败');

    cdp = new CDP(browserWs);
    await cdp.connect();

    /* ---------- 枚举截图配置 ---------- */
    const probeTarget = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:' + PORT + '/tools/shot.html' })).targetId;
    const probeSession = (await cdp.send('Target.attachToTarget', { targetId: probeTarget, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, probeSession);
    await sleep(1500);
    const keys = await evalIn(cdp, probeSession, 'JSON.stringify(window.__SHOT_CONFIG_KEYS || [])');
    await cdp.send('Target.closeTarget', { targetId: probeTarget });
    const shotIds = JSON.parse(keys || '[]');
    if (!shotIds.length) throw new Error('未读取到 SHOT_CONFIG，请检查 tools/shot.js 是否加载成功');
    console.log('待生成截图: ' + shotIds.join(', ') + '\n');

    /* ---------- 逐张截图 ---------- */
    const SIZES = { tile: { w: 440, h: 280 }, marquee: { w: 1400, h: 560 } };
    for (const id of shotIds) {
      const size = SIZES[id] || { w: 1280, h: 800 };
      const url = 'http://127.0.0.1:' + PORT + '/tools/shot.html?shot=' + encodeURIComponent(id);

      const targetId = (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
      const s = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, s);
      await cdp.send('Page.enable', {}, s);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false
      }, s);
      await cdp.send('Emulation.setEmulatedMedia', {
        media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }]
      }, s);

      await cdp.send('Page.navigate', { url }, s);

      let ok = false;
      for (let i = 0; i < 90; i++) {
        await sleep(250);
        try { ok = await evalIn(cdp, s, 'window.__SHOT_READY === true'); } catch (e) { ok = false; }
        if (ok) break;
      }
      const info = await evalIn(cdp, s, 'JSON.stringify(window.__SHOT_INFO || {})').catch(() => '{}');
      const cfg = JSON.parse(info || '{}');
      if (!ok) console.log('  ⚠ ' + id + '：就绪标志未出现，仍尝试截图');

      await sleep(450); // 与 __SHOT_READY 后的稳定延时叠加，避免抓到过渡帧
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, s);
      const buf = Buffer.from(shot.data, 'base64');
      const dim = pngSize(buf);
      const file = cfg.file || (id + '.png');
      writeFileSync(join(OUT_DIR, file), buf);
      await cdp.send('Target.closeTarget', { targetId });

      const dimOk = dim && dim.w === size.w && dim.h === size.h;
      if (!dimOk) fail++;
      results.push({ id, file, dim, expect: size, ok: dimOk });
      console.log('  ' + (dimOk ? '✓' : '✗') + ' ' + file + '  ' + (dim ? dim.w + '×' + dim.h : '读取失败') +
        '  ' + (buf.length / 1024).toFixed(0) + ' KB' + (ok ? '' : '  (就绪标志缺失)'));
    }
  } catch (e) {
    fail++;
    console.error('生成失败: ' + (e && (e.stack || e.message) || e));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { if (server) server.close(); } catch (e) { /* ignore */ }
    if (chromeProc && chromeProc.pid) {
      try { spawn('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
    await sleep(600);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    writeFileSync(join(OUT_DIR, '_manifest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      note: '界面演示数据，示例域名为虚构域名；小宣传图 440x280，应用截图 1280x800',
      shots: results
    }, null, 2));

    console.log('\n========================================');
    console.log('截图输出目录: ' + OUT_DIR);
    console.log(fail ? ('存在 ' + fail + ' 项异常，请检查') : '全部截图生成成功');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
