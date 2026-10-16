/* ============================================================
 * DASH(.mpd) 清单解析单元测试
 * 运行：node test/mpd.test.mjs
 *
 * 覆盖「音视频分离」的第三种形态（前两种：fMP4 .m4s、无后缀抖音式分离轨）：
 *   [1] XML 扫描器（属性引号、CDATA、自闭合、注释）
 *   [2] 角色判定（AdaptationSet 的 contentType / mimeType 直接给出，不猜路径）
 *   [3] URL 模板填充（$RepresentationID$ / $Number%05d$ / $Time$ / $$ 转义）
 *   [4] 分片枚举四种形态：
 *         BaseURL 单文件 / SegmentList / SegmentTemplate+SegmentTimeline
 *         / SegmentTemplate+duration/timescale 推算
 *   [5] BaseURL 继承链（MPD > Period > AdaptationSet > Representation）
 *   [6] ISO 8601 时长解析
 *   [7] 多 Period、live 判定、错误路径
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const src = readFileSync(join(ROOT, 'lib', 'mpd.js'), 'utf8');
const sb = { self: undefined, console };
new Function('self', 'globalThis', src + '\n;return self;')(sb, sb);
const M = sb.MpdKit || globalThis.MpdKit;
if (!M) { console.error('✗ 无法加载 lib/mpd.js'); process.exit(1); }

let pass = 0, fail = 0;
function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, why) { fail++; console.error('  ✗ ' + name + '\n      ' + why); }
function eq(label, got, want) {
  if (got === want) ok(label, JSON.stringify(got));
  else bad(label, '期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got));
}
function truthy(label, got) {
  if (got) ok(label, typeof got === 'string' ? got.slice(0, 90) : JSON.stringify(got));
  else bad(label, '期望真值，实际 ' + JSON.stringify(got));
}

/* ============================================================
 * [1] XML 扫描器
 * ============================================================ */
console.log('\n[1] XML 扫描器');
{
  const doc = M.parseXml(`<?xml version="1.0" encoding="utf-8"?>
<!-- 注释里有 <fakeTag attr="x"> 不该被解析 -->
<Root a="1" b='2'>
  <Child>text&amp;more</Child>
  <Empty/>
  <Data><![CDATA[<not-a-tag>]]></Data>
</Root>`);
  const root = doc.children.find((e) => e.tag === 'Root');
  truthy('根元素解析', root);
  eq('双引号属性', root.attrs.a, '1');
  eq('单引号属性', root.attrs.b, '2');
  eq('注释被跳过（子元素数量）', root.children.filter((c) => c.tag === 'fakeTag').length, 0);
  const child = root.children.find((c) => c.tag === 'Child');
  eq('文本节点', child.text.trim(), 'text&amp;more');
  eq('自闭合元素无子节点', root.children.find((c) => c.tag === 'Empty').children.length, 0);
  const data = root.children.find((c) => c.tag === 'Data');
  eq('CDATA 内容不被当作标签', data.text.trim(), '<not-a-tag>');

  /* 属性值里含 > 的坑：不能提前闭标签 */
  const d2 = M.parseXml('<R><E a="x>y" b="z"/></R>');
  const e = M.parseXml('<R><E a="x>y"/></R>').children[0].children[0];
  eq('属性值里的 > 不破坏解析', e.attrs.a, 'x>y');
  eq('属性值里的引号转义', M.parseAttrs(`a="1" b='2' c="&quot;3&quot;"`).c, '&quot;3&quot;');
}

/* ============================================================
 * [2] ISO 8601 时长
 * ============================================================ */
console.log('\n[2] ISO 8601 时长解析');
{
  eq('PT1H2M3S', M.parseDuration('PT1H2M3S'), 3723);
  eq('PT30S', M.parseDuration('PT30S'), 30);
  eq('PT1M30.5S', M.parseDuration('PT1M30.5S'), 90.5);
  eq('PT2H', M.parseDuration('PT2H'), 7200);
  eq('P1DT12H', M.parseDuration('P1DT12H'), 129600);
  eq('空串 → 0', M.parseDuration(''), 0);
  eq('非法串 → 0', M.parseDuration('hello'), 0);
  eq('undefined → 0', M.parseDuration(undefined), 0);
}

/* ============================================================
 * [3] URL 模板填充
 * ============================================================ */
