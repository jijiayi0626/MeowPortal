# Meow Domain

一个轻量的个人域名收藏入口页。把任意域名解析到同一套静态文件，访问时会自动展示当前域名、随机动漫壁纸，以及一个显示访客 IP 与端点连通性的底部浮窗。纯静态、零构建、零依赖，丢上任意静态托管即可运行。

![预览](./preview.png)

## 它能做什么

页面由三块独立功能组成，彼此解耦，单文件即可运行。

**域名入口卡**：居中的玻璃拟态卡片，读取 `window.location.host` 实时显示当前访问的域名。同一套文件挂在多个域名下，每个域名看到的内容都是它自己——适合做"域名收藏夹"或个人导航入口。

**随机壁纸**：首屏从拾光 API 的 Pixiv 通道拉取一张动漫插画作为全屏背景，每 10 分钟自动换一张，点击背景空白处也可手动换图。右下角附带作品标题与画师署名。API 请求失败时回退到本地默认壁纸 `assets/bg-original.png`。

**IP 与连通性浮窗**：页面底部固定的胶囊浮窗，最前面是 `Your IP` 标签，紧跟访客 IP、归属地、ASN 与运营商；右侧两个可点击的 chip 分别显示到 Google 与 Cloudflare 端点的连通延迟，按延迟快慢着色。浮窗带 6 小时本地缓存，滚动到页面底部时自动隐藏避免遮挡。

## 项目结构

| 文件 | 作用 |
|------|------|
| `index.html` | 页面主体，包含卡片结构与壁纸脚本 |
| `assets/mynet.js` | IP 解析 + 连通性测速浮窗（单 IIFE，无外部依赖） |
| `assets/bg-original.png` | 默认背景图，壁纸 API 失败时回退使用 |
| `assets/xiaoyiy626-qq.jpg` | 卡片头像 |
| `LICENSE` | MIT 开源协议 |

## 工作原理

### 域名同步

卡片里的 `%host%` 占位符在首屏脚本里被 `window.location.host` 替换。因此无需任何后端，把同一套文件部署到不同域名，每个域名都会显示自己的主机名。

### 壁纸拉取

壁纸脚本先请求拾光 API 的 JSON 端点（`api.nguaduot.cn/pixiv/random?json=1`），拿到图片地址、标题与画师后，用 `new Image()` 预加载，加载成功才切换 `body` 背景，避免闪烁。请求失败或超时（6 秒）则回退到直链 302 跳转地址，再失败就保留本地默认图。署名信息会显示在右下角胶囊里。

### IP 与连通性浮窗

`mynet.js` 用单一 IIFE 封装，所有 DOM 节点带 `mynet-` 前缀，避免与宿主页面冲突。流程分三步：

1. 先读 `localStorage` 里 6 小时内的缓存，秒显上次的 IP 信息，避免白屏等待。
2. 后台并发请求三个 IP 接口（ipapi.co、ipinfo、ip-api.com），用 `Promise.any` 取最快返回的那个，归一化出 IP、归属地、ASN、运营商后写回缓存。
3. 对 Google 与 Cloudflare 两个测速点分别用 `no-cors` 的 `generate_204` 请求计时，串行尝试多个备用 URL 直到通为止，结果按延迟阈值着色（绿/蓝/橙/红）。

浮窗在移动端会自动换行：IP 独占一行，两个 chip 换到下一行并居中。点击任一 chip 可单独重测该端点。测的是到直连端点的连通性，不代表访问本站的真实速度——这点在 chip 的 `title` 提示里有说明。

## 部署

整个项目是纯静态文件，不需要构建。任选一种方式：

- **静态托管**：把 `index.html`、`assets/` 目录上传到 Cloudflare Pages、Vercel、Netlify、GitHub Pages 等任意静态托管，绑定域名即可。
- **对象存储**：上传到 S3 / OSS / COS 等，开启静态网站托管。
- **自建服务器**：放到任意 Web 服务器（Nginx、Caddy 等）的根目录。

把多个域名解析到同一套文件，就能得到多个入口页。

## 自定义

改 `index.html` 顶部 `<style>` 里的 CSS 变量可调整主色：

```css
:root {
  --ink: #3a3a5e;      /* 主文字色 */
  --muted: #8a8ab0;    /* 次要文字色 */
  --soft: #b6b6d0;     /* 最弱文字色 */
  --accent: #1a73e8;   /* 强调色 */
}
```

常用改动一览：

- 头像：替换 `assets/xiaoyiy626-qq.jpg`，或改 `index.html` 里 `<img class="cat">` 的 `src`。
- 默认壁纸：替换 `assets/bg-original.png`。
- 站点名称与文案：改 `index.html` 里的 `<h1>`、`.subtitle`、`.info`、`.footer` 文本。
- 测速端点：改 `assets/mynet.js` 顶部的 `PROBES` 配置，每个端点可配多个备用 URL。
- IP 接口：改 `assets/mynet.js` 顶部的 `IP_ENDPOINTS` 数组。
- 缓存时长：改 `CACHE_TTL_MS`（默认 6 小时）。

## 第三方接口依赖

页面运行依赖以下外部接口，若某接口不可用会自动降级：

| 用途 | 接口 | 失败行为 |
|------|------|----------|
| 随机壁纸 | 拾光 API `api.nguaduot.cn/pixiv/random` | 回退到本地默认壁纸 |
| IP 解析 | ipapi.co、ipinfo.hinswu.top、ip-api.com | 任一可用即可，全失败显示提示 |
| 连通性测速 | gstatic.com、cloudflare.com 等 `generate_204` | 显示 `--ms` |

## 浏览器兼容

使用 `backdrop-filter`、`fetch`、`AbortController`、`Promise.any` 等现代特性，推荐 Chrome / Edge / Firefox / Safari 近年版本。`Promise.any` 在旧浏览器有内置 polyfill 兜底。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源，可自由使用、修改、分发与商用，仅需保留版权声明。
