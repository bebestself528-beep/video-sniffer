/* ============================================================
 * 媒体角色识别单元测试
 * 运行：node test/mediarole.test.mjs
 *
 * 覆盖「音视频分离」这一类站点里判定「谁是画面、谁是声音」的全部信号：
 *   [1] URL query 显式声明（YouTube &mime=audio%2Fmp4）
 *   [2] YouTube itag 编号
 *   [3] 路径/文件名角色词（抖音 media-video-avc1 / media-audio-und-mp4a）
 *   [4] Content-Type
 *   [5] 误判防护（宁可判不出，也不要把两条画面轨配成一对）
 *   [6] 分片参数归一化（YouTube &range=0-999999 切成 N 条的问题）
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const src = readFileSync(join(ROOT, 'lib', 'mediarole.js'), 'utf8');
const sb = { self: undefined, console };
new Function('self', 'globalThis', src + '\n;return self;')(sb, sb);
const MR = sb.MediaRole || globalThis.MediaRole;
if (!MR) { console.error('✗ 无法加载 lib/mediarole.js'); process.exit(1); }

let pass = 0, fail = 0;
function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, why) { fail++; console.error('  ✗ ' + name + '\n      ' + why); }

function expectRole(label, url, want) {
  let r;
  try { r = MR.roleFromUrl(url); } catch (e) { bad(label, '抛异常: ' + (e && e.message)); return; }
  const shown = r === null ? 'null' : r;
  if (r === want) ok(label, shown);
  else bad(label, '期望 ' + (want === null ? 'null' : want) + '，实际 ' + shown + '\n      ' + url.slice(0, 140));
}

function expectEq(label, got, want) {
  if (got === want) ok(label, got);
  else bad(label, '期望 ' + want + '\n      实际 ' + got);
}

/* ---------------- 真实形态样本 ---------------- */

/* YouTube googlevideo 的真实 URL 形状（参数名与顺序照实，签名字段用占位） */
const YT = (extra) => 'https://rr3---sn-4g5e6nez.googlevideo.com/videoplayback?' +
  'expire=1730000000&ei=AbCdEfGhIj&ip=1.2.3.4&id=o-ABCDEFGHIJKLMNOP&itag=137' +
  '&source=youtube&requiressl=yes&mh=1a&mm=31&mn=sn-4g5e6nez&ms=au&mv=m&mvi=3&pl=23' +
  '&initcwndbps=1000000&vprv=1&mime=video%2Fmp4&ns=abcdefghijk&gir=yes' +
  '&clen=123456789&dur=1847.123&lmt=1700000000000000&mt=1730000000&fvip=3' +
  '&keepalive=yes&fexp=24007246&c=WEB&txp=5532434&n=AbCdEfGhIjKlMn&sparams=expire,ei,ip,id,itag,source,requiressl,vprv,mime,ns,gir,clen,dur,lmt' +
  '&sig=AbCdEfGhIjKlMnOpQrStUvWxYz1234567890&lsparams=mh,mm,mn,ms,mv,mvi,pl,initcwndbps&lsig=AAbCdEfGhIjKlMnOpQrStUvWxYz1234' +
  (extra || '');

console.log('\n[1] URL query 显式声明角色（YouTube 形态）');

expectRole('mime=video%2Fmp4',
  YT('&range=0-999999'), 'video');

expectRole('mime=audio%2Fmp4（itag=140）',
  YT('&range=0-999999').replace('itag=137', 'itag=140').replace('mime=video%2Fmp4', 'mime=audio%2Fmp4'), 'audio');

expectRole('mime=audio%2Fwebm（itag=251，Opus）',
  YT('&range=0-999999').replace('itag=137', 'itag=251').replace('mime=video%2Fmp4', 'mime=audio%2Fwebm'), 'audio');

expectRole('mime=video%2Fwebm（VP9）',
  YT('&range=0-999999').replace('mime=video%2Fmp4', 'mime=video%2Fwebm'), 'video');

