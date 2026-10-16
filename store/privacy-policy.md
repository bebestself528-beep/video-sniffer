# 隐私政策 / Privacy Policy

**视频嗅探下载器（Video Sniffer Downloader）**

最后更新：随扩展版本同步更新 · Last updated: kept in sync with extension releases

---

> **一句话概括：**本扩展没有服务器、没有账号体系，**不收集、不上传、不出售**你的任何数据。所有识别、下载、解密与转封装都在你的电脑上本地完成。

---

## 1. 我们处理哪些数据，为什么

扩展在运行过程中会**在本机内存中**临时读取以下信息，用途仅限于「找出当前页面正在播放的视频资源并把它保存到你的磁盘」：

| 信息 | 用途 | 是否离开你的设备 |
| --- | --- | --- |
| 页面发起的网络请求地址（含媒体文件 URL、请求头中的 Referer/Origin） | 识别视频流地址（m3u8 / mpd / m4s / ts / mp4 等），并在下载时补齐源站所需的来源信息 | **否** |
| 页面中 `<video>` 元素的地址与尺寸信息 | 识别嵌入播放器的视频资源 | **否** |
| 当前标签页的标题与网址 | 把嗅探结果归属到正确的标签页，并据此生成默认文件名 | **否** |
| 你保存的设置（保存目录、输出格式、并发数） | 记住你的偏好，下次打开时沿用 | **否**（保存在浏览器本地存储中） |

上述信息均**不会**发送到开发者或任何第三方。扩展不含统计 SDK、不含广告 SDK、不含崩溃上报、不含远程配置。

## 2. 我们明确不收集的数据

- 不收集浏览历史记录、搜索记录或你访问过的网页清单
- 不收集任何视频内容本身
- 不收集姓名、邮箱、电话、地址等个人身份信息
- 不收集登录凭据、Cookie、令牌等认证信息
- 不收集财务信息、健康信息、位置信息、个人通信内容

## 3. 数据会被共享吗

不会。开发者无法访问你的任何数据。扩展不向任何第三方传输数据，也不存在「出售数据」的情形。

唯一的网络行为是：当你点击「下载」时，扩展**直接向视频所在的服务器**请求该视频文件本身——这与你用浏览器播放视频时的请求性质相同，请求对象是内容提供方，与开发者无关。

## 4. 权限说明

- **webRequest**：以**只读观测**方式查看页面发起的网络请求，用于识别视频地址。不修改、不阻断、不伪造任何请求。
- **downloads**：把你点击下载的资源保存到本机下载目录。
- **declarativeNetRequest**：为已识别的视频请求设置来源（Referer）请求头，使部分校验来源的站点资源能正常下载。仅使用会话级规则，不会设置全局拦截或改写规则。
- **storage**：在本机保存上述少量设置与当前标签页的嗅探结果。
- **tabs**：获取当前标签页的标题与 ID，用于归类嗅探结果与生成文件名。
- **offscreen**：Manifest V3 的后台服务工作线程没有 DOM 与 Blob 能力，需借助离屏文档完成分片合并、解密与文件写出。
- **网站访问权限（所有网站）**：视频资源可能来自任意域名，扩展需在任意页面监听媒体请求，并在下载时访问对应资源域名。该权限**仅用于视频资源识别与下载**，不会读取、分析或上传页面内容。

## 5. 数据保留与删除

嗅探结果保存在浏览器的会话存储中，随标签页关闭或浏览器退出而清除，你也可以随时点击界面上的「清空」按钮立即删除。设置项保存在浏览器本地存储中，卸载扩展即被删除。

## 6. 远程代码

本扩展**不使用任何远程代码**。所有可执行 JavaScript 均包含在扩展安装包内（包含本地打包的开源库 mux.js，用于 MP4 转封装）。扩展不会从网络下载并执行脚本，也不使用 `eval()`。

## 7. 儿童隐私

本扩展不面向儿童，也不会有意收集儿童的个人信息。

## 8. 政策变更

若本政策发生变更，新版本将随扩展更新一同发布，并同步更新本页面的「最后更新」时间。

## 9. 联系方式

如对本隐私政策有疑问，请通过 Chrome 应用商店详情页中提供的支持邮箱与我们联系。

---

## English Summary

This extension has **no server and no user accounts**. It does **not collect, upload, or sell** any of your data. All detection, downloading, decryption and remuxing happen locally on your device.

- **What it reads locally (never leaves your device):** media request URLs observed on the current page (including the Referer/Origin headers needed to fetch them), `<video>` element sources, the current tab's title and URL (to attribute results and name files), and your saved preferences (folder, output format, concurrency).
- **What it never collects:** browsing history, search history, video content, personally identifiable information, authentication credentials, financial or health data, location, or personal communications.
- **Sharing:** none. The only network activity is fetching the video file itself directly from the content provider's server when you click Download — the same request your browser already makes during playback.
- **No remote code:** all executable JavaScript ships inside the extension package (including the locally bundled open-source library mux.js). No `eval()`, no remotely hosted scripts.
- **Deleting data:** sniffed results live in session storage and are cleared when the tab closes or when you press "clear". Settings live in local extension storage and are removed when you uninstall.

Contact: use the support email listed on the Chrome Web Store listing page.
