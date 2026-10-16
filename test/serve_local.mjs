/* ============================================================
 * 本地手动验证服务器
 * 运行：node test/serve_local.mjs      （可加 --port=8765 指定端口）
 *
 * 作用：把 test/local-test.html 与本地素材分片托管在 http://127.0.0.1:<port>/
 *       让「嗅探 → 下载 → 分片合并 → TS 转 MP4 → 落盘」这条完整链路
 *       在不依赖外网的情况下可被手动复现验证。
 *
 * 素材来自 test/fixtures/（真实公网 TS 分片，已被 e2e 测试缓存）。
 * 若缺失，本脚本会尝试自动下载一次并缓存。
 * ============================================================ */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT || 8765);

/* ---------------- 准备素材 ---------------- */
async function ensureFixtures() {
  mkdirSync(FIXTURES, { recursive: true });
  const segs = [0, 1, 2].map((i) => join(FIXTURES, 'seg' + i + '.ts'));
  const mp4 = join(FIXTURES, 'flower.mp4');

  if (segs.every((f) => existsSync(f))) {
    const total = segs.reduce((s, f) => s + readFileSync(f).length, 0);
    console.log('  ✓ TS 分片素材已就绪（本地缓存，' + (total / 1024).toFixed(0) + ' KB）');
  } else {
    console.log('  分片素材缺失，正在从公网抓取（仅首次，之后使用本地缓存）…');
    const MASTER = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    async function fetchRetry(url, tries, timeoutMs) {
      let last;
      for (let i = 1; i <= tries; i++) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 90000) });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return Buffer.from(await r.arrayBuffer());
        } catch (e) { last = e; if (i < tries) await sleep(2500 * i); }
      }
      throw last;
    }
    try {
      const master = (await fetchRetry(MASTER, 3, 30000)).toString('utf8');
      /* 选最低码率，体积小、下载快 */
      let bestUrl = null, bestBw = Infinity;
      const lines = master.split('\n').map((l) => l.trim());
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const bw = parseInt((/BANDWIDTH=(\d+)/.exec(lines[i]) || [])[1] || '0', 10) || Infinity;
        const next = lines[i + 1];
        if (next && !next.startsWith('#') && bw < bestBw) { bestBw = bw; bestUrl = new URL(next, MASTER).href; }
      }
      if (!bestUrl) throw new Error('master 播放列表中没有清晰度地址');
      const media = (await fetchRetry(bestUrl, 3, 30000)).toString('utf8');
      const urls = [];
      for (const line of media.split('\n')) {
        const l = line.trim();
        if (l && !l.startsWith('#')) urls.push(new URL(l, bestUrl).href);
        if (urls.length >= 3) break;
      }
      if (urls.length < 3) throw new Error('分片数量不足 3');
      for (let i = 0; i < 3; i++) {
        const buf = await fetchRetry(urls[i], 4, 120000);
        writeFileSync(segs[i], buf);
        console.log('  ✓ seg' + i + '.ts 已抓取并缓存 (' + (buf.length / 1024).toFixed(0) + ' KB)');
      }
    } catch (e) {
      console.error('\n  ✗ 分片素材抓取失败：' + (e.message || e));
      console.error('    你当前的网络无法访问 test-streams.mux.dev。');
      console.error('    替代方案：运行 node test/e2e_headless.mjs（它会尝试同样的抓取），');
      console.error('    或把任意 3 个 .ts 分片命名为 seg0.ts / seg1.ts / seg2.ts 放入 test/fixtures/ 后重试。\n');
      process.exit(1);
    }
  }

  if (!existsSync(mp4)) {
    console.log('  MP4 素材缺失，正在抓取…');
    try {
      const buf = Buffer.from(await (await fetch('https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', { signal: AbortSignal.timeout(60000) })).arrayBuffer());
      writeFileSync(mp4, buf);
      console.log('  ✓ flower.mp4 已抓取并缓存 (' + (buf.length / 1024).toFixed(0) + ' KB)');
    } catch (e) {
      console.warn('  ⚠ MP4 素材抓取失败（测试 2/3 将不可用）：' + (e.message || e));
      console.warn('    可自行放一个 mp4 到 test/fixtures/flower.mp4，或直接测试 1（HLS 全链路）。');
    }
  } else {
    console.log('  ✓ MP4 素材已就绪（' + (readFileSync(mp4).length / 1024).toFixed(0) + ' KB）');
  }
}

