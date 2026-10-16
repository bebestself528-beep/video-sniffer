/* ============================================================
 * 内容签名识别单元测试
 * 运行：node test/sniffsig.test.mjs
 *
 * 覆盖「URL 与 Content-Type 都不可靠」时按内容判定类型的场景：
 *   · m3u8 被以 text/plain 返回（不少站点这么干）
 *   · 无后缀的动态流地址
 *   · TS 分片 / fMP4 / MP4 / WebM / FLV 等容器魔数
 *   · 普通 JSON、HTML、纯文本必须判为「不是媒体」，避免列表被噪音污染
 * 真实素材：test/fixtures/seg0.ts（公网真实 TS 分片）、
 *           test/fixtures/dash/*.m4s（从 B站 抓取的真实轨道头部）
 * ============================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* 以 Node 方式加载纯逻辑库 */
const src = readFileSync(join(ROOT, 'lib', 'sniffsig.js'), 'utf8');
const sb = { self: undefined, console };
new Function('self', 'globalThis', src + '\n;return self;')(sb, sb);
const SniffSig = sb.SniffSig || globalThis.SniffSig;
if (!SniffSig) { console.error('✗ 无法加载 lib/sniffsig.js'); process.exit(1); }

let pass = 0, fail = 0;
function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, why) { fail++; console.error('  ✗ ' + name + '\n      ' + why); }
function expectKind(label, buf, want) {
  let r;
  try { r = SniffSig.classify(buf); } catch (e) { bad(label, '抛异常: ' + (e && e.message)); return null; }
  if (!want) {
    if (r && r.ok) bad(label, '应为「非媒体」，实际判为 ' + r.kind);
    else ok(label, '正确判为非媒体');
    return r;
  }
  if (r && r.ok && r.kind === want) {
    ok(label, r.kind + (r.detail ? ' · ' + r.detail : '') + '  [' + r.sig + ']');
  } else {
    bad(label, '期望 ' + want + '，实际 ' + JSON.stringify(r));
  }
  return r;
}
const txt = (s) => new TextEncoder().encode(s);
const bytes = (...arr) => new Uint8Array(arr);

console.log('\n[1] 文本清单：被以 text/plain 返回的 m3u8 / mpd');

expectKind('标准 m3u8（media 清单）', txt([
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXTINF:10.0,',
  'seg0.ts',
  '#EXT-X-ENDLIST'
].join('\n')), 'hls');

expectKind('master m3u8（含清晰度）', txt([
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080',
  '1080p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720',
  '720p/index.m3u8'
].join('\n')), 'hls');

expectKind('带 BOM 的 m3u8', new Uint8Array([0xEF, 0xBB, 0xBF, ...txt('#EXTM3U\n#EXTINF:5,\na.ts')]), 'hls');

expectKind('缺少 #EXTM3U 头但含 HLS 标签', txt('#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nx.ts'), 'hls');

expectKind('DASH MPD', txt('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">\n<Period><AdaptationSet mimeType="video/mp4"/></Period>\n</MPD>'), 'dash');

expectKind('未声明命名空间的 MPD', txt('<?xml version="1.0"?>\n<MPD type="static"><Period><AdaptationSet/></Period></MPD>'), 'dash');

console.log('\n[2] 必须判为「非媒体」，否则列表会被噪音淹没');

expectKind('JSON 接口响应（内含 m3u8 字样）', txt('{"code":0,"data":{"url":"https://cdn.example.com/a/index.m3u8","quality":1080}}'), null);
expectKind('普通 HTML 页面', txt('<!DOCTYPE html><html><head><title>hello</title></head><body>hi</body></html>'), null);
expectKind('纯文本日志', txt('2026-10-15 22:00:00 INFO service started, listening on :8080\n'), null);
expectKind('随机二进制', bytes(0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff), null);

console.log('\n[3] 容器魔数');

/* ftyp + moov（完整文件）→ mp4 */
const ftypMoov = new Uint8Array(64);
ftypMoov.set(txt('ftyp'), 4); ftypMoov.set(txt('isom'), 8); ftypMoov.set(txt('moov'), 32);
expectKind('ftyp + moov → 完整 MP4', ftypMoov, 'mp4');

/* ftyp + moof（无 moov）→ fMP4 分片 */
const ftypMoof = new Uint8Array(64);
ftypMoof.set(txt('styp'), 4); ftypMoof.set(txt('msdh'), 8); ftypMoof.set(txt('moof'), 32);
expectKind('styp + moof（无 moov）→ fMP4 分片', ftypMoof, 'fmp4');

expectKind('WebM/Matroska（EBML）', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f), 'webm');
expectKind('FLV', new Uint8Array([...txt('FLV'), 0x01, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00]), 'flv');
expectKind('Ogg', new Uint8Array([...txt('OggS'), 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 'ogv');
expectKind('AVI（RIFF）', new Uint8Array([...txt('RIFF'), 0x00, 0x00, 0x00, 0x00, ...txt('AVI '), 0x00, 0x00, 0x00, 0x00]), 'avi');

console.log('\n[4] MPEG-TS：靠 0x47 同步字节的固定间隔');

function makeTs(packet) {
  const b = new Uint8Array(packet * 4 + 16);
  for (let i = 0; i < 4; i++) {
    const off = i * packet;
    b[off] = 0x47;
    b[off + 1] = 0x40 | i;      // 假 payload
    b[off + 2] = 0x00;
    b[off + 3] = 0x10;
    for (let k = 4; k < packet && off + k < b.length; k++) b[off + k] = (i * 7 + k) & 0xff;
  }
  return b;
}
expectKind('188 字节包 TS', makeTs(188), 'ts');
expectKind('192 字节包 TS', makeTs(192), 'ts');
expectKind('ID3 前导（HLS 分片常见）', new Uint8Array([...txt('ID3'), 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 'ts');

console.log('\n[5] 真实素材');

const tsFile = join(__dirname, 'fixtures', 'seg0.ts');
if (existsSync(tsFile)) {
  const buf = new Uint8Array(readFileSync(tsFile));
  expectKind('真实 TS 分片（seg0.ts，' + (buf.length / 1024).toFixed(0) + ' KB）', buf, 'ts');
} else {
  console.log('  – 跳过（缺少 test/fixtures/seg0.ts）');
}

const m4sFile = join(__dirname, 'fixtures', 'dash', 'bili_video_30032_head.m4s');
if (existsSync(m4sFile)) {
  const buf = new Uint8Array(readFileSync(m4sFile));
  const r = expectKind('真实 B站 视频轨头部（1 MB）', buf, 'mp4');
  if (r && r.ok) {
    /* 它确实是 fMP4 家族的完整轨道文件：ftyp + moov（所以判 mp4 是对的） */
    const hasMoov = SniffSig._internal.indexOfAscii(buf, 'moov') >= 0;
    if (hasMoov) ok('  其中确实含 moov（完整轨道文件 → mp4 归类正确）');
  }
} else {
  console.log('  – 跳过（缺少 test/fixtures/dash/bili_video_30032_head.m4s）');
}

console.log('\n[6] 边界');

expectKind('空缓冲', new Uint8Array(0), null);
expectKind('仅 4 字节', bytes(1, 2, 3, 4), null);
{
  const r = SniffSig.classify(new Uint8Array(0));
  if (r && r.error) ok('数据过短时返回可读的错误信息：' + r.error);
  else bad('数据过短时未返回错误信息', JSON.stringify(r));
}

console.log('\n========================================');
console.log('内容签名识别：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
