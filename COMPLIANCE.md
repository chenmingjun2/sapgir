# 开源前合规与商业风险检查

> 日期：2026-10-18  
> 范围：当前仓库的代码、内置资源、搜索 provider、许可证与发布方式。  
> 说明：这是工程/合规风险清单，**不是法律意见**；正式商业发布前建议让律师复核，尤其是商标、UI 著作权和 API 条款。

> **2026-10-18 更新：** 当前 worktree 已完成去品牌化（Sapgir + 原创图标 + 兼容 DeepSeek 端点的文案）并移除 OpenCode/第三方搜索 provider/keyless 调用。下面保留审计时的风险分析作为历史记录；剩余事项见文末“当前剩余”。

## 结论

审计时有两个 Blocker：

1. **DeepSeek 品牌与 UI 复刻风险**：项目名、扩展图标、Logo、欢迎语、关于页和 README 都直接使用了 DeepSeek 品牌，并明确写“复刻 chat.deepseek.com”。DeepSeek 服务条款明确保留 UI、布局设计和商标权利，并限制使用 “DeepSeek” 名称/Logo。
2. **Keyless 搜索 provider + 伪装 OpenCode 身份**：代码用 `opencode/2.0.27` User-Agent、`X-Client-Name: opencode2`、`X-Tavily-Access-Mode: keyless` 调用 Tavily/Exa/Parallel 等接口。这不是用户自己的 Key，开源后会放大被 provider 限流、封禁或追责的风险。

许可证本身**不能解决**上述两类第三方权利问题；MIT 只解决你拥有版权的那部分代码的授权。用户最终选择 **MIT**。

## 风险分级

### ✅ 已处理（审计时的 Blocker）

#### 1. DeepSeek 名称、Logo、UI 复刻

**当前状态：** 已改为 **Sapgir**，使用原创图标，文案改为“兼容 DeepSeek 端点”；不再使用官方 Logo/字标或“复刻 chat.deepseek.com”的表述；README 截图已替换为 Sapgir 版本。

**位置：**

- `manifest.json`：`name`、`short_name`、`description`
- `app.html`：`<title>`、品牌、`我是 DeepSeek`、`我的 DeepSeek`、关于页 `复刻 chat.deepseek.com…`
- 审计时的 `assets/icon.svg`、`assets/logo.svg`、`assets/mark.svg`：DeepSeek 鲸鱼 Logo / 字标（现已替换为原创 Lattice Bubble）
- 审计时的 `js/icons.js`：`whaleMark()`、`wordmark()`，以及 CSS 中 `mask: url("../assets/mark.svg")`（现已移除）
- `README.md` 标题、功能描述、截图
- `screenshots/`：包含 DeepSeek Logo 和官方 UI
- `js/app.js` 导出 Markdown：`由 DeepSeek Chat 导出`、`## DeepSeek`
- `background.js` 右键菜单：`用 DeepSeek 解释…`

**依据：**

- [DeepSeek Terms of Use](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html) 第 6.1 条：DeepSeek 保留软件、技术、程序、代码、模型、**用户界面、网页、文字、图形、布局设计、商标**等权利。
- 第 6.2 条：未经许可，不得以任何方式使用 “DeepSeek” 等商标、商号、Logo、URL 或其他显著品牌特征。
- 第 3.5(3) 条：限制反向工程、复制服务内容等行为；第 3.4(10) 条限制冒充他人/官方。
- 第 3.1 / 5.3 条：发布 AI 输出时需标注 AI 生成，不得删除/伪造相关标识。

**建议：**

1. **改名**：例如 `Sapgir`、`OpenChat BYOK`、`DeepSeek API Client`（最后一种仍含商标，风险更高）。
2. **移除官方 Logo/鲸鱼/字标**：换成本项目原创图标；不要用 DeepSeek 图标作为扩展图标。
3. **改文案**：删除“复刻 chat.deepseek.com”和“我是 DeepSeek”；改为“独立的 BYOK 聊天客户端，兼容 DeepSeek API”。
4. 保留对 DeepSeek API 的**描述性引用**即可，例如“Works with the DeepSeek API”，不要暗示官方合作/背书。
5. 在 README、关于页、商店描述中加显著声明：**Unofficial / not affiliated with DeepSeek**。
6. 重新截图，或把截图作为“第三方界面示意”单独标注；不要把截图纳入代码许可证的授权范围。
7. 导出 Markdown 改成中性署名；加上“AI 生成内容”提示。
8. UI 视觉上做差异化，避免完全复刻布局/配色/组件；这不仅降低商标风险，也降低 UI 著作权/不正当竞争风险。

