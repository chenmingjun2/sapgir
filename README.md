# Sapgir

> 兼容 DeepSeek Anthropic Messages 端点的自带 Key AI 聊天扩展。
>
> 纯本地运行，无中转服务器、无遥测；不隶属于 DeepSeek 官方。

<p align="center">
  <img src="screenshots/welcome-light.png" width="100%" alt="Sapgir 欢迎页" />
</p>

<p align="center">
  <img src="screenshots/chat-light.png" width="49%" alt="浅色对话" />
  <img src="screenshots/chat-dark.png" width="49%" alt="深色对话" />
</p>

<p align="center">
  <img src="screenshots/chat-websearch.png" width="70%" alt="服务端联网搜索与参考来源（默认折叠）" />
</p>

<p align="center">
  <img src="screenshots/mobile-welcome.png" width="30%" alt="移动端" />
</p>

---

## 品牌

当前使用原创图标 **Lattice Bubble**：气泡 + 节点网络，源文件为 `assets/icon.svg`，并已导出 16–512px PNG。

项目名 **Sapgir** 致敬俄罗斯诗人 **Genrikh Sapgir（1928–1999）**；仅作为项目名称，不代表其遗产或相关权利方，也不使用其肖像或诗作。

## 功能

- **自带 API Key**：兼容 DeepSeek 的 Anthropic Messages 端点；支持自定义模型名、测试连接、查看可用模型。
- **单一端点**：整轮对话固定走 `POST {baseUrl}/anthropic/v1/messages`，不再维护 Chat Completions / Messages 两套客户端。
- **服务端原生联网**：请求中声明 Anthropic 原生 `web_search` 工具，搜索、网页抓取和正文注入都由 DeepSeek 服务端完成；模型自行决定是否搜索，客户端没有手动联网开关。
- **默认 `deepseek-flash` 原生多模态**：上传 / 粘贴 / 拖拽图片（JPG、PNG、GIF、WebP），自动压缩后以 base64 发送；支持多图、图片预览大图、历史图片回放。
- **搜索与来源默认折叠**：服务端搜索过程和参考来源放在回答上方，默认收起，点击标题展开，不挤占正文。
- **深度思考**：开关、`low / high / max` 思考强度、实时展示思考过程与耗时，可自动折叠。
- **稳定 system 快照**：对话开始时快照 system message，之后只追加可见消息，尽量保持请求前缀稳定，提高 DeepSeek 前缀缓存命中。
- **完整 Markdown**：GFM 表格、任务列表、代码高亮、代码复制、引用链接、KaTeX 公式（`$$...$$`、`\(...\)`、`\[...\]`）。
- **本地优先**：对话和设置保存在 `chrome.storage.local`，可导出 / 导入备份，导出文件不包含 API Key。
- **附加能力**：文本文件附件、对话搜索、重命名、置顶、删除、Markdown 导出、右键菜单「用 AI 解释 / 总结页面」。

## 安装

要求 **Chrome / Edge 116+**。

