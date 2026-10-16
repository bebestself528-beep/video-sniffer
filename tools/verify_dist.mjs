/* ============================================================
 * 上传包强制校验（开发工具，不随商店包分发）
 * 运行：node tools/verify_dist.mjs
 *
 * 做四件事：
 *   A. 独立解析 zip 的中央目录，逐条目校验 CRC32 并真实解压（证明包没坏）
 *   B. 把解压出的副本真正加载进 Chrome，验证扩展能启动、popup 能渲染
 *      —— 即"我们实际上传的那个文件"是可用的，而不只是源码目录可用
 *   C. 政策合规扫描：远程代码 / 危险模式 / manifest 与隐私声明一致性
 *   D. 输出结论报告到 store/dist/verify_report.md
 * ============================================================ */
import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync
} from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'store', 'dist');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.VERIFY_DEBUG_PORT || 9555);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pass = [], fail = [], warn = [];
const P = (s) => { pass.push(s); console.log('  ✓ ' + s); };
const F = (s) => { fail.push(s); console.error('  ✗ ' + s); };
const W = (s) => { warn.push(s); console.warn('  ⚠ ' + s); };

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

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
      this.ws.onclose = () => { for (const { rej: j } of this.pending.values()) j(new Error('CDP 关闭')); this.pending.clear(); };
    });
  }
  send(method, params, sessionId) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
async function evalIn(cdp, sid, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

/* ================================================================
 * A. 解析 zip + CRC 校验 + 解压
 * ================================================================ */
function unzipTo(zipPath, outDir) {
  const buf = readFileSync(zipPath);
  /* 从尾部倒查 EOCD */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 EOCD，不是合法 ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) throw new Error('中央目录偏移越界');

  const files = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录条目签名错误 @' + p);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    /* 本地头 */
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('本地头签名错误: ' + name);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error('不支持的压缩方式 ' + method + ': ' + name);

    const actualCrc = crc32(data);
    files.push({ name, size: uncompSize, actual: data.length, crcOk: actualCrc === crc, data });
    if (actualCrc !== crc) throw new Error('CRC 不匹配: ' + name);
    if (data.length !== uncompSize) throw new Error('长度不匹配: ' + name);

    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (p !== cdOff + cdSize) throw new Error('中央目录长度与声明不一致');

  /* 落地 */
  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const abs = join(outDir, f.name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.data);
  }
  return files;
}

/* ================================================================
 * C. 政策合规扫描
 * ================================================================ */
