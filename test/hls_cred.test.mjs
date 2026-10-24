/* ============================================================
 * HLS 取数韧性测试：凭证降级 + 分片重试 + 真实站点清单 + TS 编码识别
 * 运行：node test/hls_cred.test.mjs
 *
 * 守护的 bug（真实站点复现）：某 HLS 站下载时第一步就失败，
 *   界面只提示"加载失败"，用户看到的是"扫不到视频 / 只有音频"。
 *   根因：该 CDN 只回 Access-Control-Allow-Origin、不回
 *   Access-Control-Allow-Credentials。带凭证的跨域 fetch 会被 CORS
 *   直接掐断 —— 浏览器层面表现为 TypeError: Failed to fetch，
 *   连 HTTP 状态码都拿不到。实测同一地址换 credentials:'omit' 立刻 200。
 *
 * 覆盖：
 *   A. fetchSmart 的凭证降级（含按 origin 记忆、AbortError 不降级、
 *      401/403 也换模式、自定义头不被吞）
 *   B. downloadAll 的重试与降速（用假 fetch 逐条构造失败序列）
 *   C. 真实站点清单（test/fixtures/hls/p91-media.m3u8）的解析特征：
 *      AES-128 + 逐片独立 auth_key + 时长与页面声明一致
 *   D. TS 视频编码识别（mux.js 只认 H.264，HEVC 硬转会只剩声音）
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* --------- 加载被测模块（与扩展中加载的是同一份文件） --------- */
vm.runInThisContext(readFileSync(join(ROOT, 'lib/hls.js'), 'utf8'));
const HLSKit = globalThis.HLSKit;
assert.ok(HLSKit, 'HLSKit 加载失败');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + '\n      ' + (e && e.stack || e)); }
}

/* --------- 假 fetch：按 (origin, credentials) 决定行为 --------- */
function makeFetch(rules) {
  const calls = [];
  const fake = (url, init) => {
    const mode = (init && init.credentials) || 'include';
    calls.push({ url, mode, headers: (init && init.headers) || {} });
    const r = rules(url, mode, calls.length);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      arrayBuffer: () => Promise.resolve((r.body || new Uint8Array(0)).buffer || new ArrayBuffer(0))
    });
  };
  fake.calls = calls;
  return fake;
}

const A = 'https://cdn.example.com/a/seg0.ts';
const B = 'https://other.example.net/b/seg0.ts';

console.log('\n[A] fetchSmart 凭证降级');

await test('include 被 CORS 掐断 → 自动改 omit 重试并成功', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch((url, mode) => (mode === 'include'
    ? new TypeError('Failed to fetch')            // CORS 掐断：网络层错误
    : { status: 200, body: new Uint8Array([1, 2, 3]) }));
  globalThis.fetch = f;
  const res = await HLSKit.fetchSmart(A, { cache: 'no-store' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(f.calls.length, 2, '应当先试 include 再试 omit');
  assert.deepStrictEqual(f.calls.map((c) => c.mode), ['include', 'omit']);
});

await test('同一 origin 后续请求直接走 omit，不再白试 include', async () => {
  HLSKit.resetCredCache();
  let n = 0;
  const f = makeFetch((url, mode) => {
    n++;
    if (n === 1 && mode === 'include') return new TypeError('Failed to fetch');
    return { status: 200, body: new Uint8Array([9]) };
  });
  globalThis.fetch = f;
  await HLSKit.fetchSmart(A, {});
  await HLSKit.fetchSmart('https://cdn.example.com/a/seg1.ts', {});
  await HLSKit.fetchSmart('https://cdn.example.com/a/seg2.ts', {});
  assert.strictEqual(f.calls.length, 4, '第 1 次 2 个请求，后 2 次各 1 个');
  assert.deepStrictEqual(f.calls.map((c) => c.mode), ['include', 'omit', 'omit', 'omit']);
});

await test('换一个 origin 重新从 include 开始试', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch((url, mode) => (mode === 'include'
    ? new TypeError('Failed to fetch')
    : { status: 200, body: new Uint8Array([7]) }));
  globalThis.fetch = f;
  await HLSKit.fetchSmart(A, {});
  await HLSKit.fetchSmart(B, {});
  assert.deepStrictEqual(f.calls.map((c) => c.mode), ['include', 'omit', 'include', 'omit']);
});

