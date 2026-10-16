# Chrome 应用商店上架检查清单

> 面向「视频嗅探下载器」v1.0.0 提交 Chrome Web Store 的完整操作手册。
> 逐项打勾即可提交。审核要点与常见驳回原因写在最后一节，建议提交前通读。
>
> **⚡ 最快路径**：全部上传文件（9 个）+ 一页纸操作卡已集中在 `store/upload-kit/`——打开其中的 **《提交操作卡.md》** 照做即可，本清单作为完整参考。

---

## 第 0 步：账号与费用（一次性）

- [ ] 注册 Chrome Web Store 开发者账号：https://chrome.google.com/webstore/devconsole
- [ ] 支付一次性注册费 **$5 USD**（需支持境外支付的信用卡）
- [ ] 完成发布者名称与联系方式（**支持邮箱必填**，会显示在商店详情页）
- [ ] 建议开启两步验证（账号被封会导致已上架扩展全部下架）

---

## 第 1 步：准备上传包

| 项 | 值 |
| --- | --- |
| 上传文件 | `store/dist/video-sniffer-1.0.0.zip` |
| 大小 | 140 KB（原始大小合计 405 KB，ZIP 压缩后） |
| 包内文件 | 21 个（manifest.json + 代码 + 图标 + 两个政策页 + README） |
| SHA256 | `8eba66c80dbf462347238fbbbc5aa0de228fc934d7e3f6185916ea238e105630` |

- [ ] 运行 `node tools/build_zip.mjs` 生成上传包
- [ ] 运行 `node tools/verify_dist.mjs`，确认输出 **「失败 0 项」**
      （该校验会独立解析 ZIP、逐条目校验 CRC32、用解压副本真实加载 Chrome、并做政策合规扫描）

**不要**直接上传源码目录的 zip。源码目录里包含 `test/`（测试脚本）、`tools/`（截图与打包脚本）、`store/`（上架材料），这些文件不必也不应上传，`build_zip.mjs` 已自动排除。

---

## 第 2 步：素材清单（全部已就绪）

| 用途 | 规格 | 文件 | 上传位置 |
| --- | --- | --- | --- |
| 商店图标 | 128×128 PNG | `icons/icon128.png` | Store listing → 图标 |
| 应用截图 1 | 1280×800 | `store/screenshots/01-overview-1280x800.png` | Store listing → 截图 |
| 应用截图 2 | 1280×800 | `store/screenshots/02-quality-1280x800.png` | 同上 |
| 应用截图 3 | 1280×800 | `store/screenshots/03-tasks-1280x800.png` | 同上 |
| 应用截图 4 | 1280×800 | `store/screenshots/04-safe-1280x800.png` | 同上 |
| 应用截图 5 | 1280×800 | `store/screenshots/05-coverage-1280x800.png`（主题：音视频分离 → 自动合并成一个文件） | 同上 |
| 小宣传图 | 440×280 | `store/screenshots/tile-440x280.png` | Store listing → 小宣传图 |
| 大宣传图 | 1400×560 | `store/screenshots/marquee-1400x560.png` | Store listing → 大宣传图（可选） |

- [ ] 截图共 5 张（商店上限即 5 张），已按「一个卖点一张图」组织
- [ ] 截图中的列表为**界面演示数据**，示例域名全部是虚构的 `example.com`，图片左下角已标注说明
- [ ] 如需改文案重新生成：编辑 `tools/shot.js` 的 `SHOT_CONFIG` → 运行 `node tools/make_shots.mjs`

---

## 第 3 步：隐私政策 URL（✅ 已完成，2026-10-16）

**已就绪的地址（直接填进商店表单）：**

**https://bebestself528-beep.github.io/video-sniffer-privacy/**

- 托管方式：GitHub Pages（公开仓库 `bebestself528-beep/video-sniffer-privacy`，仅含隐私政策页）
- 已验证：无 Cookie 访问 HTTP 200、返回 `text/html`、内容与 `store/privacy-site/index.html` **逐字节一致**
- 更新地址内容的方法：改 `store/privacy-site/index.html` → 重新上传该仓库（或让助手用 `tools/github_publish.mjs` 更新）

以下方案仅作存档参考（若将来需要更换托管时）：

商店要求隐私政策托管在一个**可公开访问的网址**上，**不接受 Google Docs 链接**。

### 方案 A：GitHub Pages（✅ 本次采用）
1. 新建一个公开仓库，例如 `video-sniffer-privacy`
2. 把 `privacy.html` 改名为 `index.html` 上传
3. Settings → Pages → Source 选 `main` 分支根目录 → Save
4. 得到形如 `https://<你的用户名>.github.io/video-sniffer-privacy/` 的地址

