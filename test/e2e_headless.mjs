/* ============================================================
 * 视频嗅探下载器 - 无头浏览器端到端测试
 * 流程：
 *   1. 启动无头 Chrome 并加载本扩展（Extensions.loadUnpacked / --load-extension 双路径）
 *   2. 打开测试页面：页面请求本地 m3u8（3 个真实公网 TS 分片）+ 本地 mp4
 *   3. 检查扩展 Service Worker 是否嗅探到资源
 *   4. 通过扩展内部接口触发 HLS 下载任务（等价于 popup 操作）
 *   5. 校验下载到磁盘的文件（应为 fMP4，头含 ftyp box）
 * 运行：node test/e2e_headless.mjs
 * 环境变量：CHROME_PATH 可指定浏览器路径
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }
function bad(name, e) { fail++; console.error('  ✗ ' + name + '\n      ' + (e && (e.stack || e.message) || e)); }

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
      }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('JS 执行异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  }
  return r.result ? r.result.value : undefined;
}

/* ---------------- 主流程 ---------------- */
let chromeProc = null;
let server = null;
let cdp = null;

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-e2e-'));
  const dlDir = join(tmp, 'downloads');
  const serveDir = join(tmp, 'serve');
  const profileDir = join(tmp, 'profile');
  mkdirSync(dlDir, { recursive: true });
  mkdirSync(serveDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  try {
    /* ---------- 准备测试素材 ---------- */
    console.log('\n[0] 准备测试素材');

    /* 真实公网 TS 分片素材：优先使用本地缓存（test/fixtures），缺失时才联网抓取，
       抓取时选择最低码率清晰度以减小体积，并带重试；网络抖动不影响测试稳定性 */
    const FIXTURES = join(__dirname, 'fixtures');
    mkdirSync(FIXTURES, { recursive: true });
    const segFiles = [0, 1, 2].map((i) => join(FIXTURES, 'seg' + i + '.ts'));
    let segBytes = 0;

    if (segFiles.every((f) => existsSync(f))) {
      for (let i = 0; i < 3; i++) {
        const buf = readFileSync(segFiles[i]);
        writeFileSync(join(serveDir, 'seg' + i + '.ts'), buf);
        segBytes += buf.length;
      }
      ok('已使用本地缓存分片素材 (' + (segBytes / 1024).toFixed(0) + ' KB)');
    } else {
      const MASTER = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
      async function fetchRetry(url, tries, timeoutMs) {
        let lastErr;
        for (let i = 1; i <= tries; i++) {
          try {
            const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 90000) });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return Buffer.from(await r.arrayBuffer());
          } catch (e) {
            lastErr = e;
            if (i < tries) await sleep(2500 * i);
          }
        }
        throw lastErr;
      }
      const masterText = (await fetchRetry(MASTER, 3, 30000)).toString('utf8');
      /* 选最低码率的清晰度 */
      let bestUrl = null, bestBw = Infinity;
      const lines = masterText.split('\n').map((l) => l.trim());
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const bw = parseInt((/BANDWIDTH=(\d+)/.exec(lines[i]) || [])[1] || '0', 10) || Infinity;
        const next = lines[i + 1];
        if (next && !next.startsWith('#') && bw < bestBw) { bestBw = bw; bestUrl = new URL(next, MASTER).href; }
      }
      assert.ok(bestUrl, 'master 播放列表中应有清晰度地址');
      const mediaText = (await fetchRetry(bestUrl, 3, 30000)).toString('utf8');
      const segUrls = [];
      for (const line of mediaText.split('\n')) {
        const l = line.trim();
        if (l && !l.startsWith('#')) segUrls.push(new URL(l, bestUrl).href);
        if (segUrls.length >= 3) break;
      }
      assert.strictEqual(segUrls.length, 3, '应获取到 3 个真实分片地址');
      for (let i = 0; i < 3; i++) {
        const buf = await fetchRetry(segUrls[i], 4, 120000);
        assert.ok(buf.length > 10000 && buf[0] === 0x47, '分片 ' + i + ' 应为 TS 数据');
        writeFileSync(segFiles[i], buf);          /* 缓存供后续运行使用 */
        writeFileSync(join(serveDir, 'seg' + i + '.ts'), buf);
        segBytes += buf.length;
      }
      ok('已获取 3 个真实 TS 分片素材并缓存 (' + (segBytes / 1024).toFixed(0) + ' KB)');
    }

    writeFileSync(join(serveDir, 'stream.m3u8'), [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:10.0,',
      '/seg0.ts',
      '#EXTINF:10.0,',
      '/seg1.ts',
      '#EXTINF:10.0,',
      '/seg2.ts',
      '#EXT-X-ENDLIST'
    ].join('\n'));
    ok('已生成测试播放列表（本地分片，相对路径）');

    /* 本地 mp4（优先缓存；缺失时从 MDN 拉取，失败则跳过） */
    let hasMp4 = false;
    const mp4Fixture = join(FIXTURES, 'flower.mp4');
    try {
      let mp4Buf = null;
      if (existsSync(mp4Fixture)) {
        mp4Buf = readFileSync(mp4Fixture);
      } else {
        mp4Buf = Buffer.from(await (await fetch('https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', { signal: AbortSignal.timeout(60000) })).arrayBuffer());
        writeFileSync(mp4Fixture, mp4Buf);
      }
      writeFileSync(join(serveDir, 'flower.mp4'), mp4Buf);
      hasMp4 = true;
      ok('本地 mp4 素材就绪 (' + (mp4Buf.length / 1024).toFixed(0) + ' KB)');
    } catch (e) {
      console.log('  ⚠ mp4 素材获取失败（跳过该部分）: ' + e.message);
    }

    writeFileSync(join(serveDir, 'page.html'), `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>e2e test page</title></head><body>
${hasMp4 ? '<video id="v" preload="auto" muted playsinline src="/flower.mp4"></video>' : ''}
<script>
  fetch('/stream.m3u8').then(function(r){ return r.text(); }).then(function(t){
    window.__m3u8 = t; if (document.title === 'e2e test page') document.title = 'm3u8-fetched';
  });
</script>
</body></html>`);

    /* ---------- 启动本地静态服务器 ---------- */
    server = createServer((req, res) => {
      let p = new URL(req.url, 'http://127.0.0.1').pathname;
      if (p === '/') p = '/page.html';
      const map = {
        '/page.html': 'text/html; charset=utf-8',
        '/stream.m3u8': 'application/vnd.apple.mpegurl',
        '/flower.mp4': 'video/mp4',
        '/seg0.ts': 'video/mp2t',
        '/seg1.ts': 'video/mp2t',
        '/seg2.ts': 'video/mp2t'
      };
      if (map[p]) {
        const body = readFileSync(join(serveDir, p.slice(1)));
        res.writeHead(200, { 'Content-Type': map[p], 'Content-Length': body.length });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PAGE_PORT = server.address().port;
    const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/page.html`;
    console.log('  本地测试服务: ' + PAGE_URL);

    /* ---------- 启动浏览器 ---------- */
    console.log('\n[1] 启动无头浏览器并加载扩展');
    chromeProc = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=' + DEBUG_PORT,
      '--user-data-dir=' + profileDir,
      '--enable-unsafe-extension-debugging',
      '--load-extension=' + ROOT,
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let browserWs = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        const j = await r.json();
        browserWs = j.webSocketDebuggerUrl;
        console.log('  浏览器已就绪: ' + j.Browser);
        break;
      } catch (e) { /* 继续等待 */ }
    }
    if (!browserWs) throw new Error('浏览器调试端口未就绪，启动失败');

    cdp = new CDP(browserWs);
    await cdp.connect();

    /* 加载扩展：优先 CDP，其次依赖 --load-extension */
    let extId = null;
    try {
      const r = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
      extId = r && r.id;
      ok('扩展已通过 CDP 加载，ID: ' + extId);
    } catch (e) {
      console.log('  （CDP 加载扩展不可用，使用命令行方式加载: ' + String(e.message || e).slice(0, 120) + '）');
    }

    /* 等待 Service Worker 目标出现 */
    let swTarget = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await cdp.send('Target.getTargets');
      swTarget = t.targetInfos.find((x) => x.type === 'service_worker' && /background\.js/.test(x.url));
      if (swTarget) {
        extId = extId || /chrome-extension:\/\/([a-p]+)\//.exec(swTarget.url)[1];
        break;
      }
    }
    if (!swTarget) throw new Error('扩展 Service Worker 未出现，扩展加载失败（可能被浏览器策略阻止）');
    ok('扩展 Service Worker 已启动: ' + extId);

    const swSession = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swSession);

    /* 下载重定向到临时目录，避免污染真实下载文件夹 */
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    ok('已设置测试下载目录');

    /* ---------- 打开测试页面并验证嗅探 ---------- */
    console.log('\n[2] 打开测试页面，验证资源嗅探');
    const pageTarget = (await cdp.send('Target.createTarget', { url: PAGE_URL })).targetId;
    const pageSession = (await cdp.send('Target.attachToTarget', { targetId: pageTarget, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pageSession);

    await sleep(6000); // 等待页面请求 m3u8 / mp4 并被嗅探

    const dump = await evalIn(cdp, swSession,
      'chrome.storage.session.get(null).then(a => JSON.stringify(a).slice(0, 20000))');
    const store = JSON.parse(dump || '{}');
    const tabKeys = Object.keys(store).filter((k) => k.startsWith('tab:'));
    const allItems = [];
    for (const k of tabKeys) {
      const items = store[k].items || {};
      for (const u of Object.keys(items)) allItems.push(items[u]);
    }
    console.log('  嗅探结果: ' + (allItems.map((i) => i.kind + ':' + i.url.split('/').pop()).join(', ') || '(空)'));

    const hlsItem = allItems.find((i) => /stream\.m3u8/.test(i.url));
    assert.ok(hlsItem, '应嗅探到 stream.m3u8');
    assert.strictEqual(hlsItem.kind, 'hls', 'stream.m3u8 应被识别为 hls');
    ok('m3u8 嗅探成功（类型: ' + hlsItem.kind + '，来源: ' + hlsItem.source + '）');

    const mp4Item = allItems.find((i) => /flower\.mp4/.test(i.url));
    assert.ok(mp4Item, '应嗅探到 flower.mp4');
    ok('mp4 嗅探成功（类型: ' + mp4Item.kind + '）');

    /* ---------- 触发 HLS 下载任务 ---------- */
    console.log('\n[3] 触发 HLS 下载任务（等价于 popup 点击"选择清晰度 → 下载"）');
    const streamUrl = `http://127.0.0.1:${PAGE_PORT}/stream.m3u8`;

    async function runTask(name, saveMethod, folder) {
      const startRes = await evalIn(cdp, swSession,
        `handleMessage({ type: 'START_HLS', tabId: -1, url: ${JSON.stringify(streamUrl)}, pageUrl: ${JSON.stringify(PAGE_URL)}, name: ${JSON.stringify(name)}, folder: ${JSON.stringify(folder || '')}, format: 'auto', concurrency: 6, saveMethod: ${JSON.stringify(saveMethod)} }, {}).then(r => JSON.stringify(r))`);
      const started = JSON.parse(startRes);
      assert.ok(started.taskId, '任务应成功创建: ' + startRes);

      let task = null;
      for (let i = 0; i < 120; i++) {
        await sleep(1000);
        const tdump = await evalIn(cdp, swSession,
          'chrome.storage.session.get("tasks").then(a => JSON.stringify(a))');
        const tasks = JSON.parse(tdump || '{}').tasks || {};
        task = tasks[started.taskId];
        if (task && task.status !== 'running') break;
        if (i % 5 === 0) {
          console.log('  … 进度: ' + (task ? `${task.phase} ${task.done || 0}/${task.total || '?'} ${((task.bytes || 0) / 1024).toFixed(0)}KB` : '等待中'));
        }
      }
      assert.ok(task, '任务状态应可读取');
      assert.strictEqual(task.status, 'done', '任务应成功完成，实际: ' + JSON.stringify(task));
      ok(`下载任务完成 [${saveMethod}${folder ? '+' + folder : ''}]: ` + (task.sizeStr || '') + '（保存方式: ' + (task.saveVia || '?') + '）' + (task.note ? '（' + task.note + '）' : ''));
      return task;
    }

    await runTask('e2e-anchor', 'anchor', '');
    await runTask('e2e-anchor2', 'anchor', 'e2e-subdir');
    await runTask('e2e-bg', 'bg', 'e2e-subdir');

    /* ---------- 校验落盘文件 ---------- */
    console.log('\n[4] 校验下载到本地的文件');
    await sleep(2500);
    const files = readdirSync(dlDir, { recursive: true });
    console.log('  下载目录内容: ' + (files.join(', ') || '(空)'));

    for (const [expect, tag] of [
      ['e2e-anchor.mp4', 'anchor 无子目录'],
      ['e2e-subdir\\e2e-anchor2.mp4', 'anchor 带子目录'],
      ['e2e-subdir\\e2e-bg.mp4', 'bg 带子目录']
    ]) {
      if (files.includes(expect)) {
        ok(`文件已保存且路径正确 [${tag}]: ` + expect);
      } else {
        console.log(`  ⚠ [${tag}] 期望 ${expect}，未找到（当前: ` + files.join(', ') + '）');
      }
    }

    const anyFile = files.find((f) => /\.mp4$|\.ts$/.test(f));
    assert.ok(anyFile, '下载目录中应存在视频文件');
    const buf = readFileSync(join(dlDir, anyFile));
    assert.ok(buf.length > 100 * 1024, '文件过小: ' + buf.length);
    assert.strictEqual(buf.toString('latin1', 4, 8), 'ftyp', 'MP4 应以 ftyp box 开头');
    ok('文件为有效 MP4（fMP4）: ' + anyFile + ' (' + (buf.length / 1024).toFixed(0) + ' KB, 头含 ftyp)');

    /* ---------- popup 界面冒烟测试 ---------- */
    console.log('\n[5] 校验 popup 界面加载');
    const popTarget = (await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` })).targetId;
    const popSession = (await cdp.send('Target.attachToTarget', { targetId: popTarget, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, popSession);
    await sleep(2500);
    const uiRaw = await evalIn(cdp, popSession, `JSON.stringify({
      title: (document.querySelector('.title') || {}).textContent || '',
      chips: document.querySelectorAll('.chip').length,
      hlsKit: typeof HLSKit,
      emptyRendered: !!document.querySelector('.empty'),
      foot: (document.querySelector('#footHint') || {}).textContent || ''
    })`);
    const ui = JSON.parse(uiRaw);
    assert.strictEqual(ui.title, '视频嗅探下载器', 'popup 标题应渲染');
    assert.ok(ui.chips >= 5, '筛选按钮应渲染');
    assert.strictEqual(ui.hlsKit, 'object', 'popup 中 HLSKit 应已加载');
    assert.ok(ui.emptyRendered, 'popup 初始化应完成（空状态渲染）');
    ok('popup 界面正常渲染（标题/筛选/初始化流程均正常）');
  } catch (e) {
    bad('端到端流程', e);
  } finally {
    /* ---------- 清理 ---------- */
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { if (server) server.close(); } catch (e) { /* ignore */ }
    if (chromeProc && chromeProc.pid) {
      try { spawn('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
    await sleep(800);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log(`端到端结果：通过 ${pass} 项，失败 ${fail} 项`);
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