console.log('\n[3] URL 模板填充');
{
  eq('$RepresentationID$', M.fillTemplate('media/$RepresentationID$/init.mp4', { RepresentationID: 'v0' }), 'media/v0/init.mp4');
  eq('$Number$', M.fillTemplate('seg-$Number$.m4s', { Number: 7 }), 'seg-7.m4s');
  eq('$Number%05d$', M.fillTemplate('seg-$Number%05d$.m4s', { Number: 7 }), 'seg-00007.m4s');
  eq('$Number%03d$ 已够宽不变', M.fillTemplate('seg-$Number%03d$.m4s', { Number: 1234 }), 'seg-1234.m4s');
  eq('$Time$', M.fillTemplate('t-$Time$.m4s', { Time: 90000 }), 't-90000.m4s');
  eq('$Bandwidth$', M.fillTemplate('b-$Bandwidth$.mp4', { Bandwidth: 5000000 }), 'b-5000000.mp4');
  eq('$$ 转义为字面 $', M.fillTemplate('a$$b', {}), 'a$b');
  eq('未知变量替换成空串', M.fillTemplate('x/$Unknown$/y', {}), 'x//y');
  eq('多个变量混用', M.fillTemplate('$RepresentationID$/$Number%04d$', { RepresentationID: 'a', Number: 3 }), 'a/0003');
  eq('空模板', M.fillTemplate('', { Number: 1 }), '');
}

/* ============================================================
 * [4] 真实形态清单：SegmentTemplate + SegmentTimeline
 * ============================================================ */
console.log('\n[4] SegmentTemplate + SegmentTimeline（合成分片，时长不可整除）');
{
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="PT30.5S" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <BaseURL>https://cdn.example.com/vod/abc/</BaseURL>
  <Period id="0" start="PT0S" duration="PT30.5S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true" frameRate="30">
      <SegmentTemplate timescale="1000" media="v/$RepresentationID$/seg-$Number%04d$.m4s"
                       initialization="v/$RepresentationID$/init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="4000" r="6"/>
          <S d="2500"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v1080" bandwidth="5000000" codecs="avc1.640028" width="1920" height="1080"/>
      <Representation id="v720" bandwidth="2500000" codecs="avc1.4d401f" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en">
      <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      <SegmentTemplate timescale="48000" media="a/$RepresentationID$/seg-$Number$.m4s"
                       initialization="a/$RepresentationID$/init.mp4" startNumber="1">
        <SegmentTimeline>
          <S t="0" d="192000" r="6"/>
          <S d="120000"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = M.parseMpd(xml, 'https://cdn.example.com/vod/abc/manifest.mpd');
  eq('时长', r.duration, 30.5);
  eq('非 live', r.isLive, false);
  eq('Representation 数量', r.representations.length, 3);

  const v1080 = r.representations.find((x) => x.id === 'v1080');
  eq('画面角色', v1080.role, 'video');
  eq('分辨率', v1080.width + '×' + v1080.height, '1920×1080');
  eq('码率', v1080.bandwidth, 5000000);
  eq('初始化段 URL（相对 BaseURL 解析）', v1080.initUrl, 'https://cdn.example.com/vod/abc/v/v1080/init.mp4');
  eq('分片数量（r=6 是 7 段，再加 1 段）', v1080.segmentUrls.length, 8);
  eq('第一段', v1080.segmentUrls[0], 'https://cdn.example.com/vod/abc/v/v1080/seg-0001.m4s');
  eq('第七段（补零仍为 4 位）', v1080.segmentUrls[6], 'https://cdn.example.com/vod/abc/v/v1080/seg-0007.m4s');
  eq('第八段（编号继续）', v1080.segmentUrls[7], 'https://cdn.example.com/vod/abc/v/v1080/seg-0008.m4s');

  const v720 = r.representations.find((x) => x.id === 'v720');
  eq('720p 走同一模板但不同 RepresentationID', v720.segmentUrls[0], 'https://cdn.example.com/vod/abc/v/v720/seg-0001.m4s');
  eq('720p 分辨率', v720.height, 720);

  const a = r.representations.find((x) => x.role === 'audio');
  truthy('音频角色被正确识别', a);
  eq('音频 id', a.id, 'a128');
  eq('声道数（AudioChannelConfiguration）', a.channels, 2);
  eq('采样率', a.sampleRate, 48000);
  eq('语言', a.lang, 'en');
  eq('音频 init', a.initUrl, 'https://cdn.example.com/vod/abc/a/a128/init.mp4');
  eq('音频分片数', a.segmentUrls.length, 8);
  eq('音频首片', a.segmentUrls[0], 'https://cdn.example.com/vod/abc/a/a128/seg-1.m4s');

  /* 时间线：r=6 表示「再重复 6 次」，所以是 7 段；f 后跟 1 段，共 8 段 */
  const tlXml = '<SegmentTimeline><S t="0" d="4000" r="6"/><S d="2500"/></SegmentTimeline>';
  const starts = M.timelineStarts(M.parseXml(tlXml).children[0]);
  eq('时间线展开段数（r 是重复次数）', starts.length, 8);
  eq('第 8 段起点 = 7×4000', starts[7], 28000);
  eq('第 1 段起点', starts[0], 0);
}