await test('include 一次就通时不会多发请求', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch(() => ({ status: 200, body: new Uint8Array([5]) }));
  globalThis.fetch = f;
  const res = await HLSKit.fetchSmart(A, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].mode, 'include');
});

await test('401/403 也换凭证模式再试', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch((url, mode) => (mode === 'include'
    ? { status: 403 }
    : { status: 200, body: new Uint8Array([1]) }));
  globalThis.fetch = f;
  const res = await HLSKit.fetchSmart(A, {});
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(f.calls.map((c) => c.mode), ['include', 'omit']);
});

await test('404 不属于凭证问题，不重试', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch(() => ({ status: 404 }));
  globalThis.fetch = f;
  const res = await HLSKit.fetchSmart(A, {});
  assert.strictEqual(res.status, 404);
  assert.strictEqual(f.calls.length, 1, '404 应当原样返回，不换模式重试');
});

await test('AbortError 原样抛出，不降级重试', async () => {
  HLSKit.resetCredCache();
  const err = new Error('已取消'); err.name = 'AbortError';
  const f = makeFetch(() => err);
  globalThis.fetch = f;
  await assert.rejects(() => HLSKit.fetchSmart(A, {}), (e) => e.name === 'AbortError');
  assert.strictEqual(f.calls.length, 1, '取消信号不该触发第二次请求');
});

await test('两种模式都失败时抛出最后一次错误', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch(() => new TypeError('Failed to fetch'));
  globalThis.fetch = f;
  await assert.rejects(() => HLSKit.fetchSmart(A, {}), /Failed to fetch/);
  assert.strictEqual(f.calls.length, 2);
});

await test('init 里的自定义请求头在降级重试后仍然保留', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch((url, mode) => (mode === 'include'
    ? new TypeError('Failed to fetch')
    : { status: 200, body: new Uint8Array([1]) }));
  globalThis.fetch = f;
  await HLSKit.fetchSmart(A, { headers: { Range: 'bytes=0-65535', 'x-cdn-app': '065' } });
  assert.strictEqual(f.calls[1].headers.Range, 'bytes=0-65535');
  assert.strictEqual(f.calls[1].headers['x-cdn-app'], '065');
});

await test('fetchBytes 走同一条降级路径', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch((url, mode) => (mode === 'include'
    ? new TypeError('Failed to fetch')
    : { status: 200, body: new Uint8Array([1, 2, 3, 4]) }));
  globalThis.fetch = f;
  const buf = await HLSKit.fetchBytes(A, {});
  assert.strictEqual(buf.byteLength, 4);
  assert.strictEqual(f.calls[1].mode, 'omit');
});

await test('resetCredCache 之后重新从 include 开始', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch(() => ({ status: 200, body: new Uint8Array([1]) }));
  globalThis.fetch = f;
  await HLSKit.fetchSmart(A, {});
  await HLSKit.fetchSmart(A, {});
  assert.strictEqual(f.calls.length, 2);
  HLSKit.resetCredCache();
  await HLSKit.fetchSmart(A, {});
  assert.strictEqual(f.calls.length, 3);
  assert.strictEqual(f.calls[2].mode, 'include');
});

console.log('\n[B] downloadAll 重试与降速');

/* 构造一份 6 片的媒体清单 */
function mediaOf(n, base) {
  const segments = [];
  for (let i = 0; i < n; i++) {
    segments.push({ url: base + i + '.ts', duration: 5, key: null, byterange: null, seq: i });
  }
  return { kind: 'media', segments, initSegment: null, isLive: false, totalDuration: n * 5, targetDuration: 6, keyMethods: [] };
}