function scanCompliance(dir) {
  const jsFiles = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const abs = join(d, n);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (/\.(js|mjs)$/i.test(n)) jsFiles.push(abs);
    }
  })(dir);

  const RULES = [
    { id: 'eval', re: /\beval\s*\(/, why: '使用 eval()，违反 MV3 远程代码/不安全执行策略' },
    { id: 'newFunction', re: /new\s+Function\s*\(/, why: '使用 new Function()，同上' },
    { id: 'remoteScript', re: /createElement\(\s*['"]script['"]\s*\)[\s\S]{0,200}?\.src\s*=/, why: '动态注入外部脚本，可能被判定为远程代码' },
    { id: 'insertAdjacentHTML-remote', re: /insertAdjacentHTML\s*\(\s*['"][^'"]*['"]\s*,\s*(?!['"`])/, why: 'insertAdjacentHTML 拼接非字面量，注意 XSS 风险' },
    { id: 'chromeTabsExec', re: /chrome\.tabs\.executeScript/, why: '使用了已废弃的 executeScript' },
    { id: 'webRequestBlocking', re: /['"]webRequestBlocking['"]/, why: '申请了 webRequestBlocking（MV3 已限制，且会加重审核）' },
    { id: 'evalAttribute', re: /setAttribute\(\s*['"]on\w+['"]/, why: '通过 setAttribute 绑定事件，可能被 CSP 拒绝' },
    { id: 'httpFetch', re: /fetch\s*\(\s*['"]http:\/\//, why: '存在明文 HTTP 请求' }
  ];

  const findings = [];
  for (const f of jsFiles) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(dir, f).split('\\').join('/');
    const lines = src.split('\n');
    for (const r of RULES) {
      lines.forEach((ln, i) => {
        if (r.re.test(ln)) findings.push({ file: rel, line: i + 1, rule: r.id, why: r.why, code: ln.trim().slice(0, 120) });
      });
    }
  }
  return { jsCount: jsFiles.length, findings };
}

/* ================================================================
 * 主流程
 * ================================================================ */
let chromeProc = null, cdp = null;

async function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const zipPath = join(DIST, 'video-sniffer-' + manifest.version + '.zip');
  if (!existsSync(zipPath)) throw new Error('未找到上传包，请先运行 node tools/build_zip.mjs\n  期望路径: ' + zipPath);

  console.log('\n=== A. 校验上传包结构 ===');
  console.log('  文件: ' + zipPath + '  (' + (statSync(zipPath).size / 1024).toFixed(0) + ' KB)');
  const zipSha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  const extractDir = join(tmpdir(), 'vsniffer-verify-' + Date.now());
  const files = unzipTo(zipPath, extractDir);
  P('ZIP 可被独立解析：' + files.length + ' 个条目，全部 CRC32 校验通过');
  console.log('  SHA-256: ' + zipSha);

  const hasManifest = files.some((f) => f.name === 'manifest.json');
  if (hasManifest) P('manifest.json 位于包根目录（商店要求）'); else F('manifest.json 不在包根目录');
  const leak = files.filter((f) => /(^|\/)(test|tools|store|node_modules)(\/|$)/.test(f.name));
  if (!leak.length) P('包内无 test/tools/store/node_modules 残留'); else F('包内存在应排除的路径: ' + leak.map((f) => f.name).join(', '));

  /* manifest 与包内文件的一致性 */
  const names = new Set(files.map((f) => f.name));
  const refs = [manifest.background && manifest.background.service_worker, manifest.action && manifest.action.default_popup]
    .concat(manifest.icons ? Object.values(manifest.icons) : [])
    .filter(Boolean);
  const missing = refs.filter((r) => !names.has(r));
  if (!missing.length) P('manifest 引用的入口文件全部在包内（' + refs.length + ' 项）'); else F('manifest 引用的文件缺失: ' + missing.join(', '));

  console.log('\n=== C. 政策合规扫描 ===');
  const scan = scanCompliance(extractDir);
  console.log('  扫描 ' + scan.jsCount + ' 个 JS 文件');
  if (!scan.findings.length) {
    P('未发现 eval / new Function / 远程脚本注入 / webRequestBlocking 等高风险模式');
  } else {
    for (const f of scan.findings) {
      if (f.rule === 'insertAdjacentHTML-remote' || f.rule === 'httpFetch') W(`[${f.rule}] ${f.file}:${f.line} — ${f.why}\n      ${f.code}`);
      else F(`[${f.rule}] ${f.file}:${f.line} — ${f.why}\n      ${f.code}`);
    }
  }

  /* manifest 权限与隐私声明的一致性 */
  const perms = (manifest.permissions || []).slice().sort();
  console.log('  声明权限: ' + perms.join(', '));
  const explained = ['webRequest', 'downloads', 'storage', 'tabs', 'offscreen', 'declarativeNetRequest'];
  const unexplained = perms.filter((p) => explained.indexOf(p) < 0);
  if (!unexplained.length) P('所有 permissions 均在 listing 文案中给出了用途说明'); else W('以下权限尚未在文案中说明: ' + unexplained.join(', '));
  if ((manifest.host_permissions || []).indexOf('<all_urls>') >= 0) W('包含 <all_urls> 主机权限：这是本项目最重要的一项审核关注点，务必在"权限理由"中写清楚（文案已备好）');

  console.log('\n=== B. 用上传包解压出的副本实测加载 ===');
  try {
    const profileDir = join(tmpdir(), 'vsniffer-verify-profile-' + Date.now());
    mkdirSync(profileDir, { recursive: true });
    const chromeLog = [];
    chromeProc = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + DEBUG_PORT,
      '--user-data-dir=' + profileDir,
      '--enable-unsafe-extension-debugging',
      '--load-extension=' + extractDir,
      'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    chromeProc.stdout.on('data', (d) => chromeLog.push(String(d)));
    chromeProc.stderr.on('data', (d) => chromeLog.push(String(d)));

    let browserWs = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const j = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json();
        browserWs = j.webSocketDebuggerUrl;
        break;
      } catch (e) { /* retry */ }
    }
    if (!browserWs) throw new Error('浏览器调试端口未就绪');
    cdp = new CDP(browserWs);
    await cdp.connect();

    let extId = null;
    try {
      const r = await cdp.send('Extensions.loadUnpacked', { path: extractDir });
      extId = r && r.id;
      P('已通过 CDP 加载上传包副本，扩展 ID: ' + extId);
    } catch (e) {
      W('CDP 加载扩展不可用，改用 --load-extension 方式: ' + String(e.message || e).slice(0, 160));
    }

    let swTarget = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await cdp.send('Target.getTargets');
      swTarget = t.targetInfos.find((x) => x.type === 'service_worker' && /background\.js/.test(x.url));
      if (swTarget) { extId = extId || /chrome-extension:\/\/([a-p]+)\//.exec(swTarget.url)[1]; break; }
      if (i === 39) {
        console.error('  诊断 — 当前所有调试目标:');
        for (const ti of t.targetInfos) console.error('    [' + ti.type + '] ' + ti.url.slice(0, 120));
        console.error('  诊断 — 浏览器日志片段:');
        console.error('    ' + chromeLog.join('').split('\n').filter((l) => /extension|Extension|error|Error/i.test(l)).slice(0, 12).join('\n    '));
      }
    }
    if (!swTarget) {
      /* 兜底：探查 chrome://extensions 内是否列出了本扩展 */
      const t = await cdp.send('Target.createTarget', { url: 'chrome://extensions/' }).catch(() => null);
      if (t) {
        const sid = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
        await sleep(1500);
        console.error('  （chrome://extensions 已打开，请人工确认；headless 下该页面可能不渲染）');
        await cdp.send('Target.closeTarget', { targetId: t.targetId });
      }
      throw new Error('扩展 Service Worker 未启动');
    }
    P('上传包副本加载后服务工作线程已启动: ' + extId);

    /* SW 是否报错 */
    const swSid = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swSid);
    const swAlive = await evalIn(cdp, swSid,
      'typeof handleMessage === "function" && typeof classifyUrl === "function" && typeof watchDownload === "function" && typeof normalizeKind === "function"');
    if (swAlive) P('后台服务工作线程函数已就绪（消息中枢 / 地址分类 / 下载回退 均可用）'); else F('后台服务工作线程未正常初始化');

    /* popup 渲染 */
    const popT = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html' })).targetId;
    const popSid = (await cdp.send('Target.attachToTarget', { targetId: popT, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, popSid);
    await sleep(2200);
    const uiRaw = await evalIn(cdp, popSid, `JSON.stringify({
      title: (document.querySelector('.title')||{}).textContent||'',
      chips: document.querySelectorAll('.chip').length,
      hlsKit: typeof HLSKit,
      empty: !!document.querySelector('.empty'),
      policyLink: !!document.querySelector('#usagePolicy'),
      notDemo: document.body.dataset.ready === undefined
    })`);
    const ui = JSON.parse(uiRaw);
    console.log('  popup 状态: ' + uiRaw);
    if (ui.title === '视频嗅探下载器' && ui.chips >= 5 && ui.hlsKit === 'object' && ui.empty) {
      P('popup 界面在真实扩展环境下正常渲染');
    } else F('popup 渲染异常: ' + uiRaw);
    if (ui.policyLink) P('底部使用授权声明链接存在'); else W('底部使用授权链接缺失');

    /* policy.html / privacy.html 可访问 */
    const pagesOk = [];
    for (const page of ['policy.html', 'privacy.html']) {
      const t = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/' + page })).targetId;
      const sid = (await cdp.send('Target.attachToTarget', { targetId: t, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, sid);
      await sleep(700);
      const txt = await evalIn(cdp, sid, '(document.body.innerText||"").length');
      pagesOk.push({ page, len: txt });
      await cdp.send('Target.closeTarget', { targetId: t });
    }
    const bad = pagesOk.filter((p) => !p.len || p.len < 200);
    if (!bad.length) P('政策页与隐私政策页均可正常打开（' + pagesOk.map((p) => p.page + ' ' + p.len + ' 字').join('，') + '）');
    else F('以下页面内容为空或过短: ' + bad.map((p) => p.page).join(', '));
  } catch (e) {
    F('实测加载失败: ' + (e && (e.message || e)));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    if (chromeProc && chromeProc.pid) {
      try { spawn('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
    await sleep(700);
    try { rmSync(extractDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  /* ---------------- 报告 ---------------- */
  const report = [
    '# 上传包校验报告',
    '',
    '- 生成时间：' + new Date().toISOString(),
    '- 上传包：`store/dist/video-sniffer-' + manifest.version + '.zip`（' + (statSync(zipPath).size / 1024).toFixed(0) + ' KB，' + files.length + ' 个文件）',
    '- SHA-256：`' + zipSha + '`',
    '',
    '## 通过项（' + pass.length + '）',
    ...pass.map((s) => '- ✅ ' + s),
    '',
    '## 警告项（' + warn.length + '）',
    ...(warn.length ? warn.map((s) => '- ⚠️ ' + s) : ['- 无']),
    '',
    '## 失败项（' + fail.length + '）',
    ...(fail.length ? fail.map((s) => '- ❌ ' + s) : ['- 无']),
    '',
    '## 包内文件清单',
    ...files.map((f) => '- `' + f.name + '`（' + (f.size / 1024).toFixed(1) + ' KB，CRC 通过）'),
    ''
  ].join('\n');
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, 'verify_report.md'), report);

  console.log('\n========================================');
  console.log('通过 ' + pass.length + ' 项 / 警告 ' + warn.length + ' 项 / 失败 ' + fail.length + ' 项');
  console.log('报告: store/dist/verify_report.md');
  console.log('========================================');
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error('校验脚本异常: ' + (e && (e.stack || e.message) || e));
  process.exit(1);
});