/* ============================================================
 * [5] SegmentTemplate + duration/timescale 推算（无 SegmentTimeline）
 * ============================================================ */
console.log('\n[5] SegmentTemplate + duration/timescale 推算');
{
  const xml = `<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v" bandwidth="800000" width="640" height="360">
        <SegmentTemplate timescale="1000" duration="2000" startNumber="1"
          initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = M.parseMpd(xml, 'https://x.test/dir/man.mpd');
  const v = r.representations[0];
  eq('推算分片数（10s / 2s）', v.segmentUrls.length, 5);
  eq('首片', v.segmentUrls[0], 'https://x.test/dir/v/1.m4s');
  eq('末片', v.segmentUrls[4], 'https://x.test/dir/v/5.m4s');
  eq('init', v.initUrl, 'https://x.test/dir/v/init.mp4');
  eq('时长', r.duration, 10);

  /* 非整除：10s / 3s → 4 段（末段不足） */
  const xml2 = xml.replace('duration="2000"', 'duration="3000"');
  eq('非整除向上取整', M.parseMpd(xml2, 'https://x.test/dir/man.mpd').representations[0].segmentUrls.length, 4);

  /* startNumber 偏移 */
  const xml3 = xml.replace('startNumber="1"', 'startNumber="101"');
  eq('startNumber 偏移', M.parseMpd(xml3, 'https://x.test/dir/man.mpd').representations[0].segmentUrls[0], 'https://x.test/dir/v/101.m4s');

  /* 用 Period 的 duration 而不是 MPD 的 */
  const xml4 = `<MPD type="static" mediaPresentationDuration="PT60S">
  <Period duration="PT6S">
    <AdaptationSet contentType="video">
      <Representation id="v">
        <SegmentTemplate timescale="1" duration="2" media="$Number$.m4s"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  eq('优先用 Period 时长', M.parseMpd(xml4, 'https://x.test/a.mpd').representations[0].segmentUrls.length, 3);
}

/* ============================================================
 * [6] SegmentList
 * ============================================================ */
console.log('\n[6] SegmentList（分片地址逐个列出）');
{
  const xml = `<MPD type="static" mediaPresentationDuration="PT6S">
  <Period>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a" bandwidth="96000" audioSamplingRate="44100">
        <SegmentList timescale="44100" duration="141120">
          <Initialization sourceURL="audio/init.mp4"/>
          <SegmentURL media="audio/s1.m4s"/>
          <SegmentURL media="audio/s2.m4s"/>
          <SegmentURL media="audio/s3.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = M.parseMpd(xml, 'https://s.test/live/man.mpd');
  const a = r.representations[0];
  eq('角色', a.role, 'audio');
  eq('init 来自 Initialization', a.initUrl, 'https://s.test/live/audio/init.mp4');
  eq('分片数量', a.segmentUrls.length, 3);
  eq('首片', a.segmentUrls[0], 'https://s.test/live/audio/s1.m4s');
  eq('末片', a.segmentUrls[2], 'https://s.test/live/audio/s3.m4s');

  /* Initialization 里有模板变量也要填 */
  const xml2 = xml.replace('sourceURL="audio/init.mp4"', 'sourceURL="$RepresentationID$/init.mp4"');
  eq('Initialization 走模板填充', M.parseMpd(xml2, 'https://s.test/live/man.mpd').representations[0].initUrl, 'https://s.test/live/a/init.mp4');
}

/* ============================================================
 * [7] 单文件 BaseURL（整轨就是一个文件）
 * ============================================================ */
console.log('\n[7] 单文件 BaseURL');
{
  const xml = `<MPD type="static" mediaPresentationDuration="PT120S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" bandwidth="3000000" width="1280" height="720" codecs="avc1.4d401f">
        <BaseURL>video_720.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" audioSamplingRate="48000" codecs="mp4a.40.2">
        <BaseURL>audio_128.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = M.parseMpd(xml, 'https://f.test/stream/man.mpd');
  eq('两条轨', r.representations.length, 2);
  const v = r.representations.find((x) => x.role === 'video');
  const a = r.representations.find((x) => x.role === 'audio');
  eq('画面单文件标记', v.single, true);
  eq('画面地址', v.segmentUrls[0], 'https://f.test/stream/video_720.mp4');
  eq('画面无独立 init', v.initUrl, '');
  eq('音频地址', a.segmentUrls[0], 'https://f.test/stream/audio_128.mp4');

  /* 无后缀的单文件（有些站点用相对路径 + BaseURL 目录） */
  const xml2 = `<MPD type="static" mediaPresentationDuration="PT60S">
  <BaseURL>https://g.test/v/</BaseURL>
  <Period>
    <AdaptationSet contentType="video"><Representation id="x"><BaseURL>track-v</BaseURL></Representation></AdaptationSet>
    <AdaptationSet contentType="audio"><Representation id="y"><BaseURL>track-a</BaseURL></Representation></AdaptationSet>
  </Period>
</MPD>`;
  const r2 = M.parseMpd(xml2, 'https://g.test/v/man.mpd');
  eq('MPD 级 BaseURL + 无后缀子路径', r2.representations[0].segmentUrls[0], 'https://g.test/v/track-v');
  eq('同一清单音频轨', r2.representations[1].segmentUrls[0], 'https://g.test/v/track-a');
}