/* ---------------- 动态生成播放列表（相对路径，便于任意端口访问） ---------------- */
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:10.0,',
  'seg0.ts',
  '#EXTINF:10.0,',
  'seg1.ts',
  '#EXTINF:10.0,',
  'seg2.ts',
  '#EXT-X-ENDLIST'
].join('\n');

/* ---------------- DASH 样本（真实的 B站 视频轨 / 音频轨头部，用于验证音视频自动合并） ---------------- */
const DASH_DIR = join(FIXTURES, 'dash');
const MPD = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT45S" minBufferTime="PT2S"',
  '     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">',
  '  <Period>',
  '    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">',
  '      <Representation id="v1" bandwidth="1200000" codecs="avc1.64001f" width="512" height="384">',
  '        <BaseURL>movie-1-30080.m4s</BaseURL>',
  '      </Representation>',
  '    </AdaptationSet>',
  '    <AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">',
  '      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="44100">',
  '        <BaseURL>movie-1-30280.m4s</BaseURL>',
  '      </Representation>',
  '    </AdaptationSet>',
  '  </Period>',
  '</MPD>'
].join('\n');

/* 读 DASH 样本；缺失时给出明确提示（样本随仓库提供，一般不会走到这里） */
function dashTrack(file) {
  const f = join(DASH_DIR, file);
  if (!existsSync(f)) throw new Error('缺少 DASH 样本 ' + f + '（应随仓库提供，见 test/fixtures/dash/）');
  return { type: 'video/mp4', body: readFileSync(f) };
}

/* ---------------- 场景 5：清单驱动的「分片轨」 ----------------
   真实 DASH 站点不是「一条轨一个文件」，而是「init 段 + N 个分片」，
   清单里列着要下载哪些地址。这里把真实的 B站 轨按 moof 边界切开，
   还原成那种形态（拼接回来与原文件逐字节一致），用来验证：
   清单解析 → 分片下载 → 拼接 → 与音频轨合并。 */
const SPLIT = { video: null, audio: null };
function splitTrack(file, ext) {
  const cacheKey = ext;
  if (SPLIT[cacheKey]) return SPLIT[cacheKey];
  const buf = readFileSync(join(DASH_DIR, file));
  const boxes = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8 || p + size > buf.length) break;   // 尾部截断的半截 box，丢掉
    boxes.push({ type, start: p, size });
    p += size;
  }
  const firstMoof = boxes.findIndex((b) => b.type === 'moof');
  if (firstMoof < 0) throw new Error(file + ' 里找不到 moof，无法切片');
  const init = buf.subarray(0, boxes[firstMoof].start);
  const segments = [];
  for (let i = firstMoof; i < boxes.length; i++) {
    if (boxes[i].type !== 'moof') continue;
    const next = boxes[i + 1];
    if (!next || next.type !== 'mdat') break;
    segments.push(buf.subarray(boxes[i].start, next.start + next.size));
    i++;
  }
  SPLIT[cacheKey] = { init, segments };
  return SPLIT[cacheKey];
}

const SPLIT_MPD = (() => {
  const v = splitTrack('bili_video_30032_head.m4s', 'video');
  const a = splitTrack('bili_audio_30216_head.m4s', 'audio');
  const name = (p, i) => p + '/' + String(i + 1).padStart(5, '0') + '.m4s';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S" minBufferTime="PT2S">',
    '  <Period id="0" duration="PT20S">',
    '    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">',
    '      <Representation id="v30032" bandwidth="1200000" codecs="avc1.64001f" width="1280" height="720">',
    '        <SegmentList>',
    '          <Initialization sourceURL="video/init.mp4"/>',
    ...v.segments.map((s, i) => '          <SegmentURL media="' + name('video', i) + '"/>'),
    '        </SegmentList>',
    '      </Representation>',
    '    </AdaptationSet>',
    '    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="zh">',
    '      <Representation id="a30216" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="44100">',
    '        <SegmentList>',
    '          <Initialization sourceURL="audio/init.mp4"/>',
    ...a.segments.map((s, i) => '          <SegmentURL media="' + name('audio', i) + '"/>'),
    '        </SegmentList>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>'
  ].join('\n');
})();

/* 分片形态的地址（清单里写什么就服务什么） */
function dashSeg(pathname) {
  const m = /^\/dash2\/(video|audio)\/(init\.mp4|\d{5}\.m4s)$/.exec(pathname);
  if (!m) return null;
  const t = splitTrack(m[1] === 'video' ? 'bili_video_30032_head.m4s' : 'bili_audio_30216_head.m4s', m[1]);
  const body = m[2] === 'init.mp4' ? t.init : t.segments[parseInt(m[2], 10) - 1];
  if (!body) return null;
  return { type: 'video/mp4', body };
}