expectRole('未编码的 mime=audio/mp4',
  'https://cdn.example.com/get?mime=audio/mp4&id=abc', 'audio');

expectRole('双重编码 mime=audio%252Fmp4',
  'https://cdn.example.com/get?mime=audio%252Fmp4&id=abc', 'audio');

expectRole('通用 type=audio',
  'https://cdn.example.com/stream?id=abc&type=audio', 'audio');

expectRole('通用 format=video',
  'https://cdn.example.com/source?id=abc&format=video', 'video');

expectRole('media_type=audio_only',
  'https://cdn.example.com/source?id=abc&media_type=audio_only', 'audio');

console.log('\n[2] YouTube itag 编号（无 mime 参数时的兜底）');

expectRole('itag=137（1080p 视频轨）',
  'https://rr3---sn-x.googlevideo.com/videoplayback?id=o-1&itag=137&clen=99', 'video');
expectRole('itag=140（128k 音频轨）',
  'https://rr3---sn-x.googlevideo.com/videoplayback?id=o-1&itag=140&clen=99', 'audio');
expectRole('itag=251（Opus 音频轨）',
  'https://rr3---sn-x.googlevideo.com/videoplayback?id=o-1&itag=251&clen=99', 'audio');
expectRole('itag=303（1080p60 VP9）',
  'https://rr3---sn-x.googlevideo.com/videoplayback?id=o-1&itag=303&clen=99', 'video');
expectRole('itag=22（音视频一体，渐进式）',
  'https://rr3---sn-x.googlevideo.com/videoplayback?id=o-1&itag=22&clen=99', 'muxed');

console.log('\n[3] 路径 / 文件名角色词（抖音形态）');

expectRole('抖音视频轨（无后缀、目录形态）',
  'https://v26-web.douyinvod.com/abc123/video/tos/cn/tos-cn-ve-15/oQv001/media-video-avc1/?a=6383&ch=26&cr=3', 'video');
expectRole('抖音音频轨（无后缀、目录形态）',
  'https://v26-web.douyinvod.com/xyz789/video/tos/cn/tos-cn-ve-15/oQa002/media-audio-und-mp4a/?a=6383&ch=26&cr=3', 'audio');

expectRole('HLS 分离音频 playlist（audio-only）',
  'https://cdn.example.com/hls/stream_audio_only/index.m3u8', 'audio');
expectRole('HLS 分离视频 playlist（video-only）',
  'https://cdn.example.com/hls/stream_video_only/index.m3u8', 'video');
expectRole('音频分片目录 /audio/seg1.m4s',
  'https://cdn.example.com/dash/audio/seg1.m4s', 'audio');
expectRole('视频分片目录 /video/seg1.m4s',
  'https://cdn.example.com/dash/video/seg1.m4s', 'video');
expectRole('编码名出现在文件名里（hvc1）',
  'https://cdn.example.com/dash/1080p-hvc1-30080.m4s', 'video');
expectRole('编码名出现在文件名里（mp4a / opus）',
  'https://cdn.example.com/dash/audio-opus-30280.webm', 'audio');

console.log('\n[4] Content-Type');

expectEq('audio/mp4 → audio', MR.roleFromCt('audio/mp4'), 'audio');
expectEq('audio/webm; codecs="opus" → audio', MR.roleFromCt('audio/webm; codecs="opus"'), 'audio');
expectEq('video/mp4 → video', MR.roleFromCt('video/mp4'), 'video');
expectEq('application/octet-stream → null（不可信）', MR.roleFromCt('application/octet-stream'), null);
expectEq('text/plain → null（不可信）', MR.roleFromCt('text/plain'), null);
expectEq('空 CT → null', MR.roleFromCt(''), null);

expectEq('URL 明示 audio 时压过 video/mp4 的 CT（抖音形态）',
  MR.roleOf('https://v26-web.douyinvod.com/x/media-audio-und-mp4a/?a=1', 'video/mp4'), 'audio');