### 方案 B：自有域名 / 虚拟主机
把 `privacy.html` 放到任意 HTTPS 站点即可，例如 `https://你的域名/privacy.html`。

### 方案 C：免费静态托管
Vercel / Netlify / Cloudflare Pages，拖拽上传文件夹即可获得 HTTPS 地址。

### 方案 D：⚠️ 不可用（曾造成线上事故，已废弃）

**不要再让助手用本机的「发布为应用」功能发布这个隐私政策页。** 实测该功能会把内容直接覆盖到线上已有的另一个重要应用上，导致其页面被替换、服务失效（已恢复）。因此本方案永久废弃。

### 现成文件（供方案 A/B/C 使用）

`store/privacy-site/index.html` 已备好（与 `privacy.html` 内容一致，零外部依赖、自适应深色模式）——做 GitHub Pages 时直接把它作为仓库根目录的 `index.html` 上传即可。

- [x] 隐私政策 URL 已准备好：`https://bebestself528-beep.github.io/video-sniffer-privacy/`
- [x] 该网址在**无痕窗口**中能正常打开（已用无 Cookie 请求验证 HTTP 200，审核员会实际访问）
- [ ] 内容一致：商店「数据使用」问卷的勾选项必须与隐私政策正文一致（提交前自查）

---

## 第 4 步：在 Developer Dashboard 逐项填写

### 4.1 上传与元数据（Store listing 选项卡）

- [ ] 上传 `store/dist/video-sniffer-1.0.0.zip`
- [ ] **名称**：`视频嗅探下载器 - 网页视频与 HLS(m3u8) 下载`（见 `store/listing-zh-CN.md` 第一节）
- [ ] **简短说明**：见文案第二节
- [ ] **详细说明**：见文案第三节
- [ ] **类别**：生产力工具（Productivity）
- [ ] **主要语言**：中文（简体）
- [ ] 上传图标、5 张截图、小宣传图、（可选）大宣传图
- [ ] 填写支持邮箱或支持网址（至少一项）

### 4.2 隐私实践（Privacy practices 选项卡）——**决定审核通过率的关键页**

- [ ] **单一用途说明**：复制文案第五节 5.1
- [ ] **权限理由**：逐个复制文案第五节 5.2（7 项：webRequest / tabs / downloads / storage / declarativeNetRequest / offscreen / 主机权限）
- [ ] **远程代码**：勾选「否」，复制 5.3 的说明
- [ ] **数据使用**：勾选 **网站内容（Website content）**，其余全部不勾
- [ ] **三项认证**：全部勾选（不出售、不用于无关用途、不用于信用评估）
- [ ] **隐私政策 URL**：填入第 3 步准备好的地址

### 4.3 发布范围

- [ ] 可见性：**公开（Public）**
- [ ] 分发地区：按需选择（建议先全地区，或先小范围试水）
- [ ] 提交审核

---

## 第 5 步：审核风险与对策（**提交前请务必阅读**）

### ⚠️ 风险 1：本扩展属于高审查类别

「视频 / 媒体下载」是 Chrome 应用商店审核最严的类别之一，原因是盗版与 DRM 绕过风险。加上本扩展需要 `<all_urls>` 主机权限 + `webRequest`，**初审大概率是人工审核**，耗时可能从几天到两三周。

**已做的缓解措施（不要删除）：**
- 扩展内不做也无法做 DRM 绕过，且在使用政策与详细说明中**主动写明这一限制**
- 内置《使用政策与免责声明》页（`policy.html`），明确"仅下载你有权保存的内容"
- 弹窗底部常驻授权声明链接
- 界面不出现任何「破解 / 去 DRM / 解除限制」类措辞

**提交后如果被驳回，优先检查：**
1. 权限理由是否写得太笼统（如"为了正常工作"）→ 一定要写清具体功能与数据流向
2. 主机权限 `<all_urls>` 是否有充分解释 → 文案已备好，照抄即可
3. 是否被质疑"单一用途" → 强调：**只做视频资源识别与下载这一件事**
4. 隐私政策是否与问卷一致 → 逐句核对

### ⚠️ 风险 2：名称不要"碰瓷"知名产品

- 不要使用其他产品名作为关键词（如某些知名下载器品牌）
- 当前名称 `视频嗅探下载器 - 网页视频与 HLS(m3u8) 下载` 是「功能词 + 格式词」结构，符合元数据政策

### ⚠️ 风险 3：截图不要宣称不存在的能力