> 如果坚持保留 “DeepSeek Chat” 这个产品名和官方 Logo，建议先取得 DeepSeek 的书面许可；否则不建议商业发布。

#### 2. Keyless 搜索 provider / 伪装 OpenCode

**当前状态：** 已移除所有 keyless 调用、伪装 OpenCode UA 和 Service Worker 搜索代理。2026-10-20 起，Chat 模式在 DeepSeek Search 基础上增加了 BYOK 的 Exa / Parallel / Tavily 多引擎轮换：每个引擎只使用用户自己在该 provider 申请的 API Key，没有任何共享凭证、伪装头或 keyless 路径；未配置 Key 的引擎不参与轮换。当前引擎失败时会按随机顺序尝试其余已配置引擎，直到列表用尽；另有开关可强制只使用 DeepSeek Search。Messages 模式只使用 DeepSeek 兼容端点。

**位置：**

- `js/websearch.js`
  - `const UA = 'opencode/2.0.27'`
  - `X-Client-Name: opencode2`
  - `X-Tavily-Access-Mode: keyless`
  - `X-TinyFish-Access-Mode: keyless`
- `js/webfetch.js`：`OpenCode-User/1.0` User-Agent
- 设置页/README 宣传“keyless 可用”“OpenCode 随机”

**风险：**

- Keyless 端点通常是 OpenCode 等特定客户端的集成方式，不等于对任意第三方客户端开放；开源分发会让大量用户复用同一套无 Key 访问，容易被限流/封禁。
- 伪造 `X-Client-Name` / User-Agent 可能构成虚假标识、违反 provider 条款，甚至被视为绕过访问控制。
- 使用 “OpenCode” 名称/身份做兼容描述可以，但**不能伪装成 OpenCode 客户端**。
- 商业上最直接的风险：provider 封 IP/Key、API 变更导致功能不可用，或收到条款通知。

**建议：**

1. 删除所有 keyless 模式和伪装头；统一使用用户自己申请的 provider API Key。
2. `random` 只从“已配置 Key 的 provider”中随机；没有 Key 就只保留 DeepSeek Search（走用户 DeepSeek Key）或禁用搜索。
3. `webfetch` 使用本项目自己的 UA（例如 `Sapgir/1.0`）或普通浏览器 UA；不要冒充 OpenCode。
4. README 删除“keyless 可直接用”的表述；增加各 provider 条款链接和“用户需自行遵守 provider 条款”。
5. 如果希望保留零配置体验，优先使用 DeepSeek 官方 Search/Fetch（用户已有 DeepSeek Key），不要依赖第三方 keyless。

### 🟠 高：开源/商业发布前应处理

#### 3. 许可证：MIT（已选定）

**当前：** `LICENSE` 为 **MIT**；用户已确认使用 MIT。

MIT 与当前依赖兼容：

- `DOMPurify` 是 `Apache-2.0 OR MPL-2.0`；`highlight.js` 是 BSD-3-Clause；`marked`、`KaTeX`、`Turndown` 是 MIT；KaTeX 字体是 SIL OFL 1.1。它们都可以与 MIT 项目一起分发，但必须保留各自版权和许可声明。
- MIT 允许商业使用、修改和闭源再分发；这对你后续商业化最灵活。
- MIT 不要求衍生分发开源；如果你以后希望强制回馈，才需要重新考虑 GPL/AGPL（需所有贡献者同意）。
- 当前没有使用 GPL/AGPL；不要声称项目是 GNU 许可证。

**当前通知不足：**

- `THIRD_PARTY_NOTICES.md` 只给了链接，没有附 MIT/BSD/Apache/MPL 的完整许可证文本。MIT/BSD 要求随分发保留版权和许可声明。
- `KaTeX` 字体（`vendor/katex/fonts/*.woff2`）是 SIL OFL 1.1，当前未列出。
- `KaTeX auto-render` 未单独列出。
- `Turndown` / `turndown-plugin-gfm` 的 minified 文件没有许可证头，需在通知中附 MIT 文本。
- `js/icons.js` 的图标路径若来自 Lucide/Feather，需要加 ISC/MIT 归属或替换。
- 品牌资源不随 MIT 代码授权；`TRADEMARKS.md` 已说明这一点。