console.log('\n[5] 误判防护（关键：判不出要返回 null，不能瞎猜）');

expectRole('路径词同时含 audio 与 video → null',
  'https://cdn.example.com/x/media-audio-video-together/seg.m4s', null);
expectRole('provider 里的 vid 不算 video 词',
  'https://www.bilibili.com/provider/xxx/stream', null);
expectRole('audience 里的 aud 不算 audio 词',
  'https://cdn.example.com/audience/channel/list', null);
expectRole('页面地址 /video/BVxxx 不做路径判定',
  'https://www.bilibili.com/video/BV1xx411c7mD', null);
expectRole('页面地址 .html 不做路径判定',
  'https://example.com/audio/player.html', null);
expectRole('mime=video/mp4 里的 mp4 不会反过来判成 audio',
  'https://cdn.example.com/x?mime=video%2Fmp4', 'video');
expectRole('sparams 里的裸词 mime 不参与判定',
  'https://cdn.example.com/videoplayback?sparams=expire,mime,ns&itag=137', 'video');
expectRole('完全无信号 → null（交由文件头探测）',
  'https://v26-web.douyinvod.com/aBcD/xYzW/?a=6383&ch=26', null);
expectRole('空串 → null', '', null);
expectRole('非字符串 → null', null, null);
expectRole('超长 URL → null', 'https://x.com/' + 'a'.repeat(5000), null);

console.log('\n[6] 分片参数归一化（YouTube range 分片）');

const ytBase = YT('');
const ytS0 = YT('&range=0-999999');
const ytS1 = YT('&range=1000000-1999999&rn=1&rbuf=123456');
const ytS2 = YT('&range=2000000-2999999&rn=2&rbuf=234567');

expectEq('带 range 的 URL 去掉 range 后等于基础 URL',
  MR.stripSliceParams(ytS0), ytBase);
expectEq('第 2 片（含 rn/rbuf）归一后也等于基础 URL',
  MR.stripSliceParams(ytS1), ytBase);
expectEq('第 3 片归一后也等于基础 URL',
  MR.stripSliceParams(ytS2), ytBase);
expectEq('三条分片的去重键相同',
  new Set([MR.dedupKeyOf(ytS0), MR.dedupKeyOf(ytS1), MR.dedupKeyOf(ytS2)]).size, 1);

expectEq('没有分片参数时原样返回（不破坏编码）',
  MR.stripSliceParams(ytBase), ytBase);
expectEq('保持原有参数顺序与编码（不重排、不重编码）',
  MR.stripSliceParams('https://x.com/a?z=1&range=0-9&a=%2F%2B&b=2'),
  'https://x.com/a?z=1&a=%2F%2B&b=2');
expectEq('#hash 不被丢掉',
  MR.stripSliceParams('https://x.com/a?range=0-9&b=2#frag'), 'https://x.com/a?b=2#frag');
expectEq('无 query 的 URL 原样返回',
  MR.stripSliceParams('https://x.com/a/b.m4s'), 'https://x.com/a/b.m4s');
expectEq('读出 range 值',
  MR.sliceOf(ytS1), '1000000-1999999');
expectEq('不同 itag 不会被归一成同一条',
  MR.dedupKeyOf(YT('&range=0-99')) === MR.dedupKeyOf(YT('&range=0-99').replace('itag=137', 'itag=140')), false);

console.log('\n[7] 综合：同一条轨的多个分片必须收敛成一条');

const trackUrls = [ytS0, ytS1, ytS2];
const uniqueTracks = new Set(trackUrls.map((u) => MR.dedupKeyOf(u)));
expectEq('3 个分片 → 1 条逻辑轨', uniqueTracks.size, 1);
expectEq('该逻辑轨角色判为 video', MR.roleFromUrl([...uniqueTracks][0]), 'video');

console.log('\n——————————————————————————————');
console.log(`结果：${pass}/${pass + fail} 通过` + (fail ? `，${fail} 项失败` : ''));
if (fail) process.exit(1);