1. 下载或克隆本目录。
2. 打开 `chrome://extensions/`，开启右上角 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本项目根目录（包含 `manifest.json` 的目录）。
4. 在工具栏固定扩展图标，点击图标即可打开聊天页。
5. 首次打开会自动弹出设置：
   - **API Key**：在 [platform.deepseek.com](https://platform.deepseek.com/) 创建。
   - **Base URL**：默认 `https://api.deepseek.com`，填根地址即可；扩展会自动请求 `/anthropic/v1/messages`。
   - **模型**：默认 `deepseek-flash`（推荐，支持图片理解）。
   - 可点击 **测试连接** 验证 Key 和网络。
   - **对话与工具**：可设置单轮最多搜索次数，并点击 **测试联网搜索**。
   - 点击 **保存**。

> 扩展页会在新标签页中打开；再次点击工具栏图标会聚焦已打开的页面，不会打断正在进行的对话。

## Android App

`android/` 提供了基于系统 WebView 的 Android 壳，复用本仓库的前端代码（构建时自动同步，不维护第二份副本），无需 Android Studio。主题设置为「跟随系统」时，Android 壳会读取系统日间/夜间模式并自动切换；显式选择浅色/深色时保持用户选择。

```bash
export JAVA_HOME=~/android-toolchain/jdk
export ANDROID_HOME=~/Android/Sdk
cd android && echo "sdk.dir=$ANDROID_HOME" > local.properties && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

要求 Android 10+（minSdk 29）。构建环境、签名和移动端适配细节见 [android/README.md](android/README.md)。

## 使用

- **发送**：`Enter` 发送，`Shift + Enter` 换行。可在设置中改为 `Ctrl/⌘ + Enter` 发送。
- **深度思考**：输入框左侧的「深度思考」开关；思考过程会实时显示，回答开始后自动折叠。
- **联网搜索**：由服务端控制。输入框不再提供「联网搜索」开关；模型会根据问题自行决定是否调用原生 `web_search`。搜索次数和来源会显示在回答上方，默认折叠。
- **图片**：点击回形针、直接粘贴截图，或把图片拖进页面；发送前可点击缩略图查看大图。
- **文本文件**：支持 `.txt / .md / .json / .csv / .py / .js / .ts / .html / .css / .sql / .yaml` 等常见文本文件。
- **对话管理**：侧边栏支持搜索、重命名、置顶、删除、导出 Markdown。
- **快捷操作**：
  - `Ctrl / ⌘ + K`：搜索对话
  - `Alt + N`：新对话
  - `Esc`：关闭菜单 / 弹窗
- **右键菜单**（在任意网页上）：
  - 「用 AI 解释“选中内容”」
  - 「用 AI 总结此页面」

## 模型与 API

扩展只使用 DeepSeek 的 Anthropic Messages 兼容接口：

```text
POST {baseUrl}/anthropic/v1/messages
x-api-key: <API_KEY>
anthropic-version: 2023-06-01
content-type: application/json
```

- 默认模型：`deepseek-flash`（原生视觉理解、长上下文、支持工具调用）。
- 也支持 `deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner` 或自定义模型名。
- 思考参数：`thinking: { type: "enabled" | "disabled" }` + `output_config: { effort: "low" | "high" | "max" }`。
- 非思考模式下可传 `temperature`。
- 图片以 base64 image block 发送。

### 上下文与缓存

- 对话开始时快照一条 system message，之后不逐轮重写；
- 每轮从可见的 user / assistant 消息重建历史；
- 服务端 `web_search` 的 `server_tool_use` / `web_search_tool_result` 块不会跨轮重放；
- 消息下方会显示类似 `缓存 77% · ↑2.9k ↓420` 的用量信息。

### 联网搜索

- 请求中声明原生工具：

  ```json
  {
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 5
  }
  ```

- `max_uses` 由设置中的「单轮最多搜索次数」控制，范围 2–8。
- 搜索、网页抓取和正文注入都在 DeepSeek 服务端完成；客户端只接收 `web_search_tool_result` 中的来源列表用于展示。
- 不再调用 DeepSeek Search / Fetch 原始 API，也不接入 Exa / Parallel / Tavily 等第三方搜索 provider；没有 keyless 模式，也不会伪装成其他客户端。
- 服务端搜索会按 DeepSeek 的计费规则结算，具体以官方文档和账单为准。

## 数据与隐私

- API Key 只保存在当前浏览器的 `chrome.storage.local`，不会发送到本项目自己的服务器。
- 模型、图片、文件和联网搜索请求都只发送到你填写的 **Base URL**（默认 `https://api.deepseek.com`）。
- 没有第三方搜索 provider，也没有本地网页抓取；搜索 query 和抓取都在 DeepSeek 端点内完成。
- 没有自建服务器、没有统计上报、没有远程配置。
- 导出的 JSON **不包含 API Key**。
- 本项目声明 `<all_urls>` 权限，用于自定义 Base URL 和右键总结页面。

> 本项目不是 DeepSeek 官方产品，与 DeepSeek 没有隶属或背书关系。DeepSeek 名称仅用于说明 API 兼容性。

## 已知限制

- **只支持 Anthropic Messages 端点**：仅提供 OpenAI Chat Completions 的兼容服务不能直接使用。
- **联网由服务端决定**：客户端没有手动联网开关；模型可能选择不搜索，也可能在一轮内多次搜索。
- **搜索依赖端点能力**：如果目标端点不支持 `web_search_20250305`，请求可能失败或忽略该工具。
- **偶发未完成**：极少数情况下端点会以 `tool_use` / `pause_turn` 结束；当前会显示可重试错误。
- **无客户端网页抓取**：不提供 `web_fetch`，需要读取特定 URL 时请直接把链接发给模型。
- **PDF / Word 暂不解析**：目前支持图片和常见文本文件。
- **GIF 会取首帧**。
- **公式**：支持 `$$...$$`、`\(...\)`、`\[...\]`，不解析单美元 `$...$`。
- **非官方项目**：与 DeepSeek 官方无关，DeepSeek 名称、Logo 与商标归深度求索所有。

## 开发

无需构建工具，直接加载目录即可。

本地预览：

```bash
python3 -m http.server 8765
# 打开 http://127.0.0.1:8765/app.html
```

运行测试（Node 18+，使用内置 `node:test`）：

```bash
npm test
```

测试覆盖 Anthropic SSE 解析、`web_search_tool_result` 来源提取、旧设置清理和导出不含 Key。

### 目录结构

```text
.
├── manifest.json          # MV3 配置
├── package.json           # 仅用于 node:test，无运行时依赖
├── background.js          # Service Worker：打开/聚焦标签页、右键菜单
├── app.html               # 聊天主页面
├── styles/app.css         # 全部样式（自绘 UI）
├── js/
│   ├── app.js             # UI 状态、侧边栏、流式渲染、对话编排
│   ├── api.js             # Base URL、模型列表、system message
│   ├── anthropic.js       # Messages 客户端、原生 web_search、流式解析
│   ├── settings-ui.js     # 设置表单、连接/搜索测试
│   ├── attachments.js     # 图片压缩、文件读取、附件预览
│   ├── tool-panel.js      # 搜索面板与参考来源渲染
│   ├── http.js            # host / 超时 / 错误响应解析
│   ├── storage.js         # chrome.storage.local
│   ├── markdown.js        # Markdown、代码高亮、引用、KaTeX
│   └── icons.js           # 内联图标
├── test/                  # node:test 单测
├── vendor/                # marked / DOMPurify / highlight.js / KaTeX
├── assets/                # 原创图标
├── screenshots/           # README 截图
└── android/               # Android WebView 壳（复用本目录前端代码）
```

### 第三方库

- [marked](https://github.com/markedjs/marked) — MIT
- [DOMPurify](https://github.com/cure53/DOMPurify) — Apache-2.0 / MPL-2.0
- [highlight.js](https://highlightjs.org/) — BSD-3-Clause
- [KaTeX](https://katex.org/) — MIT；字体 SIL OFL 1.1

完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，许可证全文在 [`LICENSES/`](LICENSES/)。

## 合规与商标

开源前请阅读 [COMPLIANCE.md](COMPLIANCE.md)：

- DeepSeek、Anthropic 等名称归各自权利人；本项目只做兼容性描述。
- 不使用 DeepSeek 官方 Logo、字标或官方 UI。
- 本项目不是 DeepSeek 官方产品。
- 第三方库和字体的许可证需随分发保留。
- 商标说明见 [TRADEMARKS.md](TRADEMARKS.md)。

## License

代码以 **MIT** 协议开源，详见 [LICENSE](LICENSE)。DeepSeek 名称、Logo 与商标不随代码授权。