**建议落地：**

- `LICENSE` 保持 MIT；README 的 License 段已同步。
- 增加 `LICENSES/`（MIT、BSD-3-Clause、Apache-2.0、MPL-2.0、OFL-1.1），把完整文本放进去。
- 自有 JS/HTML/CSS 可选加 `SPDX-License-Identifier: MIT`；vendor 文件保持原许可证，不要覆盖。
- `TRADEMARKS.md` 已声明 DeepSeek/Anthropic 等名称归各自权利人，本项目不主张商标权。
- 在商店页/README 提供源码仓库链接，方便用户获取对应源码。

#### 4. API / Provider 条款与隐私

**数据流：**

- 对话、图片、文件 → 用户配置的 Base URL（默认 DeepSeek）
- Anthropic 模式 → DeepSeek 的 `/anthropic/v1/messages`
- Chat 模式搜索 query → DeepSeek Search API；本地抓取的 URL → 目标网站
- 右键总结 → 当前页面正文发送到模型 API
- API Key → `chrome.storage.local` 明文

**建议：**

- 增加 `PRIVACY.md`，明确上述数据流、保存位置、无遥测、第三方请求。
- Chrome Web Store 上架必须填隐私政策；`<all_urls>` + `scripting` 要解释用途。
- 不要把 API Key 写入日志、导出文件或截图；当前导出已清空 Key，保持。
- 提示用户：Chrome 扩展的本地存储不是加密保险箱；共享电脑/恶意扩展有风险。
- 说明 DeepSeek 可能按其条款使用输入/输出改进模型，用户可在 DeepSeek 账户中关闭相关选项。
- 说明 AI 输出可能错误；导出内容要带 AI 生成标识。

#### 5. Chrome Web Store / 商业分发

- 商店对**冒充官方**、使用他人品牌 Logo 很敏感；审计时的名称/图标/截图是高风险项，当前已换成 Sapgir。
- `<all_urls>` + `scripting` 可能触发人工审核；考虑把必需域名放 `host_permissions`，把任意网页抓取放到 `optional_host_permissions`，右键总结用 `activeTab`。
- 商店页需要隐私政策、数据使用说明、单一用途说明。
- 如果收费，MIT 允许，但买家可再分发；商业模型更适合“支持/托管/企业服务”，而不是单纯卖一份可复制的客户端。

### 🟡 中：建议处理

- **Anthropic/OpenCode/provider 名称**：只做描述性使用，不要用 Logo 或暗示合作；加商标声明。
- **UI 复刻**：即使改名，过度相似仍可能涉及 UI 著作权/不正当竞争；建议调整配色、布局、文案。
- **AI 标识**：UI 已有“内容由 AI 生成”，导出 Markdown 目前没有；补上。
- **截图**：审计时的截图包含官方品牌；当前已换成 Sapgir 版本。
- **图标来源**：`js/icons.js` 若是 Lucide/Feather 路径，补 ISC/MIT 归属；否则替换为原创图标。
- **Key 存储**：本地明文；在 README/隐私政策中说明，避免用户误以为加密。
- **第三方链接/搜索结果**：不要把第三方内容打包进仓库；只展示链接/摘要。
- **出口管制/制裁**：DeepSeek ToS 有出口管制条款；商业分发时不要面向受制裁地区/主体（按适用法律）。

### 🟢 低 / 已经做得好的

- 无中转服务器、无遥测、无远程脚本；Markdown 用 DOMPurify 清洗；导出不包含 Key。
- 本地抓取默认禁止 localhost/内网；有超时/大小限制。
- 代码结构清晰，适合开源；无构建工具，源码即分发物，MIT 合规成本较低。

## 建议的发布顺序

1. ✅ **去品牌化**：改名、换图标/Logo、改欢迎语/关于页/导出署名/README；截图已替换。
2. ✅ **移除 keyless + 伪装 UA**：已改为只使用 DeepSeek Search / Messages 端点。
3. **确认 MIT 许可证**：`LICENSE` 已为 MIT；补全 `LICENSES/`、`TRADEMARKS.md`、SPDX。
4. **补隐私/条款**：`PRIVACY.md`、AI 标识、Chrome Web Store 权限说明。
5. **UI 差异化**：降低复刻视觉风险。
6. **律师复核**：商标、UI 著作权、API 条款、MIT 分发。

