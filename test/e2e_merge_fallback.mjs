/* ============================================================
 * 合并失败降级路径端到端测试
 * 运行：node test/e2e_merge_fallback.mjs
 *
 * 场景：站点把音视频拆成两条流，但其中一条不是 fMP4 分片（没有 mvex），
 *       合并引擎无法处理 —— 此时不能让用户白下载，必须：
 *         1) 保底保存视频轨；
 *         2) 把音频轨也单独存一份（不让数据丢），并在任务说明里写清文件名。
 *
 * 做法：本地托管 [真实 fMP4 视频轨] + [普通 MP4（无 mvex）]，
 *       调 START_MERGE，校验任务状态 / 说明文案 / 下载目录里确实有 2 个文件。
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VF = join(__dirname, 'fixtures', 'dash', 'bili_video_30032_head.m4s');
const AF = join(__dirname, 'fixtures', 'flower.mp4');   // 普通 MP4（无 mvex），用于制造"无法合并"
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.MERGE_FB_PORT || 10003);
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
  if (!existsSync(VF) || !existsSync(AF)) throw new Error('缺少测试样本');

  const vBuf = readFileSync(VF);
  const aBuf = readFileSync(AF);
  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-merge-fb-'));
  const dlDir = join(tmp, 'dl');
  mkdirSync(dlDir, { recursive: true });

  try {
    console.log('\n[0] 本地托管：fMP4 视频轨 + 普通 MP4（无 mvex 的"音频轨"，用于触发合并失败）');
    const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>fb</title></head><body>
<script>Promise.all([fetch('/v.m4s'),fetch('/a.mp4')]).then(function(){document.title='ok';});<\/script></body></html>`;
    server = createServer((req, res) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      const map = {
        '/': ['text/html; charset=utf-8', Buffer.from(page)],
        '/v.m4s': ['video/mp4', vBuf],
        '/a.mp4': ['video/mp4', aBuf]
      };
      if (!map[p]) { res.writeHead(404); res.end('nf'); return; }
      const [type, body] = map[p];
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const PAGE_URL = 'http://127.0.0.1:' + PORT + '/';
    ok('已托管（视频轨 ' + (vBuf.length / 1024).toFixed(0) + ' KB / 普通 MP4 ' + (aBuf.length / 1024).toFixed(0) + ' KB）');

    console.log('\n[1] 启动浏览器并加载扩展');
    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + join(tmp, 'prof'),
      '--enable-unsafe-extension-debugging', '--load-extension=' + ROOT, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });

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
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    ok('扩展已加载（ID: ' + loaded.id + '）');

    console.log('\n[2] 打开页面触发嗅探');
    await cdp.send('Target.createTarget', { url: PAGE_URL });
    await sleep(3500);

    console.log('\n[3] START_MERGE（合并必然失败 → 应走降级路径）');
    const started = JSON.parse(await ev(cdp, swS,
      `handleMessage({type:'START_MERGE',tabId:-1,videoUrl:'${PAGE_URL}v.m4s',audioUrl:'${PAGE_URL}a.mp4',pageUrl:'${PAGE_URL}',name:'fallback-e2e',folder:'',saveMethod:'anchor'},{}).then(r=>JSON.stringify(r))`));
    if (!started.taskId) throw new Error('任务创建失败: ' + JSON.stringify(started));

    let task = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const t = JSON.parse(await ev(cdp, swS, 'chrome.storage.session.get("tasks").then(a=>JSON.stringify(a))') || '{}').tasks || {};
      task = t[started.taskId];
      if (task && task.status !== 'running') break;
    }
    console.log('  任务结果: ' + JSON.stringify(task));
    if (task && task.status === 'done') ok('任务正常结束（不因合并失败而报错中断）'); else bad('任务未正常结束: ' + JSON.stringify(task));
    if (task && /合并失败/.test(task.note || '')) ok('任务说明标明了合并失败原因'); else bad('说明缺少失败原因: ' + (task && task.note));
    if (task && /音频轨已另存/.test(task.note || '')) ok('任务说明包含音频轨另存信息：' + (task.note || '').slice(-40)); else bad('未另存音频轨: ' + (task && task.note));
    if (task && /仅视频轨|分别保存/.test(task.phase || '')) ok('任务阶段描述: ' + task.phase); else bad('阶段描述异常: ' + (task && task.phase));

    console.log('\n[4] 校验下载目录：应有 2 个文件（视频轨 mp4 + 音频轨 m4a）');
    await sleep(2500);
    const files = readdirSync(dlDir, { recursive: true }).filter((f) => {
      try { return statSync(join(dlDir, f)).isFile(); } catch (e) { return false; }
    });
    console.log('  文件列表: ' + files.join(', '));
    const mp4 = files.find((f) => /\.mp4$/i.test(f));
    const m4a = files.find((f) => /\.audio\.m4a$/i.test(f));
    if (mp4 && statSync(join(dlDir, mp4)).size > 100 * 1024) ok('视频轨已保存: ' + mp4 + '（' + (statSync(join(dlDir, mp4)).size / 1024).toFixed(0) + ' KB）');
    else bad('视频轨文件缺失或过小');
    if (m4a && statSync(join(dlDir, m4a)).size > 100 * 1024) ok('音频轨已另存: ' + m4a + '（' + (statSync(join(dlDir, m4a)).size / 1024).toFixed(0) + ' KB）');
    else bad('音频轨文件缺失或过小 —— 合并失败时数据被丢掉了');
  } catch (e) {
    bad('测试流程', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    try { server && server.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(600);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log('合并失败降级路径：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
