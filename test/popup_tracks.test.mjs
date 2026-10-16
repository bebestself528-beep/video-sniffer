/* ============================================================
 * popup 轨道识别 / 音视频配对 回归测试
 * 运行：node test/popup_tracks.test.mjs
 *
 * 背景：曾出现「两条轨配不上对」的 bug —— 分组键在取文件名末尾数字时
 *       没用先摘掉扩展名，.m4s 里的 "4" 被当成末段数字，
 *       于是 xxx-30080.m4s 与 xxx-30280.m4s 落到两个不同的组，
 *       UI 上表现为「未发现配套音频轨」、按钮退化成普通「下载」。
 *
 * 本测试直接加载扩展里的 popup 页面（演示模式，离线、不联网），
 * 校验：分组键 / 质量标签 / 界面标签 / 「下载（含声音）」按钮 / 提示文案。
 * ============================================================ */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = Number(process.env.TRACKS_TEST_PORT || 9997);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.error('  ✗ ' + n + '\n      ' + (e && (e.stack || e.message) || e)); };
const eq = (a, b, n) => { if (a === b) ok(n + ' = ' + JSON.stringify(a)); else bad(n + '：期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); };

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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('CDP 超时 ' + method)); } }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
async function ev(cdp, sid, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}
const j = async (cdp, sid, expr) => JSON.parse(await ev(cdp, sid, 'JSON.stringify(' + expr + ')'));

let chrome = null, cdp = null;