/* ---------------- 静态服务 ---------------- */
const ROUTES = {
  '/': () => ({ type: 'text/html; charset=utf-8', body: readFileSync(join(__dirname, 'local-test.html')) }),
  '/index.html': () => ({ type: 'text/html; charset=utf-8', body: readFileSync(join(__dirname, 'local-test.html')) }),
  '/stream.m3u8': () => ({ type: 'application/vnd.apple.mpegurl', body: Buffer.from(PLAYLIST) }),
  '/seg0.ts': () => ({ type: 'video/mp2t', body: readFileSync(join(FIXTURES, 'seg0.ts')) }),
  '/seg1.ts': () => ({ type: 'video/mp2t', body: readFileSync(join(FIXTURES, 'seg1.ts')) }),
  '/seg2.ts': () => ({ type: 'video/mp2t', body: readFileSync(join(FIXTURES, 'seg2.ts')) }),
  '/flower.mp4': () => ({ type: 'video/mp4', body: readFileSync(join(FIXTURES, 'flower.mp4')) }),
  /* DASH：清单 + 两条独立轨（视频轨无声音、音频轨无画面），用于验证「下载（含声音）」 */
  '/dash/stream.mpd': () => ({ type: 'application/dash+xml', body: Buffer.from(MPD) }),
  '/dash/movie-1-30080.m4s': () => dashTrack('bili_video_30032_head.m4s'),
  '/dash/movie-1-30280.m4s': () => dashTrack('bili_audio_30216_head.m4s'),
  /* DASH 分片形态：init + N 个分片（清单驱动），用于验证新链路 */
  '/dash2/stream.mpd': () => ({ type: 'application/dash+xml', body: Buffer.from(SPLIT_MPD) })
};

const server = createServer((req, res) => {
  let path;
  try { path = new URL(req.url, 'http://127.0.0.1').pathname; } catch (e) { path = '/'; }
  const handler = ROUTES[path] || (() => dashSeg(path));
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — 可访问的路径: ' + Object.keys(ROUTES).join(', ') + ' /dash2/*');
    return;
  }
  try {
    const { type, body } = handler();
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
    if (path !== '/') console.log('    · ' + req.method + ' ' + path + '  → ' + body.length + ' bytes');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 — ' + (e.message || e));
  }
});

/* ---------------- 启动 ---------------- */
(async () => {
  console.log('\n=== 视频嗅探下载器 · 本地手动验证环境 ===\n');
  console.log('[1] 准备素材');
  await ensureFixtures();

  console.log('\n[2] 启动本地服务');
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('  ✗ 端口 ' + PORT + ' 已被占用。换个端口：node test/serve_local.mjs --port=8766');
    } else {
      console.error('  ✗ 服务启动失败：' + (e.message || e));
    }
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + PORT + '/';
    console.log('  ✓ 已启动: ' + url);
    console.log('\n[3] 打开上面的地址（建议用无痕窗口，避免缓存干扰），然后：');
    console.log('    1) 点页面上的「请求 m3u8 + 3 个 TS 分片」按钮');
    console.log('    2) 点浏览器工具栏里的扩展图标（紫色下载图标）');
    console.log('    3) 列表中应出现：stream.m3u8 (HLS) / seg0-2.ts (分片) / flower.mp4 (MP4)');
    console.log('    4) 对 stream.m3u8 点「选择清晰度」→「直接下载」，观察上方任务进度');
    console.log('    5) 完成后到浏览器下载目录查看 .mp4 文件（应可正常播放）');
    console.log('');
    console.log('    另有「测试 4：DASH 音视频分离」——点该按钮后会请求一份 .mpd 与两条独立轨');
  console.log('    与「测试 5：DASH 分片形态」——清单里列着 init 段 + N 个分片，验证新的清单下载链路');
    console.log('    （视频轨 / 音频轨，均为从 B站 抓来的真实样本）。列表中应出现：');
    console.log('      M4S·视频 (movie-1-30080.m4s) → 按钮为「下载（含声音）」');
    console.log('      M4S·音频 (movie-1-30280.m4s) → 提示已被自动合并');
    console.log('    点「下载（含声音）」应只产生 1 个 mp4 文件，且有画面也有声音。');
    console.log('\n  按 Ctrl+C 结束服务。\n');
  });
})();
