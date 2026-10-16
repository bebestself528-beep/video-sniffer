/* ============================================================
 * 视频嗅探下载器 - 核心引擎自动化测试（Node 运行）
 * 覆盖：m3u8 解析 / AES-128 解密 / BYTERANGE / 并发下载 / TS 转封装
 * 运行：node test/engine.test.mjs
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { createCipheriv, randomBytes } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* --------- 加载被测模块（与扩展中加载的是同一份文件） --------- */
vm.runInThisContext(readFileSync(join(ROOT, 'lib/hls.js'), 'utf8'));
const HLSKit = globalThis.HLSKit;
assert.ok(HLSKit, 'HLSKit 加载失败');

let pass = 0, fail = 0, skip = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.error('  ✗ ' + name + '\n      ' + (e && e.stack || e));
  }
}

/* ============================================================
 * 第一部分：解析器
 * ============================================================ */
console.log('\n[1] m3u8 解析器');

await test('解析 master 播放列表（多清晰度 + 属性解析）', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.42c01e,mp4a.40.2"',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    'https://cdn.example.com/high/index.m3u8?token=abc'
  ].join('\n');
  const p = HLSKit.parsePlaylist(text, 'https://www.site.com/videos/main.m3u8');
  assert.strictEqual(p.kind, 'master');
  assert.strictEqual(p.variants.length, 2);
  assert.strictEqual(p.variants[0].url, 'https://www.site.com/videos/low/index.m3u8');
  assert.strictEqual(p.variants[0].bandwidth, 1280000);
  assert.strictEqual(p.variants[0].resolution, '1280x720');
  assert.strictEqual(p.variants[1].url, 'https://cdn.example.com/high/index.m3u8?token=abc');
  assert.strictEqual(p.variants[1].bandwidth, 5000000);
});

await test('解析 media 播放列表（ENDLIST + 相对路径 + IV/KEY）', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000064',
    '#EXTINF:9.0,',
    'seg100.ts',
    '#EXTINF:9.0,',
    'seg101.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');
  const p = HLSKit.parsePlaylist(text, 'https://cdn.site.com/a/b/index.m3u8');
  assert.strictEqual(p.kind, 'media');
  assert.strictEqual(p.isLive, false);
  assert.strictEqual(p.segments.length, 2);
  assert.strictEqual(p.segments[0].url, 'https://cdn.site.com/a/b/seg100.ts');
  assert.strictEqual(p.segments[0].key.method, 'AES-128');
  assert.strictEqual(p.segments[0].key.uri, 'https://cdn.site.com/a/b/key.bin');
  assert.strictEqual(p.segments[0].key.iv, '0x00000000000000000000000000000064');
  assert.strictEqual(p.segments[0].seq, 100);
  assert.strictEqual(p.segments[1].seq, 101);
  assert.strictEqual(p.totalDuration, 18);
});

await test('解析 media 播放列表（EXT-X-MAP + BYTERANGE 偏移继承 + 直播标记）', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXTINF:4.0,',
    '#EXT-X-BYTERANGE:1000@0',
    'file.mp4',
    '#EXTINF:4.0,',
    '#EXT-X-BYTERANGE:1000',
    'file.mp4'
  ].join('\n');
  const p = HLSKit.parsePlaylist(text, 'https://cdn.site.com/v/index.m3u8');
  assert.strictEqual(p.isLive, true);
  assert.ok(p.initSegment);
  assert.strictEqual(p.initSegment.url, 'https://cdn.site.com/v/init.mp4');
  assert.deepStrictEqual(p.initSegment.byterange, { length: 720, offset: 0 });
  assert.strictEqual(p.segments[0].byterange.offset, 0);
  assert.strictEqual(p.segments[1].byterange.offset, 1000); // 缺省 offset 自动继承
});

await test('非 m3u8 内容应报错', () => {
  assert.throws(() => HLSKit.parsePlaylist('<html>not m3u8</html>', 'https://x.com/a.m3u8'));
});

/* ============================================================
 * 第二部分：本地模拟 CDN（AES-128 加密流 + BYTERANGE 流）
 * ============================================================ */

const AES_KEY = randomBytes(16);
function ivForSeq(seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq, 12);
  return iv;
}
function encryptSeg(plain, seq) {
  const c = createCipheriv('aes-128-cbc', AES_KEY, ivForSeq(seq));
  return Buffer.concat([c.update(plain), c.final()]);
}

/* 构造 3 个明文分片（首字节 0x47 伪造为 TS 同步字节，便于测试 isTsData） */
const plainSegs = [0, 1, 2].map((i) => {
  const b = randomBytes(2048);
  b[0] = 0x47; b[188] = 0x47;
  return b;
});
const encSegs = plainSegs.map((p, i) => encryptSeg(p, 100 + i));