/* ============================================================
 * [8] 角色判定：contentType 缺省时靠 mimeType / 音频属性推断
 * ============================================================ */
console.log('\n[8] 角色判定的兜底路径');
{
  /* 只有 mimeType，没有 contentType */
  const xml = `<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet mimeType="video/mp4"><Representation id="v" width="640" height="360"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>
    <AdaptationSet mimeType="audio/mp4"><Representation id="a"><BaseURL>a.mp4</BaseURL></Representation></AdaptationSet>
  </Period>
</MPD>`;
  const r = M.parseMpd(xml, 'https://h.test/m.mpd');
  eq('靠 mimeType 判画面', r.representations[0].role, 'video');
  eq('靠 mimeType 判音频', r.representations[1].role, 'audio');

  /* AdaptationSet 什么都没写，靠 AudioChannelConfiguration 推 */
  const xml2 = `<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet>
      <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      <Representation id="a"><BaseURL>a.mp4</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet><Representation id="v"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>
  </Period>
</MPD>`;
  const r2 = M.parseMpd(xml2, 'https://h.test/m2.mpd');
  eq('靠 AudioChannelConfiguration 判音频', r2.representations[0].role, 'audio');
  eq('另一组默认为画面', r2.representations[1].role, 'video');

  /* Representation 级覆盖 AdaptationSet 级 */
  const xml3 = `<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v1" mimeType="video/mp4"><BaseURL>v1.mp4</BaseURL></Representation>
      <Representation id="a1" mimeType="audio/mp4"><BaseURL>a1.mp4</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r3 = M.parseMpd(xml3, 'https://h.test/m3.mpd');
  eq('同组内混合时按 Representation 的 mimeType 分角色', r3.representations[1].role, 'audio');
  eq('同组内画面仍为画面', r3.representations[0].role, 'video');
}

/* ============================================================
 * [9] 多 Period / live / 错误路径
 * ============================================================ */
console.log('\n[9] 多 Period、live、错误路径');
{
  const xml = `<MPD type="dynamic" availabilityStartTime="2024-01-01T00:00:00Z" minimumUpdatePeriod="PT5S" timeShiftBufferDepth="PT1M">
  <Period id="p0" start="PT0S">
    <AdaptationSet contentType="video"><Representation id="v"><BaseURL>v0.mp4</BaseURL></Representation></AdaptationSet>
    <AdaptationSet contentType="audio"><Representation id="a"><BaseURL>a0.mp4</BaseURL></Representation></AdaptationSet>
  </Period>
  <Period id="p1" start="PT60S">
    <AdaptationSet contentType="video"><Representation id="v"><BaseURL>v1.mp4</BaseURL></Representation></AdaptationSet>
    <AdaptationSet contentType="audio"><Representation id="a"><BaseURL>a1.mp4</BaseURL></Representation></AdaptationSet>
  </Period>
</MPD>`;
  const r = M.parseMpd(xml, 'https://l.test/live/man.mpd');
  eq('live 判定', r.isLive, true);
  eq('两个 Period 的轨全部列出', r.representations.length, 4);
  eq('第二 Period 画面地址', r.representations[2].segmentUrls[0], 'https://l.test/live/v1.mp4');
  eq('第二 Period 音频地址', r.representations[3].segmentUrls[0], 'https://l.test/live/a1.mp4');

  /* 没有 Period 元素（极简清单） */
  const xml2 = `<MPD type="static" mediaPresentationDuration="PT10S">
  <AdaptationSet contentType="video"><Representation id="v"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>
</MPD>`;
  const r2 = M.parseMpd(xml2, 'https://m.test/a.mpd');
  eq('无 Period 时按隐式 Period 处理', r2.representations.length, 1);

  /* 带命名空间前缀 / xml:base */
  const xml3 = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v">
        <SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4" duration="5" timescale="1" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r3 = M.parseMpd(xml3, 'https://n.test/dir/x.mpd');
  eq('无 BaseURL 时相对清单地址解析', r3.representations[0].segmentUrls[0], 'https://n.test/dir/seg-1.m4s');

  /* 错误路径 */
  const errs = [];
  try { M.parseMpd('', 'x'); } catch (e) { errs.push(e.message); }
  try { M.parseMpd('<html><body>404</body></html>', 'x'); } catch (e) { errs.push(e.message); }
  try { M.parseMpd(null, 'x'); } catch (e) { errs.push(e.message); }
  eq('三种非法输入都抛错', errs.length, 3);
  truthy('空内容错误信息', errs[0]);
  truthy('非 MPD 错误信息', errs[1]);

  /* 损坏的 XML 不该崩（尽力而为） */
  const broken = M.parseMpd('<MPD type="static"><Period><AdaptationSet contentType="video"><Representation id="v"><BaseURL>v.mp4', 'https://b.test/a.mpd');
  eq('未闭合的 XML 仍能抽出已有信息', broken.representations.length, 1);

  /* 空 Representation / 无分片信息 */
  const incomplete = M.parseMpd('<MPD type="static"><Period><AdaptationSet contentType="video"><Representation id="v"/></AdaptationSet></Period></MPD>', 'https://q.test/a.mpd');
  eq('无任何地址时有条目但分片为空', incomplete.representations[0].segmentUrls.length, 0);
  truthy('并且给出说明', incomplete.representations[0].note);
}

/* ============================================================
 * [10] describe 摘要
 * ============================================================ */
console.log('\n[10] describe 摘要');
{
  const d1 = M.describe({ role: 'video', width: 1920, height: 1080, codecs: 'avc1.640028', bandwidth: 5000000 });
  truthy('画面摘要含分辨率/编码/码率', /1920×1080/.test(d1) && /avc1/.test(d1) && /Mbps/.test(d1));
  const d2 = M.describe({ role: 'audio', channels: 2, sampleRate: 48000, codecs: 'mp4a.40.2', bandwidth: 128000 });
  truthy('音频摘要含声道/采样率', /2ch/.test(d2) && /48000Hz/.test(d2));
  eq('空对象不炸', M.describe({}), '');
}

/* ============================================================
 * [11] 与角色识别模块的协同：MPD 里的地址应能被 MediaRole 判出角色
 * ============================================================ */
console.log('\n[11] 与 MediaRole 协同');
{
  const mrSrc = readFileSync(join(ROOT, 'lib', 'mediarole.js'), 'utf8');
  const sb2 = { self: undefined, console };
  new Function('self', 'globalThis', mrSrc + '\n;return self;')(sb2, sb2);
  const MR = sb2.MediaRole || globalThis.MediaRole;

  const xml = `<MPD type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v0" bandwidth="3000000" width="1280" height="720">
        <SegmentTemplate media="v/$RepresentationID$/$Number$.m4s" initialization="v/$RepresentationID$/init.mp4" duration="2" timescale="1" startNumber="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a0" bandwidth="128000" audioSamplingRate="48000">
        <SegmentTemplate media="a/$RepresentationID$/$Number$.m4s" initialization="a/$RepresentationID$/init.mp4" duration="2" timescale="1" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = M.parseMpd(xml, 'https://c.test/d/man.mpd');
  const v = r.representations[0], a = r.representations[1];
  /* MPD 给出的角色 + URL 里的路径词应当一致（双保险，不互相打架） */
  eq('画面轨：MPD 角色与 URL 判定一致', MR.roleOf(v.segmentUrls[0], 'video/mp4'), v.role);
  eq('音频轨：MPD 角色与 URL 判定一致', MR.roleOf(a.segmentUrls[0], 'audio/mp4'), a.role);
  /* 清单地址本身不应被误判成音频（init.mp4 无角色词） */
  eq('init 地址无角色词时不误判', MR.roleOf(v.initUrl, 'video/mp4'), 'video');
}

/* ============================================================ */
console.log('\n' + '='.repeat(60));
console.log(`MPD 清单解析测试：${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
