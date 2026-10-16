/* ============================================================
 * GitHub 自动化发布脚本（隐私政策页 → GitHub Pages）
 * 运行：GH_TOKEN=<你的token> node tools/github_publish.mjs
 *
 * 作用：用 GitHub REST API 全自动完成——
 *   1. 验证 token（GET /user）
 *   2. 创建公开仓库 video-sniffer-privacy（已存在则跳过）
 *   3. 上传 store/privacy-site/index.html（已存在则更新）
 *   4. 开通 GitHub Pages（main 分支根目录）
 *   5. 轮询构建状态，输出最终的隐私政策在线地址
 *
 * 说明：
 *  - 本机环境下 api.github.com 需直连（不走系统代理），脚本使用 Node 原生 fetch（默认直连）。
 *  - token 只从环境变量读取，不会写入任何文件。
 *  - 依赖：Node.js >= 18（仅用原生 fetch）。
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const REPO = process.env.GH_REPO || 'video-sniffer-privacy';
const FILE = join(ROOT, 'store', 'privacy-site', 'index.html');
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('✗ 缺少 token。用法：GH_TOKEN=<你的token> node tools/github_publish.mjs');
  process.exit(1);
}

const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'video-sniffer-publisher',
};

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* 1. 验证 token */
  const me = await api('GET', '/user');
  if (!me.ok) {
    console.error('✗ token 验证失败（HTTP ' + me.status + '）：' + (me.data && me.data.message));
    process.exit(1);
  }
  const owner = me.data.login;
  console.log('✓ token 有效，账号：' + owner + (me.data.name ? '（' + me.data.name + '）' : ''));

  /* 2. 创建仓库（或复用） */
  let created = false;
  const check = await api('GET', '/repos/' + owner + '/' + REPO);
  if (check.status === 404) {
    const c = await api('POST', '/user/repos', {
      name: REPO,
      description: '隐私政策（Privacy Policy）— 视频嗅探下载器 / Video Sniffer Downloader',
      homepage: '',
      private: false,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
      auto_init: true,
    });
    if (!c.ok) {
      console.error('✗ 创建仓库失败（HTTP ' + c.status + '）：' + (c.data && c.data.message));
      if (c.status === 403) console.error('  提示：token 需要勾选 repo 权限。');
      process.exit(1);
    }
    created = true;
    console.log('✓ 已创建公开仓库：' + owner + '/' + REPO);
    await sleep(2500); /* 等仓库初始化 */
  } else if (check.ok) {
    console.log('✓ 仓库已存在，将直接更新内容：' + owner + '/' + REPO);
  } else {
    console.error('✗ 查询仓库失败（HTTP ' + check.status + '）：' + (check.data && check.data.message));
    process.exit(1);
  }

  /* 3. 上传 index.html（已存在则带上 sha 更新） */
  const html = readFileSync(FILE);
  const content = html.toString('base64');
  let sha = null;
  const existing = await api('GET', '/repos/' + owner + '/' + REPO + '/contents/index.html');
  if (existing.ok && existing.data && existing.data.sha) sha = existing.data.sha;

  const put = await api('PUT', '/repos/' + owner + '/' + REPO + '/contents/index.html', {
    message: created ? 'Add privacy policy page' : 'Update privacy policy page',
    content,
    branch: 'main',
    ...(sha ? { sha } : {}),
  });
  if (!put.ok) {
    console.error('✗ 上传文件失败（HTTP ' + put.status + '）：' + (put.data && put.data.message));
    process.exit(1);
  }
  console.log('✓ 已上传隐私政策页（' + (html.length / 1024).toFixed(1) + ' KB）：index.html');

  /* 4. 开通 Pages（已开通会返回 409，忽略） */
  const pages = await api('POST', '/repos/' + owner + '/' + REPO + '/pages', {
    source: { branch: 'main', path: '/' },
  });
  if (pages.ok || pages.status === 201) {
    console.log('✓ 已开通 GitHub Pages（main 分支根目录）');
  } else if (pages.status === 409) {
    console.log('✓ GitHub Pages 已是开通状态');
  } else {
    console.error('✗ 开通 Pages 失败（HTTP ' + pages.status + '）：' + (pages.data && pages.data.message));
    if (pages.status === 403) console.error('  提示：token 需要勾选 repo 权限（classic）。');
    process.exit(1);
  }

  /* 5. 轮询构建状态 */
  const baseUrl = 'https://' + owner + '.github.io/' + REPO + '/';
  console.log('… 等待 Pages 构建（通常 30~90 秒）');
  let built = false;
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    const b = await api('GET', '/repos/' + owner + '/' + REPO + '/pages/builds/latest');
    const st = b.data && b.data.status;
    if (st === 'built') { built = true; break; }
    if (st === 'errored') { console.error('✗ Pages 构建报错：' + JSON.stringify(b.data)); break; }
    process.stdout.write('  #' + (i + 1) + ' 状态：' + (st || 'pending') + '\r');
  }
  console.log('');
  console.log(built ? '✓ Pages 构建完成' : '⚠ 构建状态未知（可稍后手动访问确认）');

  /* 6. 输出结果 */
  console.log('');
  console.log('========================================');
  console.log('隐私政策在线地址：');
  console.log(baseUrl);
  console.log('========================================');
  console.log('');
  console.log('下一步：');
  console.log('  1. 在无痕窗口打开上面的地址确认可访问（可能需等 1~2 分钟）');
  console.log('  2. 把这个地址填进 Chrome 商店的「隐私政策网址」字段');
  console.log('  3. ⚠ 建议现在删除 token：https://github.com/settings/tokens');
}

main().catch((e) => { console.error('✗ 意外错误：' + (e && e.message ? e.message : e)); process.exit(1); });