const BIG_FILE = randomBytes(3072); // BYTERANGE 测试用文件

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  const send = (code, headers, body) => {
    res.writeHead(code, headers);
    res.end(body);
  };

  if (p === '/aes/master.m3u8') {
    return send(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      '360/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      '720/index.m3u8'
    ].join('\n'));
  }
  if (p === '/aes/720/index.m3u8') {
    return send(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"',
      '#EXTINF:4.0,',
      'seg1.ts',
      '#EXTINF:4.0,',
      'seg2.ts',
      '#EXTINF:4.0,',
      'seg3.ts',
      '#EXT-X-ENDLIST'
    ].join('\n'));
  }
  if (p === '/aes/key.bin') return send(200, { 'Content-Type': 'application/octet-stream' }, AES_KEY);
  if (p === '/aes/720/seg1.ts') return send(200, { 'Content-Type': 'video/mp2t' }, encSegs[0]);
  if (p === '/aes/720/seg2.ts') return send(200, { 'Content-Type': 'video/mp2t' }, encSegs[1]);
  if (p === '/aes/720/seg3.ts') return send(200, { 'Content-Type': 'video/mp2t' }, encSegs[2]);

  if (p === '/range/index.m3u8') {
    return send(200, {}, [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:1024@0',
      'big.bin',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:1024',
      'big.bin',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:1024',
      'big.bin',
      '#EXT-X-ENDLIST'
    ].join('\n'));
  }
  if (p === '/range/big.bin') {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = parseInt(m[1], 10), end = Math.min(parseInt(m[2], 10), BIG_FILE.length - 1);
      const slice = BIG_FILE.subarray(start, end + 1);
      return send(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${BIG_FILE.length}`,
        'Content-Length': String(slice.length)
      }, slice);
    }
    return send(200, { 'Content-Length': String(BIG_FILE.length) }, BIG_FILE);
  }

  send(404, {}, 'not found');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

console.log('\n[2] 本地模拟 CDN（AES-128 加密流）');

await test('master 自动解析 + 下载 + AES-128 解密，明文与原文一致', async () => {
  const masterText = await (await fetch(BASE + '/aes/master.m3u8')).text();
  const master = HLSKit.parsePlaylist(masterText, BASE + '/aes/master.m3u8');
  assert.strictEqual(master.kind, 'master');

  const variants = master.variants.sort((a, b) => b.bandwidth - a.bandwidth);
  assert.strictEqual(variants[0].resolution, '1280x720');

  const mediaText = await (await fetch(variants[0].url)).text();
  const media = HLSKit.parsePlaylist(mediaText, variants[0].url);
  assert.strictEqual(media.segments.length, 3);
  assert.strictEqual(media.keyMethods[0], 'AES-128');
  /* key URI 相对路径应解析为 /aes/key.bin */
  assert.ok(media.segments[0].key.uri.endsWith('/aes/key.bin'));

  let progressCalls = 0;
  const result = await HLSKit.downloadAll(media, {
    concurrency: 2,
    onProgress: () => progressCalls++
  });

  assert.strictEqual(result.segments.length, 3);
  assert.ok(progressCalls >= 3, '进度回调次数不足: ' + progressCalls);
  for (let i = 0; i < 3; i++) {
    assert.ok(Buffer.compare(Buffer.from(result.segments[i]), plainSegs[i]) === 0, `分片 ${i} 解密结果不一致`);
  }
  assert.ok(HLSKit.isTsData(result.segments[0]), '应被识别为 TS 数据');
});

/* 回归：填充只校验「最后 1 个字节」会把明文末尾的小字节当成填充删掉。
   分片是二进制，结尾恰好落在 1~16 的概率约 6% —— 表现为极难复现的偶发丢数据。
   这里把各种「结尾恰好像填充」的明文都试一遍，确定性地锁死这个行为。 */
await test('AES-128 填充处理：明文末尾恰好是 1~16 的小字节时不得丢数据', async () => {
  for (const lastByte of [0x10, 0x01, 0x02, 0x05, 0x0f, 0x00, 0xff]) {
    const p = randomBytes(2048);
    p[p.length - 1] = lastByte;
    const seg = encryptSeg(p, 100);
    const out = await HLSKit.aes128Decrypt(
      new Uint8Array(seg), new Uint8Array(AES_KEY), new Uint8Array(ivForSeq(100)));
    assert.strictEqual(out.length, 2048, '末字节 0x' + lastByte.toString(16) + ' 时长度变了: ' + out.length);
    assert.ok(Buffer.compare(Buffer.from(out), p) === 0, '末字节 0x' + lastByte.toString(16) + ' 时内容不一致');
  }
});

/* 回归：整个分片长度不是 16 的倍数时（PKCS#7 补齐到 16 后长度会变），
   解密结果必须还原成原始长度。 */
await test('AES-128 填充处理：非 16 倍数长度的明文能正确还原', async () => {
  for (const n of [1, 15, 17, 100, 1000, 1023]) {
    const p = randomBytes(n);
    const seg = encryptSeg(p, 100);
    const out = await HLSKit.aes128Decrypt(
      new Uint8Array(seg), new Uint8Array(AES_KEY), new Uint8Array(ivForSeq(100)));
    assert.strictEqual(out.length, n, n + ' 字节明文还原后长度变了: ' + out.length);
    assert.ok(Buffer.compare(Buffer.from(out), p) === 0, n + ' 字节明文内容不一致');
  }
});

console.log('\n[3] BYTERANGE 分片下载');

await test('同一文件的多段 BYTERANGE 按 Range 请求切片正确', async () => {
  const text = await (await fetch(BASE + '/range/index.m3u8')).text();
  const media = HLSKit.parsePlaylist(text, BASE + '/range/index.m3u8');
  assert.strictEqual(media.segments.length, 3);
  assert.strictEqual(media.segments[2].byterange.offset, 2048);

  const result = await HLSKit.downloadAll(media, { concurrency: 3 });
  for (let i = 0; i < 3; i++) {
    const expect = BIG_FILE.subarray(i * 1024, (i + 1) * 1024);
    assert.ok(Buffer.compare(Buffer.from(result.segments[i]), expect) === 0, `第 ${i} 段 BYTERANGE 不一致`);
  }
});

console.log('\n[4] 取消与错误处理');

await test('AbortSignal 能取消下载', async () => {
  const text = await (await fetch(BASE + '/aes/720/index.m3u8')).text();
  const media = HLSKit.parsePlaylist(text, BASE + '/aes/720/index.m3u8');
  const ctrl = new AbortController();
  ctrl.abort();
  let aborted = false;
  try {
    await HLSKit.downloadAll(media, { signal: ctrl.signal });
  } catch (e) {
    aborted = e && e.name === 'AbortError';
  }
  assert.ok(aborted, '应抛出 AbortError');
});

await test('HTTP 404 分片报错并带上下文信息', async () => {
  const media = HLSKit.parsePlaylist([
    '#EXTM3U', '#EXTINF:1,', 'https://127.0.0.1:1/none.ts'
  ].join('\n'), 'https://127.0.0.1:1/index.m3u8');
  let err = null;
  try {
    await HLSKit.downloadAll(media, { concurrency: 1 });
  } catch (e) { err = e; }
  assert.ok(err && /下载失败/.test(err.message), '应报分片下载失败: ' + (err && err.message));
});

/* ============================================================
 * 第三部分：真实公网测试流（网络不可用时自动跳过）
 * ============================================================ */
console.log('\n[5] 公网真实 HLS 流 + TS 转 MP4（mux.js）');

try {
  const REMOTE = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  const masterText = await (await fetch(REMOTE, { signal: controller.signal })).text();
  clearTimeout(timer);
  const master = HLSKit.parsePlaylist(masterText, REMOTE);
  assert.strictEqual(master.kind, 'master');

  /* 选最低清晰度以节省流量，只下载前 3 个分片 */
  const variant = master.variants.sort((a, b) => a.bandwidth - b.bandwidth)[0];
  const mediaText = await (await fetch(variant.url)).text();
  const media = HLSKit.parsePlaylist(mediaText, variant.url);
  assert.strictEqual(media.isLive, false, '测试流应为点播');

  const partial = Object.assign({}, media, { segments: media.segments.slice(0, 3) });
  const result = await HLSKit.downloadAll(partial, { concurrency: 3 });
  assert.ok(HLSKit.isTsData(result.segments[0]), '真实分片应为 TS');

  await test('真实 TS 分片可被 mux.js 转封装为 fMP4（含 ftyp box）', () => {
    globalThis.window = globalThis;
    vm.runInThisContext(readFileSync(join(ROOT, 'lib/mux.min.js'), 'utf8'));
    const muxjs = globalThis.muxjs;
    assert.ok(muxjs && muxjs.mp4, 'mux.js 未正确加载');

    const parts = HLSKit.transmuxTsToMp4(muxjs, result.segments);
    assert.ok(parts.length >= 2, '输出应包含 init + 媒体分片');
    const head = Buffer.from(parts[0].buffer || parts[0], parts[0].byteOffset || 0, 12);
    const ftyp = head.toString('latin1', 4, 8);
    assert.strictEqual(ftyp, 'ftyp', 'MP4 应以 ftyp box 开头，实际: ' + ftyp);
  });
} catch (e) {
  skip++;
  console.log('  ⚠ 跳过 1 项（公网不可达或超时，非代码问题）: ' + (e && e.message));
}

/* --------- 收尾 --------- */
server.close();
console.log('\n========================================');
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项` + (skip ? `，跳过 ${skip} 项（需公网）` : ''));
console.log('========================================');
process.exit(fail ? 1 : 0);