async function main() {
  if (!existsSync(CHROME)) throw new Error('找不到 Chrome: ' + CHROME + '（可设 CHROME_PATH）');
  if (!existsSync(join(ROOT, 'popup', 'popup.js'))) throw new Error('缺少 popup/popup.js');

  const tmp = mkdtempSync(join(tmpdir(), 'vsniffer-tracks-'));
  const prof = join(tmp, 'prof');
  mkdirSync(prof, { recursive: true });

  try {
    console.log('\n[0] 静态检查：popup 不得再用「先取数字再摘扩展名」的旧写法');
    const src = readFileSync(join(ROOT, 'popup', 'popup.js'), 'utf8');
    if (/\(\?<ext>\)|\(\d\+\)\(\[\^\\d\]\*\)\$/.test(src)) bad('仍存在旧的正则写法'); else ok('已改用 splitExt() 先摘扩展名');

    console.log('\n[1] 启动无头浏览器并加载扩展');
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + prof,
      '--enable-unsafe-extension-debugging', '--load-extension=' + ROOT, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    let ws = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try { ws = (await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')).json()).webSocketDebuggerUrl; break; } catch (e) { /* retry */ }
    }
    if (!ws) throw new Error('浏览器未就绪');
    cdp = new CDP(ws); await cdp.connect();

    const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    const extId = loaded.id;
    await sleep(1200);
    ok('扩展已加载（ID: ' + extId + '）');

    console.log('\n[2] 打开 popup 页面（DASH 场景演示数据）');
    const url = 'chrome-extension://' + extId + '/popup/popup.html?state=demo&scene=dash&tab=all';
    const t = (await cdp.send('Target.createTarget', { url })).targetId;
    const sid = (await cdp.send('Target.attachToTarget', { targetId: t, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sid);

    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { if (await ev(cdp, sid, '!!window.__POP_READY')) { ready = true; break; } } catch (e) { /* retry */ }
    }
    if (!ready) throw new Error('popup 页面未就绪（__POP_READY 未置位）');
    ok('popup 页面渲染完成');

    console.log('\n[3] 分组键 / 质量标签（真实 B站 文件名形态）');
    const V1 = 'https://vod.example.com/dash/movie-1-30080.m4s';
    const A1 = 'https://vod.example.com/dash/movie-1-30280.m4s';
    const kv = await ev(cdp, sid, '__POP_TEST__.groupKeyOf(' + JSON.stringify(V1) + ')');
    const ka = await ev(cdp, sid, '__POP_TEST__.groupKeyOf(' + JSON.stringify(A1) + ')');
    console.log('    视频轨分组键: ' + kv + '\n    音频轨分组键: ' + ka);
    if (kv === ka) ok('同一视频的视频轨与音频轨归入同一组'); else bad('两条轨分组键不一致，无法配对');

    /* 真实 B站 形态（含查询串、不同 CDN 域名） */
    const BV = 'https://cn-sccd-ct-02-09.bilivideo.com/upgcxcode/12/34/56789012/56789012-1-30080.m4s?deadline=1799999999&nbs=1';
    const BA = 'https://cn-hbyc-cm-01-11.bilivideo.com/upgcxcode/12/34/56789012/56789012-1-30280.m4s?deadline=1799999999&nbs=1';
    const kv2 = await ev(cdp, sid, '__POP_TEST__.groupKeyOf(' + JSON.stringify(BV) + ')');
    const ka2 = await ev(cdp, sid, '__POP_TEST__.groupKeyOf(' + JSON.stringify(BA) + ')');
    console.log('    视频轨分组键: ' + kv2 + '\n    音频轨分组键: ' + ka2);
    if (kv2 === ka2) ok('跨 CDN 域名的 B站 双轨同样能配对（只比较路径）'); else bad('B站 双轨未能配对');
    if (/\.m4s$/.test(kv2)) ok('扩展名保留完整（未被 "4" 污染）'); else bad('分组键扩展名异常: ' + kv2);

    /* 不同视频不能互相配对 */
    const other = 'https://vod.example.com/dash/movie-2-30080.m4s';
    const ko = await ev(cdp, sid, '__POP_TEST__.groupKeyOf(' + JSON.stringify(other) + ')');
    if (ko !== kv) ok('不同视频（movie-2）不会被错配到一起'); else bad('不同视频被错配');

    /* 质量标签：视频轨与音频轨必须不同（否则去重时音频轨会被丢弃） */
    const qv = await ev(cdp, sid, '__POP_TEST__.qualityTagOf(' + JSON.stringify(V1) + ')');
    const qa = await ev(cdp, sid, '__POP_TEST__.qualityTagOf(' + JSON.stringify(A1) + ')');
    eq(qv, '30080', '视频轨质量标签');
    eq(qa, '30280', '音频轨质量标签');
    if (qv !== qa) ok('两条轨的质量标签不同，去重时不会互相顶掉');

    console.log('\n[4] 界面渲染：标签 / 提示 / 按钮');
    const rows = await j(cdp, sid, '[...document.querySelectorAll("#list .item")].map(function(r){' +
      'return { badge:(r.querySelector(".badge")||{}).textContent, name:(r.querySelector(".item-name")||{}).textContent,' +
      ' note:(r.querySelector(".item-note")||{}).textContent||"",' +
      ' acts:[...r.querySelectorAll("button[data-act]")].map(function(b){return {act:b.dataset.act,text:b.textContent,audio:b.dataset.audio||""};}) };})');
    console.log('    列表条目: ' + rows.map((r) => r.badge + '/' + r.name).join('  |  '));
    eq(rows.length, 3, '列表条目数');

    const vRow = rows.find((r) => r.badge === 'M4S·视频');
    const aRow = rows.find((r) => r.badge === 'M4S·音频');
    if (vRow) ok('视频轨被标记为「M4S·视频」'); else bad('未找到「M4S·视频」条目：' + JSON.stringify(rows.map((r) => r.badge)));
    if (aRow) ok('音频轨被标记为「M4S·音频」'); else bad('未找到「M4S·音频」条目');

    if (vRow) {
      const merge = vRow.acts.find((a) => a.act === 'merge');
      if (merge) ok('视频轨提供合并下载按钮：' + merge.text);
      else bad('视频轨缺少合并下载按钮（曾因分组失败退化为普通下载）: ' + JSON.stringify(vRow.acts));
      if (merge && merge.text === '下载（含声音）') ok('按钮文案为「下载（含声音）」'); else bad('按钮文案异常: ' + (merge && merge.text));
      if (merge && /30280\.m4s$/.test(merge.audio)) ok('按钮已挂上对应音频轨地址：' + merge.audio.split('/').pop());
      else bad('按钮未挂上音频轨地址: ' + (merge && merge.audio));
      if (/自动合并/.test(vRow.note)) ok('视频轨提示：' + vRow.note.trim()); else bad('视频轨缺少合并提示: ' + vRow.note);
      if (vRow.acts.some((a) => a.act === 'dl')) ok('同时保留「仅视频」单独下载入口');
      else bad('缺少「仅视频」入口: ' + JSON.stringify(vRow.acts));
    }
    if (aRow) {
      if (/无需单独下载|已被自动合并/.test(aRow.note)) ok('音频轨提示：' + aRow.note.trim()); else bad('音频轨提示异常: ' + aRow.note);
      if (aRow.acts.some((a) => a.act === 'dl')) ok('音频轨仍可单独下载（备用）');
    }

    /* ---------------- DASH(.mpd)：清单被读透，音/视频分组 ---------------- */
    console.log('\n[5] DASH 清单：.mpd 条目升级为「选择清晰度」');
    const mpdRow = rows.find((r) => r.badge === 'DASH');
    if (mpdRow) ok('找到 .mpd 条目'); else bad('未找到 DASH 条目：' + JSON.stringify(rows.map((r) => r.badge)));
    if (mpdRow) {
      const dashBtn = mpdRow.acts.find((a) => a.act === 'hls');
      if (dashBtn && dashBtn.text === '选择清晰度') ok('按钮从「暂仅支持复制」升级为「选择清晰度」');
      else bad('DASH 按钮异常: ' + JSON.stringify(mpdRow.acts));
      if (/清单里有 4 条画面轨 \+ 1 条音频轨/.test(mpdRow.note)) ok('提示已读透清单：' + mpdRow.note.trim());
      else bad('DASH 提示未反映清单内容: ' + mpdRow.note);
      /* 点开面板：应列出清单里的 4 档画面 */
      await ev(cdp, sid, '(function(){var b=document.querySelector(\'#list .item .badge\');' +
        'var row=[...document.querySelectorAll("#list .item")].find(function(r){return r.querySelector(".badge").textContent==="DASH";});' +
        'row.querySelector(\'button[data-act="hls"]\').click();return 1;})()');
      await sleep(400);
      const vrows = await j(cdp, sid, '[...document.querySelectorAll(".variants .variant-row")].map(function(r){' +
        'return {res:(r.querySelector(".v-res")||{}).textContent, meta:(r.querySelector(".v-meta")||{}).textContent};})');
      eq(vrows.length, 4, '清晰度面板条目数（清单里的 4 档画面）');
      if (vrows[0] && /2160P/.test(vrows[0].res) && /最高/.test(vrows[0].res)) ok('按分辨率降序，最高档标记为「最高」：' + vrows[0].res);
      else bad('排序或最高标记异常: ' + JSON.stringify(vrows[0]));
      if (vrows[0] && /370 分片/.test(vrows[0].meta)) ok('显示分片数（370）：' + vrows[0].meta);
      else bad('分片数未显示: ' + (vrows[0] && vrows[0].meta));
      if (vrows[0] && /avc1/.test(vrows[0].meta) && /Mbps/.test(vrows[0].meta)) ok('显示编码与码率：' + vrows[0].meta);
      else bad('编码/码率未显示: ' + (vrows[0] && vrows[0].meta));
      /* 提示语必须点明「声音是独立音频轨」，否则用户会以为下载出来没声音 */
      const dhint = await ev(cdp, sid, '(document.querySelector(".variants .variant-hint")||{}).textContent||""');
      if (/独立音频轨/.test(dhint)) ok('面板提示：' + dhint.trim()); else bad('面板缺少独立音频轨提示: ' + dhint);
    }

    console.log('\n[5b] 回归：HLS 分片仍归入「分片」分类，DASH 整轨归入「全部」');
    const counts = await j(cdp, sid, '{all:document.getElementById("cAll").textContent,hls:document.getElementById("cHls").textContent,' +
      'file:document.getElementById("cFile").textContent,seg:document.getElementById("cSeg").textContent,dom:document.getElementById("cDom").textContent}');
    console.log('    分类计数: ' + JSON.stringify(counts));
    eq(counts.all, '3', '「全部」计数（mpd + 双轨）');
    eq(counts.seg, '0', '「分片」计数（整轨不再误判为分片）');

    /* ---------------- 抖音形态：无后缀分离轨（video/mp4 + audio/mp4，路径完全不同） ---------------- */
    console.log('\n[6] 抖音形态：无后缀分离轨的识别与跨组 1v1 兜底配对');
    const t2 = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html?state=demo&scene=douyin&tab=all' })).targetId;
    const sid2 = (await cdp.send('Target.attachToTarget', { targetId: t2, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sid2);
    let ready2 = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { if (await ev(cdp, sid2, '!!window.__POP_READY')) { ready2 = true; break; } } catch (e) { /* retry */ }
    }
    if (!ready2) throw new Error('抖音场景 popup 未就绪');

    const rows2 = await j(cdp, sid2, '[...document.querySelectorAll("#list .item")].map(function(r){' +
      'return { badge:(r.querySelector(".badge")||{}).textContent, name:(r.querySelector(".item-name")||{}).textContent,' +
      ' note:(r.querySelector(".item-note")||{}).textContent||"",' +
      ' acts:[...r.querySelectorAll("button[data-act]")].map(function(b){return {act:b.dataset.act,text:b.textContent,audio:b.dataset.audio||""};}) };})');
    console.log('    列表条目: ' + rows2.map((r) => r.badge + '/' + r.name).join('  |  '));
    eq(rows2.length, 2, '列表条目数（1 视频轨 + 1 音频轨）');

    const vRow2 = rows2.find((r) => r.badge === '视频轨');
    const aRow2 = rows2.find((r) => r.badge === '音频轨');
    if (vRow2) ok('无后缀视频轨被标记为「视频轨」'); else bad('未找到「视频轨」条目：' + JSON.stringify(rows2.map((r) => r.badge)));
    if (aRow2) ok('无后缀音频轨被标记为「音频轨」'); else bad('未找到「音频轨」条目（audio/mp4 曾完全不被捕获）');

    if (vRow2) {
      const merge2 = vRow2.acts.find((a) => a.act === 'merge');
      if (merge2) ok('视频轨提供合并下载按钮：' + merge2.text);
      else bad('视频轨缺少合并按钮（跨组配对失败）: ' + JSON.stringify(vRow2.acts));
      if (merge2 && /media-audio-und-mp4a/.test(merge2.audio)) ok('按钮已挂上跨组兜底找到的音频轨');
      else bad('按钮未挂上音频地址: ' + (merge2 && merge2.audio));
      if (/自动合并/.test(vRow2.note)) ok('视频轨提示：' + vRow2.note.trim()); else bad('视频轨缺少合并提示: ' + vRow2.note);
    }
    if (aRow2) {
      if (/已被自动合并|无需单独下载/.test(aRow2.note)) ok('音频轨提示：' + aRow2.note.trim()); else bad('音频轨提示异常: ' + aRow2.note);
      if (aRow2.acts.some((a) => a.act === 'dl' && a.text === '单独下载')) ok('音频轨按钮为「单独下载」');
      else bad('音频轨按钮文案异常: ' + JSON.stringify(aRow2.acts));
    }

    /* 纯逻辑层：buildGroups 的跨组 1v1 兜底字段
       - 视频轨所在的组：crossAudio 应指向音频轨
       - 音频轨所在的组：crossVideo 应指向视频轨 */
    const crossInfo = await j(cdp, sid2, '[...__POP_TEST__.buildGroups().values()].map(function(g){return {' +
      'key:g.key, crossAudio:g.crossAudio?g.crossAudio.url:"", crossVideo:g.crossVideo?g.crossVideo.url:""};})');
    console.log('    分组情况: ' + JSON.stringify(crossInfo, null, 1).replace(/\n\s*/g, ' '));
    const groupWithCrossAudio = crossInfo.find((g) => /media-audio-und-mp4a/.test(g.crossAudio || ''));
    const groupWithCrossVideo = crossInfo.find((g) => /media-video-hvc1/.test(g.crossVideo || ''));
    if (groupWithCrossAudio) ok('视频轨所在组挂上了 crossAudio（跨组兜底配对已生效）'); else bad('没有组挂上 crossAudio');
    if (groupWithCrossVideo) ok('音频轨所在组挂上了 crossVideo'); else bad('没有组挂上 crossVideo');

    /* ---------------- YouTube 形态：路径全同、身份在 ?id=、角色由 &mime= 声明 ---------------- */
    console.log('\n[7] YouTube 形态：/videoplayback 同路径 + mime/itag 声明角色 + range 分片归一');
    const t3 = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html?state=demo&scene=youtube&tab=all' })).targetId;
    const sid3 = (await cdp.send('Target.attachToTarget', { targetId: t3, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sid3);
    let ready3 = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { if (await ev(cdp, sid3, '!!window.__POP_READY')) { ready3 = true; break; } } catch (e) { /* retry */ }
    }
    if (!ready3) throw new Error('YouTube 场景 popup 未就绪');

    const rows3 = await j(cdp, sid3, '[...document.querySelectorAll("#list .item")].map(function(r){' +
      'return { badge:(r.querySelector(".badge")||{}).textContent, name:(r.querySelector(".item-name")||{}).textContent,' +
      ' subs:(r.querySelector(".item-sub")||{}).textContent||"",' +
      ' note:(r.querySelector(".item-note")||{}).textContent||"",' +
      ' acts:[...r.querySelectorAll("button[data-act]")].map(function(b){return {act:b.dataset.act,text:b.textContent,audio:b.dataset.audio||""};}) };})');
    console.log('    列表条目: ' + rows3.map((r) => r.badge + '/' + r.name).join('  |  '));
    eq(rows3.length, 2, '列表条目数（1 视频轨 + 1 音频轨，range 分片已归并为各 1 条）');

    const vRow3 = rows3.find((r) => r.badge === '视频轨');
    const aRow3 = rows3.find((r) => r.badge === '音频轨');
    if (vRow3) ok('mime=video%2Fmp4 的轨被识别为「视频轨」');
    else bad('未找到「视频轨」：' + JSON.stringify(rows3.map((r) => r.badge)));
    if (aRow3) ok('mime=audio%2Fwebm 的轨被识别为「音频轨」（探测不到 ftyp，靠 URL 声明兜底）');
    else bad('未找到「音频轨」：' + JSON.stringify(rows3.map((r) => r.badge)));

    if (vRow3) {
      const merge3 = vRow3.acts.find((a) => a.act === 'merge');
      if (merge3) ok('视频轨提供合并下载按钮：' + merge3.text);
      else bad('视频轨缺少合并按钮（同组配对失败）: ' + JSON.stringify(vRow3.acts));
      if (merge3 && /mime=audio%2Fwebm/.test(merge3.audio)) ok('按钮已挂上 itag=251 音频轨');
      else bad('按钮未挂上音频地址: ' + (merge3 && merge3.audio));
      if (merge3 && !/range=/.test(merge3.audio)) ok('下载地址不含 &range= 分片参数（不会只下到前 1MB）');
      else bad('下载地址仍带 range 参数: ' + (merge3 && merge3.audio));
    }
    if (aRow3 && /8\.4?6? MB|4\.61 MB|MB/.test(aRow3.subs)) ok('音频轨显示 clen 还原的整轨体积');
    else bad('音频轨体积未按 clen 还原: ' + (aRow3 && aRow3.subs));

    /* 分组键：YouTube 所有轨的 pathname 都是 /videoplayback，必须靠 ?id= 区分视频，
       itag 只用于区分同一视频的不同轨 —— 若分组键漏了 id，不同视频会被并成一组； */
    const groupProbe3 = await j(cdp, sid3, '(function(){var T=window.__POP_TEST__;' +
      'var u1="https://rr3---sn-a.googlevideo.com/videoplayback?id=o-AAA&itag=137&mime=video%2Fmp4";' +
      'var u2="https://rr3---sn-b.googlevideo.com/videoplayback?id=o-AAA&itag=251&mime=audio%2Fwebm";' +
      'var u3="https://rr3---sn-a.googlevideo.com/videoplayback?id=o-BBB&itag=137&mime=video%2Fmp4";' +
      'return { k1:T.groupKeyOf(u1), k2:T.groupKeyOf(u2), k3:T.groupKeyOf(u3),' +
      ' q1:T.qualityTagOf(u1), q2:T.qualityTagOf(u2),' +
      ' roleA:T.roleOf({url:u1,kind:"video"}), roleB:T.roleOf({url:u2,kind:"audio"}) };})()');
    if (groupProbe3.k1 === groupProbe3.k2) ok('同一视频的画面轨与声音轨归入同一组（可配对）');
    else bad('同一视频的两条轨分组不同: ' + groupProbe3.k1 + ' vs ' + groupProbe3.k2);
    if (groupProbe3.k1 !== groupProbe3.k3) ok('不同视频（id 不同）不会并成一组');
    else bad('不同视频被并成一组 —— 分组键漏了 id: ' + groupProbe3.k1);
    if (groupProbe3.q1 !== groupProbe3.q2) ok('同一视频的两条轨质量标签不同（itag 区分）');
    else bad('质量标签相同会导致去重时丢掉一条轨: ' + groupProbe3.q1);
    eq(groupProbe3.roleA + '/' + groupProbe3.roleB, 'video/audio', 'roleOf 从 URL 声明读出角色');

    /* 纯逻辑：MediaRole 在 popup 环境里同样可用 */
    const mrProbe = await j(cdp, sid3, '(function(){var M=window.__POP_TEST__.getMediaRole();' +
      'if(!M) return null;' +
      'return { strip:M.stripSliceParams("https://x.com/videoplayback?id=o-A&itag=137&range=0-999999"),' +
      '  role:M.roleFromUrl("https://x.com/videoplayback?id=o-A&mime=audio%2Fwebm"),' +
      '  nullish:M.roleFromUrl("https://x.com/a/b/stream") };})()');
    if (mrProbe && mrProbe.role === 'audio') ok('MediaRole 已随 popup 载入并可用');
    else bad('MediaRole 未在 popup 中生效: ' + JSON.stringify(mrProbe));
    if (mrProbe && !/range=/.test(mrProbe.strip)) ok('popup 内 stripSliceParams 生效');
    else bad('stripSliceParams 未生效: ' + (mrProbe && mrProbe.strip));
    if (mrProbe && mrProbe.nullish === null) ok('无信号 URL 诚实返回 null（不瞎猜）');
    else bad('无信号 URL 应返回 null，实际: ' + (mrProbe && mrProbe.nullish));

    /* ---------------- DASH：popup 环境里的解析器与「取数规格」 ---------------- */
    console.log('\n[8] popup 环境内的 MpdKit 与分片规格（引擎侧认得的取数格式）');
    const dashProbe = await j(cdp, sid, '(function(){var T=window.__POP_TEST__;var K=T.getMpdKit();' +
      'if(!K) return null;' +
      'var reps=T.getDashReps();var hit=null;reps.forEach(function(v){if(!hit) hit=v;});' +
      'if(!hit) return {kit:true,reps:0};' +
      'var spec=T.repSpec(hit.video[0]);var aspec=T.repSpec(hit.bestAudio);' +
      'return { kit:true, reps:reps.size, nVideo:hit.video.length, nAudio:hit.audio.length,' +
      ' bestAudioBw:hit.bestAudio?hit.bestAudio.bandwidth:0,' +
      ' vParts:spec.parts.length, vInit:spec.initUrl, vFirst:spec.parts[0], vLast:spec.parts[spec.parts.length-1],' +
      ' aParts:aspec.parts.length, aInit:aspec.initUrl, aFirst:aspec.parts[0],' +
      ' height:hit.video[0].height, isLive:hit.isLive, duration:hit.duration,' +
      ' parsedLive:K.parseMpd("<MPD type=\\"dynamic\\"><Period/></MPD>","https://x/y.mpd").isLive };})()');
    if (dashProbe && dashProbe.kit) ok('MpdKit 已随 popup 载入并可用'); else bad('MpdKit 未在 popup 中生效');
    if (dashProbe && dashProbe.reps === 1) ok('demo 场景的 .mpd 已被真解析器解出（界面数据与真实一致）');
    else bad('dashReps 未建立: ' + JSON.stringify(dashProbe));
    eq(dashProbe.vParts, 370, '画面轨分片数（1847.1s ÷ 5s）');
    if (/\/2160p\/init\.mp4$/.test(dashProbe.vInit)) ok('画面轨 init 段地址：' + dashProbe.vInit);
    else bad('init 段地址异常: ' + dashProbe.vInit);
    if (/\/video\/2160p\/00001\.m4s$/.test(dashProbe.vFirst)) ok('画面轨首片（$Number%05d$ 补零填对）：' + dashProbe.vFirst.split('/').pop());
    else bad('首片地址异常: ' + dashProbe.vFirst);
    if (/\/00370\.m4s$/.test(dashProbe.vLast)) ok('画面轨末片编号正确（补零 5 位）：' + dashProbe.vLast.split('/').pop());
    else bad('末片地址异常: ' + dashProbe.vLast);
    if (/\/audio\/aac128\/init\.mp4$/.test(dashProbe.aInit)) ok('音频轨 init 段地址：' + dashProbe.aInit);
    else bad('音频 init 异常: ' + dashProbe.aInit);
    if (dashProbe.aParts === 370) ok('音频轨分片数与画面一致（同一 Period）');
    else bad('音频分片数异常: ' + dashProbe.aParts);
    eq(dashProbe.nAudio, 1, '音频 Representation 数量');
    eq(dashProbe.bestAudioBw, 128000, '最佳音频轨按码率选出');
    eq(dashProbe.isLive, false, 'static 清单不当成直播');
    eq(dashProbe.parsedLive, true, 'dynamic 清单被识别为直播');
    if (dashProbe.duration > 1847 && dashProbe.duration < 1848) ok('清单时长解析：' + dashProbe.duration + 's');
    else bad('时长解析异常: ' + dashProbe.duration);
  } catch (e) {
    bad('测试流程', e);
  } finally {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    if (chrome && chrome.pid) { try { spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
    await sleep(600);
    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n========================================');
    console.log('popup 轨道识别与配对：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    console.log('========================================');
    process.exit(fail ? 1 : 0);
  }
}

main();
