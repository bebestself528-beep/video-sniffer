/* ============================================================
 * 商店截图生成器 —— 渲染逻辑（开发工具，不随商店包分发）
 * 用法：shot.html?shot=<id>     由 tools/make_shots.mjs 驱动
 * 配置集中在本文件，驱动脚本会读取 Object.keys(SHOT_CONFIG) 自动枚举。
 * 注意：截图中显示的列表数据为演示数据（popup?state=demo），
 *       所有域名均为虚构的 example.com，与任何真实网站无关。
 * ============================================================ */
(function () {
  'use strict';

  var POPUP = '../popup/popup.html';

  var SHOT_CONFIG = {
    /* ---------- 1280 × 800 ---------- */
    '01-overview': {
      size: 'wide',
      h1: '页面视频\n一键嗅探下载',
      feats: [
        '播放即抓取：自动识别 HLS(m3u8) / MP4 / WebM / DASH 等格式',
        '无需开发者工具，不必手工拼接播放列表',
        '清晰度选择 · 分片自动合并 · 本地转封装为 MP4'
      ],
      badges: ['双通道嗅探', '本地运行 · 不上传数据', '无广告 · 无账号'],
      popup: '?state=demo&tab=all',
      file: '01-overview-1280x800.png'
    },
    '02-quality': {
      size: 'wide',
      h1: '清晰度任选\n自动合并为 MP4',
      feats: [
        '解析 master 播放列表，按码率降序列出全部清晰度',
        'mux.js 在浏览器内完成 TS → MP4 转封装，失败自动回退',
        'AES-128 加密分片自动解密，并发数可调'
      ],
      badges: ['最高支持 4K 档位', '转封装不依赖外部程序'],
      popup: '?state=demo&tab=hls&variant=1',
      file: '02-quality-1280x800.png'
    },
    '03-tasks': {
      size: 'wide',
      h1: '实时进度\n被拦截也能救回来',
      feats: [
        '分片进度、已下载体积、实时速度一目了然',
        '下载被防盗链拦截时，自动切换通道重试同一文件',
        '任务可取消；关闭弹窗后下载仍在后台继续'
      ],
      badges: ['自动重试', '后台下载'],
      popup: '?state=demo&tab=all&tasks=1',
      file: '03-tasks-1280x800.png'
    },
    '04-safe': {
      size: 'wide',
      h1: '安全合规\n只下载你有权保存的',
      feats: [
        '不破解 DRM（Widevine 等）加密内容，这是明确的设计边界',
        '零服务器、零账号：解析与合并全部在你的电脑上完成',
        '内置使用政策与免责声明，请遵守目标网站条款与著作权法'
      ],
      badges: ['数据不出本机', '无追踪 · 无统计上报', '开源可审计'],
      popup: '?state=demo&tab=settings',
      file: '04-safe-1280x800.png'
    },
    '05-coverage': {
      size: 'wide',
      h1: '音视频分离？\n自动合并成一个文件',
      feats: [
        'DASH 清单直接读透：点「选择清晰度」就能看到画面档位，不用等播放器把分片请求一遍',
        '画面与声音是两条独立流时，下载自动合成一个文件，无需 ffmpeg 等外部工具',
        'B站 / 抖音 / YouTube 等 7 种分离形态统一处理，WebM 轨同样支持'
      ],
      badges: ['自动识别轨道', '本地合成', '单文件输出'],
      popup: '?state=demo&scene=dash&tab=all&dash=1',
      file: '05-coverage-1280x800.png'
    },

    /* ---------- 1400 × 560（商店大宣传图 / Marquee，用于精选位） ---------- */
    'marquee': {
      size: 'marquee',
      h1: '嗅探 · 解析 · 合并\n浏览器里一次搞定',
      feats: [
        'HLS(m3u8) / MP4 / DASH 等格式全覆盖，播放即抓取',
        '清晰度任选，转封装在本机完成，不上传任何数据'
      ],
      badges: ['双通道嗅探', '清晰度任选', '防盗链自动重试', '零账号 · 零上传'],
      popup: '?state=demo&tab=all',
      file: 'marquee-1400x560.png'
    },

    /* ---------- 440 × 280（商店小宣传图） ---------- */
    'tile': {
      size: 'tile',
      h1: '页面视频\n一键嗅探下载',
      feats: [],
      badges: ['HLS · MP4 · DASH', '本地运行'],
      popup: '?state=demo&tab=all',
      file: 'tile-440x280.png'
    }
  };

  var qs = new URLSearchParams(location.search);
  var id = qs.get('shot') || '01-overview';
  var cfg = SHOT_CONFIG[id] || SHOT_CONFIG['01-overview'];
  var isTile = cfg.size === 'tile';
  if (isTile) document.body.classList.add('tile');
  if (cfg.size === 'marquee') document.body.classList.add('marquee');

  /* ---- 左侧文案 ---- */
  var h1 = document.getElementById('h1');
  if (h1) h1.textContent = cfg.h1;

  var feats = document.getElementById('feats');
  if (feats) {
    feats.innerHTML = (cfg.feats || []).map(function (t) {
      return '<li>' + t.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>';
    }).join('');
  }

  var badges = document.getElementById('badges');
  if (badges) {
    badges.innerHTML = (cfg.badges || []).map(function (t) {
      return '<i>' + t + '</i>';
    }).join('');
  }

  /* 演示数据说明（仅宽图，小图空间不足） */
  if (!isTile) {
    var note = document.createElement('div');
    note.className = 'disclaimer';
    note.textContent = '截图中的列表为界面演示数据，示例域名为虚构域名';
    document.querySelector('.left').appendChild(note);
  }

  /* ---- 右侧 popup 预览 ---- */
  var frame = document.getElementById('pop');
  var ready = false;

  function markReady() {
    if (ready) return;
    ready = true;
    document.body.dataset.ready = '1';
    window.__SHOT_READY = true;
  }

  if (frame && !isTile) {
    frame.addEventListener('load', function () {
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        var ok = false;
        try { ok = !!(frame.contentWindow && frame.contentWindow.__POP_READY); } catch (e) { ok = false; }
        if (ok || tries > 100) {
          clearInterval(timer);
          /* 让 CSS 过渡（进度条动画等）稳定下来 */
          setTimeout(markReady, 320);
        }
      }, 100);
    });
    frame.src = POPUP + (cfg.popup || '');
  } else {
    setTimeout(markReady, 200);
  }

  /* ---- 供驱动脚本读取 ---- */
  window.__SHOT_INFO = { id: id, size: cfg.size, file: cfg.file };
  window.__SHOT_CONFIG_KEYS = Object.keys(SHOT_CONFIG);
})();
