/* ============================================================
 * 全量回归总控脚本
 * 运行：node test/run_all.mjs
 *
 * 作用：把 19 个测试套件按「单测 → 端到端 → 界面 → 离线自检」顺序全部跑一遍，
 *       并自动处理需要本地服务器的套件（自行启动/停止 serve_local.mjs）。
 *
 * 为什么需要它：套件多了以后手动逐个跑容易漏（尤其新增套件后忘记加进回归清单），
 *       漏跑的套件等于没有测试。这里把清单固化在代码里，新增套件时改一处即可，
 *       并且每次跑完都会核对「实际套件数」与清单是否一致。
 *
 * 选项：
 *   --only=<关键字>   只跑名字含该关键字的套件
 *   --skip-net        跳过标注「需公网」的套件
 *   --list            只列出套件清单
 * ============================================================ */
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* 套件清单：{ file, name, needsServer?, needsNet? }
   顺序按「纯逻辑单测 → 端到端 → 界面 → 离线自检」，失败时先看到最廉价的报错。 */
const SUITES = [
  { file: 'engine.test.mjs',            name: '引擎单测' },
  { file: 'sniffsig.test.mjs',          name: '内容签名识别' },
  { file: 'mediarole.test.mjs',         name: '媒体角色识别' },
  { file: 'mpd.test.mjs',               name: 'DASH 清单解析' },
  { file: 'fmp4merge.test.mjs',         name: 'fMP4 合并' },
  { file: 'hls_cred.test.mjs',          name: 'HLS 凭证与编码识别' },
  { file: 'webmmerge.test.mjs',         name: 'WebM 合并' },
  { file: 'e2e_headless.mjs',           name: '端到端基础' },
  { file: 'e2e_merge.mjs',              name: '合并下载端到端' },
  { file: 'e2e_merge_fallback.mjs',     name: '合并失败降级' },
  { file: 'e2e_sniff_gaps.mjs',         name: '嗅探盲区端到端', needsNet: true },
  { file: 'e2e_douyin_style.mjs',       name: '抖音形态端到端' },
  { file: 'douyin_real_sample.test.mjs', name: '抖音真实样本' },
  { file: 'e2e_dash_parts.mjs',         name: 'DASH 分片端到端' },
  { file: 'e2e_youtube_style.mjs',      name: 'YouTube 形态端到端' },
  { file: 'e2e_hls_aes.mjs',            name: 'HLS AES-128 端到端' },
  { file: 'e2e_cred_fallback.mjs',      name: 'HLS 凭证降级端到端' },
  { file: 'popup_tracks.test.mjs',      name: '界面轨道配对回归' },
  { file: 'verify_local_page.mjs',      name: '离线验证环境自检', needsServer: true },
];

const NODE = process.execPath;
const SERVER_PORT = Number(process.env.RUN_ALL_PORT || 8799);

const argv = process.argv.slice(2);
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const SKIP_NET = argv.includes('--skip-net');
const LIST = argv.includes('--list');

/* ---------------- 工具 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };

function runSuite(file, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [join('test', file)], {
      cwd: ROOT,
      env: { ...process.env, ...(extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10 * 60 * 1000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/* 从输出里解析「通过 N 项 / N 通过 / N/M 通过」三套写法 */
function parseCount(out) {
  const pats = [
    /通过\s*(\d+)\s*项/,
    /(\d+)\s*通过/,
    /(\d+)\/(\d+)\s*通过/,
    /Passed\s*(\d+)/i,
  ];
  for (const re of pats) {
    const m = out.match(re);
    if (m) return Number(m[2] || m[1]);
  }
  return null;
}