await test('前两次失败、第三次成功 → 整个任务照常完成', async () => {
  HLSKit.resetCredCache();
  const tried = new Map();   // url -> 次数
  const f = makeFetch((url) => {
    const k = (tried.get(url) || 0) + 1;
    tried.set(url, k);
    if (k <= 2) return new TypeError('Failed to fetch');
    return { status: 200, body: new Uint8Array([1, 2, 3]) };
  });
  globalThis.fetch = f;
  const out = await HLSKit.downloadAll(mediaOf(6, 'https://cdn.example.com/s'), { concurrency: 1 });
  assert.strictEqual(out.segments.length, 6);
  assert.strictEqual(out.totalBytes, 18);
  /* 每片：2 次失败 + 1 次成功；凭证降级还会让失败的那次多打一次 omit */
  assert.ok(tried.size === 6, '6 片都试过');
});

await test('连续失败会进入降速，但最终仍能成功', async () => {
  HLSKit.resetCredCache();
  const failUrls = new Set(['https://cdn.example.com/s1.ts', 'https://cdn.example.com/s2.ts']);
  const tried = new Map();
  const f = makeFetch((url) => {
    const k = (tried.get(url) || 0) + 1;
    tried.set(url, k);
    if (failUrls.has(url) && k <= 3) return new TypeError('Failed to fetch');
    return { status: 200, body: new Uint8Array([1]) };
  });
  globalThis.fetch = f;
  const out = await HLSKit.downloadAll(mediaOf(4, 'https://cdn.example.com/s'), { concurrency: 2 });
  assert.strictEqual(out.segments.length, 4, '翻车的分片重试后也必须补齐');
  assert.ok(tried.get('https://cdn.example.com/s1.ts') >= 4, 's1 至少试了 4 次');
});

await test('一直失败的分片最终报错，错误里带分片序号', async () => {
  HLSKit.resetCredCache();
  const f = makeFetch((url) => (url.indexOf('/s2.ts') >= 0
    ? new TypeError('Failed to fetch')
    : { status: 200, body: new Uint8Array([1]) }));
  globalThis.fetch = f;
  await assert.rejects(
    () => HLSKit.downloadAll(mediaOf(3, 'https://cdn.example.com/s'), { concurrency: 1 }),
    /分片 3\/3 下载失败/
  );
});

await test('取消信号立刻中断，不再重试', async () => {
  HLSKit.resetCredCache();
  const ac = new AbortController();
  const err = new Error('已取消'); err.name = 'AbortError';
  const f = makeFetch((url, mode) => {
    if (mode === 'omit') { ac.abort(); return err; }
    return new TypeError('Failed to fetch');
  });
  globalThis.fetch = f;
  await assert.rejects(
    () => HLSKit.downloadAll(mediaOf(3, 'https://cdn.example.com/s'), { concurrency: 1, signal: ac.signal }),
    (e) => e.name === 'AbortError'
  );
});

console.log('\n[C] 真实站点清单（91porna video_key=102320）');

const real = readFileSync(join(__dirname, 'fixtures', 'hls', 'p91-media.m3u8'), 'utf8');
const REAL_BASE = 'https://yd-hls.hzjvlo.cn/videos3/16b059270bd26b9db0c36469f05ef6ab/16b059270bd26b9db0c36469f05ef6ab.m3u8';

await test('是媒体清单而非主清单（单一混合流，没有清晰度可选）', () => {
  const p = HLSKit.parsePlaylist(real, REAL_BASE);
  assert.strictEqual(p.kind, 'media');
  assert.strictEqual(p.variants, undefined);
});

