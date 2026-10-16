/* ============================================================
 * 抖音媒体流形态探针（开发诊断脚本）
 *
 * 目的：搞清楚抖音网页版视频请求的真实形态，回答三个问题：
 *   1. 视频轨 / 音频轨的 URL 长什么样（后缀？无后缀？路径特征？）
 *   2. 各自的 Content-Type 是什么（video/mp4？audio/mp4？octet-stream？）
 *   3. 下载下来的字节是 fMP4 分片（moof）还是普通 MP4（moov+stbl）？
 *
 * 做法：无头 Chrome（普通 UA）打开抖音，尝试关闭登录弹窗、滚动触发播放，
 *       用 CDP Network 域收集全部请求；对疑似媒体请求下载头部 512KB 分析 box 结构。
 * 运行：node test/douyin_probe.mjs
 * 结果：test/evidence/douyin_probe_result.json + 控制台报告
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EVIDENCE = join(__dirname, 'evidence');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

/* ---------------- 迷你 CDP 客户端（同 real_sites.mjs） ---------------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
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
          } else if (m.method) {
            const h = this.handlers.get(m.method);
            if (h) h(m.params, m.sessionId);
          }
        };
        res();
      };
      this.ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
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
  try {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) return undefined;
    return r.result ? r.result.value : undefined;
  } catch (e) { return undefined; }
}

/* ---------------- box 结构速查（与 lib/fmp4merge.js 同思路的最小实现） ---------------- */
function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
function rdU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function analyzeHead(u8) {
  /* 递归遍历 box 树（只深入容器型 box），准确区分：
     - fMP4 分片：moov 内含 mvex，其后是 moof/mdat 序列
     - 普通 MP4：moov 内含 stbl 的样本表（stts/stsz/stco），其后是 mdat */
  const tree = [];
  (function walk(start, end, depth) {
    let p = start;
    while (p + 8 <= end && tree.length < 300) {
      const size = rdU32(u8, p);
      const type = fourcc(u8, p + 4);
      if (!/^[\x20-\x7e]{4}$/.test(type) || size < 8 || p + size > end) break;
      tree.push({ type, depth, size, start: p });
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf'].includes(type)) {
        walk(p + 8, p + size, depth + 1);
      }
      p += size;
    }
  })(0, u8.length, 0);

  const types = tree.map((b) => b.type);
  const has = (t) => types.indexOf(t) >= 0;
  const text4k = Buffer.from(u8.subarray(0, 4096)).toString('latin1');
  const sampleTables = ['stts', 'stsz', 'stz2', 'stsc', 'stco', 'co64', 'ctts', 'stss']
    .filter((t) => types.indexOf(t) >= 0);

  return {
    size: u8.length,
    boxes: tree.filter((b) => b.depth <= 1).map((b) => b.type + '(' + b.size + ')'),
    hasFtyp: has('ftyp'), hasMoov: has('moov'), hasMoof: has('moof'), hasMvex: has('mvex'),
    hasStbl: has('stbl'),
    sampleTables,
    verdict: has('moof') ? 'fMP4（分片）' : (has('moov') ? (sampleTables.length ? '普通 MP4（含样本表）' : 'MP4（结构待定）') : '非 MP4 / 截断'),
    handlers: ['vide', 'soun'].filter((h) => text4k.includes(h)),
    codecs: ['avc1', 'hvc1', 'hev1', 'avc3', 'mp4a', 'opus', 'ac-3', 'ec-3'].filter((c) => text4k.includes(c))
  };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'sniffer-douyin-'));

  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--enable-unsafe-extension-debugging',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + profile,
    '--user-agent=' + UA,
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { child.kill(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 1500);
  };

  try {
    /* 等 CDP 端口就绪 */
    let wsUrl = '';
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      try {
        const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version');
        const j = await r.json();
        if (j && j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
      } catch (e) { /* 继续等 */ }
    }
    if (!wsUrl) throw new Error('Chrome CDP 端口未就绪');

    const cdp = new CDP(wsUrl);
    await cdp.connect();

    /* 打开抖音首页，收集网络请求 */
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    const reqs = new Map();   // requestId -> { url, type, ct, status, len }
    cdp.on('Network.requestWillBeSent', (p) => {
      if (!p.request || !p.request.url) return;
      reqs.set(p.requestId, { url: p.request.url, type: p.type || '', ct: '', status: 0, len: 0, mime: '' });
    });
    cdp.on('Network.responseReceived', (p) => {
      const r = reqs.get(p.requestId);
      if (!r) return;
      r.status = p.response.status;
      const hs = p.response.headers || {};
      r.ct = String(hs['content-type'] || hs['Content-Type'] || '');
      r.len = parseInt(hs['content-length'] || '0', 10) || 0;
      r.mime = p.response.mimeType || '';
    });

    const target = process.argv[2] || 'https://www.douyin.com/';
    console.log('打开目标页面… ' + target);
    await cdp.send('Page.navigate', { url: target }, sessionId);
    await sleep(12000);

    /* 尝试关闭登录弹窗（多种可能的选择器） */
    const closed = await evalIn(cdp, sessionId, `(() => {
      const sels = [
        '[data-e2e="close-login"]', '.login-mask-close', '.dy-account-close',
        'div[class*="close"] svg', 'img[alt="close"]', 'button[aria-label="关闭"]'
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) { el.click(); return 'clicked: ' + s; }
      }
      /* 兜底：找 "登录" 弹窗容器里的 X */
      const mask = document.querySelector('[class*="login"]');
      if (mask) {
        const x = mask.querySelector('svg, img, [class*="close"]');
        if (x) { x.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'clicked mask child'; }
      }
      return 'no-dialog-found';
    })()`);

    /* 再等一会儿，滚动页面触发内容加载 */
    await sleep(6000);
    await evalIn(cdp, sessionId, `window.scrollBy(0, 600)`);
    await sleep(8000);

    /* 页面状态速览 */
    const pageInfo = await evalIn(cdp, sessionId, `(() => {
      const vs = Array.from(document.querySelectorAll('video'));
      return {
        title: document.title,
        videoCount: vs.length,
        videos: vs.slice(0, 6).map(v => ({
          src: (v.currentSrc || v.src || '').slice(0, 140),
          isBlob: /^blob:/.test(v.currentSrc || v.src || ''),
          readyState: v.readyState,
          duration: Math.round(v.duration || 0)
        }))
      };
    })()`);

    /* 汇总媒体类请求 */
    const all = Array.from(reqs.values());
    const mediaish = all.filter((r) => {
      if (/douyinvod|douyinpic|byteimg|ixigua/.test(r.url) && /video|audio|media|stream|tos/.test(r.url)) return true;
      if (/^video\/|^audio\//.test(r.ct)) return true;
      if (r.type === 'media') return true;
      if (/\.(mp4|m4s|m4a|mpd|m3u8)/i.test(r.url)) return true;
      return false;
    });

    console.log('\n--- 页面状态 ---');
    console.log(JSON.stringify(pageInfo, null, 2));
    console.log('\n--- 关弹窗结果: ' + closed + ' ---');
    console.log('\n--- 媒体类请求（' + mediaish.length + '/' + all.length + '） ---');
    for (const r of mediaish) {
      console.log('[' + (r.type || '?') + '] ' + r.status + ' ' + (r.ct || '(no-ct)') + '  len=' + r.len);
      console.log('   ' + r.url.slice(0, 200));
    }

    /* 对抖音真实分离轨（douyinvod）下载头部字节。
       通道 1：浏览器上下文 fetch（复用真实 UA / Referer / Cookie / CORS）；
       通道 2：node 侧 fetch（带 UA + Referer）兜底。 */
    const dyUrls = [];
    const seenDy = new Set();
    for (const r of mediaish) {
      if (!/douyinvod/.test(r.url)) continue;
      const role = /media-video/.test(r.url) ? 'video' : /media-audio/.test(r.url) ? 'audio' : null;
      if (!role || seenDy.has(role)) continue;
      seenDy.add(role);
      dyUrls.push({ role, url: r.url });
    }

    async function downloadHead(url, bytes) {
      const expr = `(async () => {
        try {
          const res = await fetch(${JSON.stringify(url)}, { headers: { Range: 'bytes=0-${bytes - 1}' }, credentials: 'include' });
          const buf = new Uint8Array(await res.arrayBuffer());
          let s = '';
          const chunk = 0x8000;
          for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
          return 'OK|' + res.status + '|' + btoa(s);
        } catch (e) { return 'ERR|' + (e && (e.name + ': ' + e.message)); }
      })()`;
      const r = await evalIn(cdp, sessionId, expr);
      if (typeof r === 'string' && r.startsWith('OK|')) {
        const parts = r.split('|');
        return { via: 'browser', status: parts[1], buf: Buffer.from(parts[2] || '', 'base64') };
      }
      try {
        const res = await fetch(url, { headers: { Range: 'bytes=0-' + (bytes - 1), 'User-Agent': UA, Referer: 'https://www.douyin.com/' } });
        const buf = Buffer.from(await res.arrayBuffer());
        return { via: 'node', status: String(res.status), buf, browserErr: String(r) };
      } catch (e) {
        return { via: 'none', browserErr: String(r), nodeErr: String(e.message || e) };
      }
    }

    console.log('\n--- 抖音分离轨头部分析（' + dyUrls.length + ' 条） ---');
    const analyses = [];
    for (const d of dyUrls) {
      try {
        const got = await downloadHead(d.url, 524288);
        if (got.via === 'none' || !got.buf || !got.buf.length) {
          analyses.push({ role: d.role, url: d.url.slice(0, 200), error: got });
          console.log('\n[' + d.role + '] 下载失败: ' + JSON.stringify(got));
          continue;
        }
        const buf = got.buf;
        writeFileSync(join(EVIDENCE, 'douyin_real_' + d.role + '_head.bin'), buf);
        const a = Object.assign({ role: d.role, via: got.via, httpStatus: got.status, url: d.url.slice(0, 200), bytes: buf.length }, analyzeHead(buf));
        analyses.push(a);
        console.log('\n[' + d.role + '] ' + buf.length + ' 字节（HTTP ' + got.status + '，经 ' + got.via + '，已存 douyin_real_' + d.role + '_head.bin）');
        console.log('  boxes: ' + a.boxes.slice(0, 12).join(' '));
        console.log('  verdict: ' + a.verdict);
        console.log('  moov=' + a.hasMoov + ' moof=' + a.hasMoof + ' mvex=' + a.hasMvex + ' stbl=' + a.hasStbl + ' 样本表=[' + a.sampleTables.join(',') + ']');
        console.log('  handlers=' + a.handlers.join(',') + '  codecs=' + a.codecs.join(','));
      } catch (e) {
        analyses.push({ role: d.role, url: d.url.slice(0, 200), error: String(e.message || e) });
        console.log('\n[' + d.role + '] 下载失败: ' + String(e.message || e));
      }
    }

    /* 落盘证据 */
    const out = {
      time: new Date().toISOString(),
      pageInfo,
      loginDialogClosed: closed,
      totalRequests: all.length,
      mediaRequests: mediaish.map((r) => ({ type: r.type, status: r.status, ct: r.ct, len: r.len, url: r.url.slice(0, 300) })),
      analyses
    };
    writeFileSync(join(EVIDENCE, 'douyin_probe_result.json'), JSON.stringify(out, null, 2));
    console.log('\n证据已写入 test/evidence/douyin_probe_result.json');

    cdp.close();
  } catch (e) {
    console.error('探针失败: ' + String(e.message || e));
    process.exitCode = 1;
  } finally {
    cleanup();
    await sleep(800);
  }
}

main();