async function waitServer(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* 尚未就绪 */ }
    await sleep(400);
  }
  return false;
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  /* 清单一致性核对：test/ 下所有 *.test.mjs 与 e2e_*.mjs / verify_local_page.mjs
     都必须在 SUITES 里，漏一个就报警 —— 这是本脚本存在的意义。 */
  const all = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.mjs'));
  /* 套件命名约定：*.test.mjs / e2e_*.mjs / verify_local_page.mjs；
     probe 类与 real_sites / serve_local / run_all 属工具，不计入回归。 */
  const isSuiteName = (f) => /\.test\.mjs$/.test(f) || /^e2e_.*\.mjs$/.test(f) || f === 'verify_local_page.mjs';
  const onDisk = all.filter(isSuiteName);
  const listed = SUITES.map((s) => s.file);
  const missing = onDisk.filter((f) => !listed.includes(f));
  const stale = listed.filter((f) => !onDisk.includes(f));
  if (missing.length || stale.length) {
    console.log(C.yellow + '\n⚠ 套件清单与 test/ 目录不一致：' + C.reset);
    if (missing.length) console.log(C.yellow + '   未纳入回归的套件: ' + missing.join(', ') + C.reset);
    if (stale.length) console.log(C.yellow + '   清单里已不存在: ' + stale.join(', ') + C.reset);
    console.log(C.yellow + '   请同步 test/run_all.mjs 的 SUITES 数组。' + C.reset);
  }

  let suites = SUITES;
  if (ONLY) suites = suites.filter((s) => s.file.includes(ONLY) || s.name.includes(ONLY));
  if (SKIP_NET) suites = suites.filter((s) => !s.needsNet);

  if (LIST) {
    for (const s of suites) console.log('  ' + s.file.padEnd(30) + s.name + (s.needsServer ? '  [需本地服务]' : '') + (s.needsNet ? '  [需公网]' : ''));
    return 0;
  }

  console.log(C.cyan + '全量回归：' + suites.length + ' 个套件' + C.reset + (ONLY ? '（筛选：' + ONLY + '）' : ''));
  console.log('='.repeat(64));

  /* 若有套件需要本地服务器，先启动一个（测试完自动关掉） */
  let server = null, serverOk = true;
  if (suites.some((s) => s.needsServer)) {
    console.log(C.gray + '启动本地验证服务器（端口 ' + SERVER_PORT + '）…' + C.reset);
    server = spawn(NODE, [join('test', 'serve_local.mjs'), '--port=' + SERVER_PORT], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    serverOk = await waitServer(SERVER_PORT, 60000);
    console.log(serverOk ? C.gray + '  服务器已就绪' + C.reset : C.red + '  服务器启动超时，相关套件将记为失败' + C.reset);
  }

  const results = [];
  try {
    for (const s of suites) {
      const label = s.name + ' ' + C.gray + '(' + s.file + ')' + C.reset;
      process.stdout.write('→ ' + label + ' … ');
      if (s.needsServer && !serverOk) {
        results.push({ ...s, code: 1, count: null, note: '服务器未就绪' });
        console.log(C.red + '失败（服务器未就绪）' + C.reset);
        continue;
      }
      const { code, out } = await runSuite(s.file, s.needsServer ? { PORT: String(SERVER_PORT) } : undefined);
      const count = parseCount(out);
      results.push({ ...s, code, count, out });
      if (code === 0) {
        console.log(C.green + '通过' + C.reset + (count ? '（' + count + ' 项）' : ''));
      } else {
        console.log(C.red + '失败' + C.reset);
        const tail = out.split('\n').filter((l) => /✗|失败|Error/.test(l)).slice(-8);
        for (const l of tail) console.log('   ' + C.red + l.trim() + C.reset);
      }
    }
  } finally {
    if (server) killTree(server.pid);
  }

  /* 汇总 */
  const ok = results.filter((r) => r.code === 0);
  const bad = results.filter((r) => r.code !== 0);
  const totalItems = results.reduce((sum, r) => sum + (r.count || 0), 0);
  console.log('='.repeat(64));
  console.log('套件：' + C.green + ok.length + ' 通过' + C.reset + (bad.length ? ' / ' + C.red + bad.length + ' 失败' + C.reset : '') +
    '，断言合计 ' + totalItems + ' 项' + (results.every((r) => r.count !== null) ? '' : C.yellow + '（部分套件未解析到项数）' + C.reset));
  if (bad.length) {
    console.log(C.red + '失败套件：' + bad.map((b) => b.file + (b.note ? '（' + b.note + '）' : '')).join(', ') + C.reset);
    return 1;
  }
  console.log(C.green + '✓ 全部通过' + C.reset);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