## 案例：esengine/DeepSeek-Reasonix 为什么还没收到律师函

参考：[DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)、[Issue #4488](https://github.com/esengine/DeepSeek-Reasonix/issues/4488)、[DeepSeek Terms 6.2](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)。

**先说结论：它并没有获得“合法使用 DeepSeek 名字”的豁免，也没有律师函就代表安全。** 它做的是把“DeepSeek”从**产品身份**降级为**兼容对象/仓库描述**，从而降低混淆和商标执法的优先级。

它做对的几件事：

1. **产品名是 Reasonix，不是 DeepSeek Chat**：网站是 reasonix.io，安装包/命令是 `reasonix`，产品品牌与 DeepSeek 分离。
2. **不是 chat.deepseek.com 的 UI 复刻**：它是终端/桌面 coding agent，界面和交互与 DeepSeek 聊天页不同，不涉及 DeepSeek 的页面布局/头像/聊天组件。
3. **没有把官方小鲸鱼当作自己的 Logo**：当前 README 使用自定义 ghost-wave 字标；维护者在 Issue #4488 中明确说“being named DeepSeek-Reasonix doesn't license it”，并把它作为 Logo 重做的 tracking issue。
4. **DeepSeek 只是 provider preset**：README 写的是 “a DeepSeek preset is built in, any OpenAI-compatible service is one config entry”。模型名/API 兼容性是描述性的，不暗示官方合作。
5. **走官方 API、用户自带 Key**：`reasonix.example.toml` 使用 `https://api.deepseek.com` + `DEEPSEEK_API_KEY`，没有 keyless 逆向接口、没有伪装 UA、没有绕过计费。
6. **模型无关**：它明确支持多家 provider，不是“DeepSeek 官方客户端”的定位。

它仍然保留的风险：

- 仓库名仍是 `DeepSeek-Reasonix`，网址/群名也带 DeepSeek；这仍属于商标性使用，只是可能更接近“描述性/指示性使用”。
- 当前 Logo 仍包含 DeepSeek 字样/相关视觉；Issue #4488 仍然 Open，维护者承认需要全面重做。
- README/LICENSE 没有 “not affiliated with DeepSeek” 的明确声明；没有声明不等于没有风险。
- DeepSeek ToS 6.2 的合同条款很宽，**没有发函可能是容忍、执法优先级或 nominative use 的判断，不是授权**。
- 35.8k stars 和赞助不会形成法律豁免；商业化越成功，被注意到的概率越高。

**对你有用的结论：**

Reasonix 的做法是“**用 DeepSeek 名字做兼容性描述，但不用 DeepSeek 的身份、Logo、UI 和接口漏洞**”。  
审计时你的项目是“**产品名 + 官方 Logo + UI 复刻 + keyless 伪装**”，风险显著高于它。当前已改成中性产品名、原创图标并移除 keyless；UI 仍基本沿用原来的聊天布局，虽然 CSS 是自绘，UI 著作权/不正当竞争的残余风险仍建议在商业化前由律师评估。

## 许可证决定

**最终选择：MIT。**

- MIT 允许商业使用、修改、闭源再分发；适合当前“开源扩展 + 自部署”的定位。
- 如果未来要做托管服务并希望网络使用也开源，再评估 AGPL-3.0；变更前需所有贡献者同意。
- 纯 GPLv2 与当前 Apache-2.0/MPL-2.0 依赖有兼容性麻烦；本项目不使用。

## 当前剩余

- [x] 把旧截图全部换成 Sapgir 品牌。
- [x] 确认 MIT 许可证；`LICENSE` 已为 MIT。
- [x] 添加 `TRADEMARKS.md`。
- [x] 补全 `LICENSES/` 中的 MIT/BSD/Apache/MPL/OFL 全文。
- [ ] 加 `PRIVACY.md` 和 Chrome Web Store 权限说明。
- [ ] UI 仍与原聊天布局相近；如商业化，建议律师评估是否需要进一步差异化。
- [ ] 正式商业发布前做律师复核。
