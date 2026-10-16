# 测试样本说明

## 包含在仓库中（可自由分发）

| 文件 | 来源 | 缺失时的行为 |
| --- | --- | --- |
| `flower.mp4` | MDN 交互示例库（CC0 公共领域视频） | `test/serve_local.mjs` 会自动重新下载 |
| `seg0.ts` / `seg1.ts` / `seg2.ts` | 公开 HLS 测试流 `test-streams.mux.dev` | 同上 |
| `webm/rec_video_only.webm`、`webm/rec_audio_only.webm` | 本仓库测试现场录制（无头 Chrome + MediaRecorder 生成 canvas 动画与振荡器音轨） | `test/webmmerge.test.mjs` 会自动重新录制 |

## 未包含在仓库中（第三方版权内容）

以下样本是从真实站点抓取的媒体轨头部片段，**因版权原因未随仓库分发**：

- `dash/bili_video_30032_head.m4s`、`dash/bili_audio_30216_head.m4s` — B站音视频分离轨（fMP4）
- `dash/douyin_video_avc1_head.m4s`、`dash/douyin_audio_mp4a_head.m4s` — 抖音音视频分离轨（fMP4）

缺失时以下套件会打印「缺少测试样本」并终止（其余套件不受影响）：

- `test/fmp4merge.test.mjs`
- `test/douyin_real_sample.test.mjs`
- `test/e2e_dash_parts.mjs`

## 如何自行准备这些样本

任意打开一个使用「音视频分离」的站点（如视频网站），在浏览器开发者工具的 Network 面板中找到媒体轨（通常无后缀或为 `.m4s`），各抓取前 512 KB ~ 1 MB 保存为对应文件名即可。文件不需要完整——测试只解析容器头（`ftyp`/`moov`/`moof`）与少量分片。