- 截图中所有功能都已在代码中实现，没有任何"画饼"元素
- 列表数据是**界面演示数据**且已标注，不冒充真实网站抓取结果 → 这符合"界面内使用模拟数据可以，编造实际效果不行"的尺度

### ⚠️ 风险 4：`minimum_chrome_version` 与旧版浏览器

- manifest 中声明 `minimum_chrome_version: 116`，商店会提示用户升级浏览器，这是正常行为，不会被驳回

---

## 第 6 步：提交后

- [ ] 关注注册邮箱（审核结果、驳回理由都会发到邮箱）
- [ ] 审核通过后：在商店页面检查 5 张截图与文案的实际展示效果
- [ ] 记录版本号与提交时间，后续更新时版本号必须递增（`manifest.json` 的 `version` 字段）
- [ ] 更新流程：改代码 → 改 `manifest.json` 版本号 → `node tools/build_zip.mjs` → `node tools/verify_dist.mjs` → 上传新 zip
- [ ] 每次更新如涉及权限或数据使用变化，需同步更新隐私政策与问卷

---

## 附：一键命令速查

```bash
cd video-sniffer

# 1. 回归测试（确认改动没弄坏东西）—— 共 17 套件 / 439 项断言，全部通过
# 一键入口（推荐）：自动跑完全部 17 套件、自动启停本地验证服务器、汇总结果
node test/run_all.mjs
# 以下是逐条明细（--skip-net 可跳过需公网的套件）
node test/engine.test.mjs         # 引擎单测（11 项，含 AES-128 填充处理回归）
node test/sniffsig.test.mjs       # 内容签名识别单测（25 项）
node test/mediarole.test.mjs      # 媒体角色识别单测（52 项：mime/itag/路径词/CT + 误判防护）
node test/mpd.test.mjs            # DASH 清单解析单测（96 项：4 种分片形态 + 模板变量 + 错误路径）
node test/fmp4merge.test.mjs      # 轨道识别/音视频合并单测（11 项，用真实 B站 样本）
node test/webmmerge.test.mjs      # WebM 双轨识别与合并单测（27 项，现场录制真实双轨）
node test/e2e_headless.mjs        # 端到端测试（14 项）
node test/e2e_merge.mjs           # 合并下载端到端（12 项）
node test/e2e_merge_fallback.mjs  # 合并失败降级（8 项：保底保存视频轨 + 音频另存）
node test/e2e_sniff_gaps.mjs      # 嗅探盲区端到端（17 项：text/plain 的 m3u8、无后缀流、时间线回溯）
node test/e2e_douyin_style.mjs    # 抖音形态端到端（15 项：无后缀 video/mp4 + audio/mp4 双轨）
node test/douyin_real_sample.test.mjs # 抖音真实样本（12 项：实抓字节 → 合并 → Chrome 解码）
node test/e2e_dash_parts.mjs      # DASH 分片端到端（23 项：清单 → 分片下载 → 合并 → 逐字节比对）
node test/e2e_youtube_style.mjs   # YouTube 形态端到端（21 项：mime 声明 + range 归一 + WebM 合并）
node test/e2e_hls_aes.mjs         # HLS AES-128 端到端（9 项：真 Chrome 解密 → 与独立参照比对）
node test/popup_tracks.test.mjs   # 界面轨道配对回归（67 项，含 DASH 面板）
node test/verify_local_page.mjs   # 离线验证环境自检（19 项，需先启动 serve_local.mjs）

# 2. 重新生成商店图片（改了文案或界面后）
node tools/make_shots.mjs        # 输出到 store/screenshots/

# 3. 打包并强校验上传包
node tools/build_zip.mjs         # 输出 store/dist/video-sniffer-<version>.zip
node tools/verify_dist.mjs       # 校验报告 store/dist/verify_report.md
```

---

## 附：本清单相关的文件索引

| 文件 | 作用 |
| --- | --- |
| `store/listing-zh-CN.md` | 全部商店文案 + 隐私问卷答案（直接复制粘贴） |
| `store/listing-en.md` | 英文版文案（可选，扩大覆盖） |
| `store/privacy-policy.md` | 隐私政策 markdown 版（便于发布到博客/文档站） |
| `store/checklist.md` | 本文件 |
| `store/screenshots/` | 全部商店图片素材 + `_manifest.json`（尺寸校验记录） |
| `store/dist/` | 上传包与校验报告 |
| `policy.html` | 扩展内《使用政策与免责声明》 |
| `privacy.html` | 扩展内《隐私政策》（也是拿去托管的那份） |