await test('AES-128 加密且密钥地址是绝对地址', () => {
  const p = HLSKit.parsePlaylist(real, REAL_BASE);
  assert.deepStrictEqual(p.keyMethods, ['AES-128']);
  const k = p.segments[0].key;
  assert.ok(k, '分片必须带上密钥信息');
  assert.strictEqual(k.method, 'AES-128');
  assert.ok(/^https?:\/\//.test(k.uri), '密钥 URI 必须是绝对地址');
  assert.strictEqual(k.iv, '0xaeaedcdebccefbf35e04a2adea48304a');
});

await test('每个分片的地址都是绝对地址且 auth_key 互不相同', () => {
  const p = HLSKit.parsePlaylist(real, REAL_BASE);
  assert.strictEqual(p.segments.length, 78);
  const keys = new Set();
  for (const s of p.segments) {
    assert.ok(/^https?:\/\//.test(s.url), '分片地址必须是绝对地址：' + s.url.slice(0, 60));
    const m = /[?&]auth_key=([^&]+)/.exec(s.url);
    assert.ok(m, '分片地址必须带 auth_key');
    keys.add(m[1]);
  }
  assert.strictEqual(keys.size, 78, '每个分片的 auth_key 都应不同（不能归一化 query）');
});

await test('时长与页面 video:duration=386 对得上，且不是直播', () => {
  const p = HLSKit.parsePlaylist(real, REAL_BASE);
  assert.strictEqual(p.isLive, false);
  assert.ok(p.totalDuration > 380 && p.totalDuration < 395,
    '实测累计 ' + p.totalDuration.toFixed(1) + ' 秒，应与页面声明的 386 秒吻合');
  /* 末片只有 0.901 秒（收尾碎片），其余在 3.9~5.9 秒之间 */
  const durs = p.segments.map((s) => s.duration);
  assert.ok(Math.min(...durs) > 0.5 && Math.max(...durs) < 6.5,
    '分片时长应在 0.5~6.5 秒之间，实际 ' + Math.min(...durs) + '~' + Math.max(...durs));
  assert.ok(durs.slice(0, 77).every((d) => d > 3 && d < 6.5), '前 77 片都应在 3~6.5 秒之间');
});

await test('分片地址不做任何归一化改写（auth_key 逐片不同，改一个就废一个）', () => {
  const p = HLSKit.parsePlaylist(real, REAL_BASE);
  const line = real.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  assert.strictEqual(p.segments[0].url, line[0], '第一个分片地址必须与清单原文一字不差');
  assert.strictEqual(p.segments[77].url, line[77], '最后一个分片地址必须与清单原文一字不差');
});

await test('isTsData / sniffExt 对 TS 分片的判定', () => {
  const ts = new Uint8Array(188 * 2);
  ts[0] = 0x47; ts[188] = 0x47;
  assert.strictEqual(HLSKit.isTsData(ts), true);
  assert.strictEqual(HLSKit.sniffExt(ts), 'ts');
});

/* ---- 构造最小 TS：PAT + PMT + 若干填充包，用来验证编码识别 ---- */
function makeTs(videoStreamType, audioStreamType) {
  const packets = [];
  const mkPsi = (pid, tableBytes) => {
    const section = Buffer.from(tableBytes);
    const pkt = Buffer.alloc(188);
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((pid >> 8) & 0x1f);      /* payload_unit_start_indicator */
    pkt[2] = pid & 0xff;
    pkt[3] = 0x10;                            /* 无 adaptation field，有 payload */
    let q = 4;
    pkt[q++] = 0x00;                          /* pointer_field */
    section.copy(pkt, q);
    q += section.length;
    while (q < 188) pkt[q++] = 0xff;
    packets.push(new Uint8Array(pkt));
  };
  /* PAT：program_number=1 → PMT PID=0x1000 */
  const pat = Buffer.alloc(13);
  pat[0] = 0x00;                              /* table_id */
  pat[1] = 0xb0 | 0; pat[2] = 13;             /* section_syntax + length */
  pat[3] = 0x00; pat[4] = 0x01;               /* transport_stream_id */
  pat[5] = 0xc1;                              /* version + current_next */
  pat[6] = 0x00; pat[7] = 0x00;               /* section_number / last */
  pat[8] = 0x00; pat[9] = 0x01;               /* program_number = 1 */
  pat[10] = 0xe0 | 0x10; pat[11] = 0x00;      /* PMT PID = 0x1000 */
  pat[12] = 0x00;                             /* CRC 占位（解析器不看） */
  mkPsi(0x0000, pat);

  /* PMT：一条视频 + 一条音频 */
  const esList = [];
  esList.push(Buffer.from([videoStreamType, 0xe0 | 0x10, 0x01, 0xf0, 0x00]));   /* video PID 0x1001 */
  if (audioStreamType != null) esList.push(Buffer.from([audioStreamType, 0xe0 | 0x10, 0x02, 0xf0, 0x00]));
  const esBuf = Buffer.concat(esList);
  const pmt = Buffer.alloc(12 + esBuf.length + 4);
  pmt[0] = 0x02;
  pmt[1] = 0xb0; pmt[2] = (12 + esBuf.length) & 0xff;
  pmt[3] = 0x00; pmt[4] = 0x01;
  pmt[5] = 0xc1; pmt[6] = 0x00; pmt[7] = 0x00;
  pmt[8] = 0xe0 | 0x10; pmt[9] = 0x00;        /* PCR PID = 0x1000 */
  pmt[10] = 0xf0; pmt[11] = 0x00;             /* program_info_length = 0 */
  esBuf.copy(pmt, 12);
  mkPsi(0x1000, pmt);

  /* 补几个普通包，模拟分片主体 */
  for (let i = 0; i < 5; i++) {
    const pkt = Buffer.alloc(188);
    pkt[0] = 0x47;
    pkt[1] = (0x1001 >> 8) & 0x1f; pkt[2] = 0x1001 & 0xff;
    pkt[3] = 0x10;
    pkt.fill(0x00, 4);
    packets.push(new Uint8Array(pkt));
  }
  return new Uint8Array(Buffer.concat(packets));
}

console.log('\n[D] TS 视频编码识别（mux.js 只认 H.264）');

await test('真实站点分片识别为 H.264（0x1b）', () => {
  const head = readFileSync(join(__dirname, 'fixtures', 'hls', 'p91-seg0-head.ts'));
  assert.strictEqual(HLSKit.tsVideoStreamType(head), 0x1b);
  assert.ok(HLSKit.TS_TRANSMUXABLE[0x1b], 'H.264 必须可转封装');
});

await test('现有测试 fixture 同样识别为 H.264', () => {
  for (const i of [0, 1, 2]) {
    const buf = readFileSync(join(__dirname, 'fixtures', 'seg' + i + '.ts'));
    assert.strictEqual(HLSKit.tsVideoStreamType(buf), 0x1b, 'seg' + i + '.ts');
  }
});

await test('HEVC(0x24) 被识别出来，且标记为不可转封装', () => {
  const ts = makeTs(0x24, 0x0f);
  assert.strictEqual(HLSKit.tsVideoStreamType(ts), 0x24);
  assert.ok(!HLSKit.TS_TRANSMUXABLE[0x24], 'HEVC 不能交给 mux.js，否则只剩声音');
});

await test('MPEG-2 视频(0x02) 同样标记为不可转封装', () => {
  const ts = makeTs(0x02, 0x04);
  assert.strictEqual(HLSKit.tsVideoStreamType(ts), 0x02);
  assert.ok(!HLSKit.TS_TRANSMUXABLE[0x02]);
});

await test('H.264 + AAC 的组合（最常见形态）', () => {
  const ts = makeTs(0x1b, 0x0f);
  assert.strictEqual(HLSKit.tsVideoStreamType(ts), 0x1b);
  assert.ok(HLSKit.TS_TRANSMUXABLE[0x1b]);
});

await test('纯音频 TS 返回 0（没有视频流）', () => {
  const ts = makeTs(0x0f, null);
  assert.strictEqual(HLSKit.tsVideoStreamType(ts), 0);
});

await test('非 TS 内容 / 太短的内容返回 0，不抛异常', () => {
  assert.strictEqual(HLSKit.tsVideoStreamType(new Uint8Array(10)), 0);
  assert.strictEqual(HLSKit.tsVideoStreamType(new Uint8Array(0)), 0);
  const html = new TextEncoder().encode('<!DOCTYPE html><html><body>403 Forbidden</body></html>');
  assert.strictEqual(HLSKit.tsVideoStreamType(html), 0);
});

await test('PAT 不在第一个包也能找到（分片常常以 PES 开头）', () => {
  const ts = makeTs(0x1b, 0x0f);
  /* 前面垫 10 个普通包，再把 PAT/PMT 放进来 */
  const pad = 188 * 10;
  const shifted = new Uint8Array(pad + ts.length);
  for (let i = 0; i < pad; i += 188) {
    shifted[i] = 0x47;
    shifted[i + 1] = 0x01; shifted[i + 2] = 0x01; shifted[i + 3] = 0x10;
  }
  shifted.set(ts, pad);
  assert.strictEqual(HLSKit.tsVideoStreamType(shifted), 0x1b);
});

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
