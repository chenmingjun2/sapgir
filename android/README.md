# Sapgir for Android

WebView 壳工程，把仓库根目录的 Chrome 扩展 UI 原样打包成 Android 应用。不需要 Android Studio，命令行即可构建。

- **只维护一份前端代码**：Gradle 任务 `syncWebAssets` 在构建时把根目录的 `app.html / js / styles / vendor / assets` 复制进 APK，仓库里没有第二份副本。
- **系统 WebView**：使用设备自带的 Android System WebView（Chromium），随系统/Play 商店更新，不打入额外的浏览器内核。
- **跟随系统主题**：读取 Android 的 `uiMode`，在设置「主题 = 跟随系统」时自动切换日间/夜间模式；显式选择浅色/深色时保持用户选择。
- **版本号统一**：`versionName` 与 `versionCode` 都从根目录 `manifest.json` 的 `version` 派生，不用两处手改。

## 环境

| 依赖 | 版本 |
| --- | --- |
| JDK | 17+ |
| Android SDK Platform | 35 |
| Android SDK Build-Tools | 35.0.0 |
| Gradle | 8.9（可用 wrapper） |
| minSdk | 29（Android 10） |
| targetSdk | 35 |

没有 SDK 时，用命令行工具安装（无需 Android Studio）：

```bash
# 1. JDK 17（示例：Temurin）
mkdir -p ~/android-toolchain/jdk
curl -L https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse \
  | tar -xz -C ~/android-toolchain/jdk --strip-components=1

# 2. Android command-line tools
mkdir -p ~/Android/Sdk/cmdline-tools
curl -L -o /tmp/cmdline-tools.zip \
  https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q /tmp/cmdline-tools.zip -d ~/Android/Sdk/cmdline-tools
mv ~/Android/Sdk/cmdline-tools/cmdline-tools ~/Android/Sdk/cmdline-tools/latest

# 3. 安装平台与构建工具
export JAVA_HOME=~/android-toolchain/jdk
export ANDROID_HOME=~/Android/Sdk
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
  "platform-tools" "platforms;android-35" "build-tools;35.0.0"

# 4. Gradle（或直接用 android/gradlew）
```

## 构建

```bash
export JAVA_HOME=~/android-toolchain/jdk
export ANDROID_HOME=~/Android/Sdk
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties   # 已在 .gitignore 中

./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

安装：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 发布签名

```bash
keytool -genkeypair -v -keystore sapgir-release.jks -alias sapgir \
  -keyalg RSA -keysize 2048 -validity 10000

# android/keystore.properties（不要提交）
# storeFile=../sapgir-release.jks
# storePassword=...
# keyAlias=sapgir
# keyPassword=...
```

在 `android/app/build.gradle.kts` 的 `android { signingConfigs { ... } }` 中读取该文件后，执行：

```bash
./gradlew assembleRelease
```

## 移动端适配说明

| 问题 | 处理方式 |
| --- | --- |
| `chrome.storage.local` 不存在 | 注入 `app/src/main/assets/sapgir-shim.js`，用 IndexedDB 实现同一套异步 API；避免 localStorage 5 MB 配额被 base64 图片撑爆 |
| `<a download>` / blob URL 无法导出 | `js/app.js` 的 `download()` 优先调用 `SapgirAndroid.saveFile()`，通过 MediaStore 写入 `下载/Sapgir/` |
| CORS | 页面运行在 `https://appassets.androidplatform.net` 安全源；DeepSeek 端点已返回对应 `Access-Control-Allow-Origin`。**自建/第三方 OpenAI 兼容网关若不发 CORS 头，请求会被 WebView 拒绝**（扩展里靠 host permissions 绕过，WebView 没有这个能力） |
| 文件选择 | `WebChromeClient.onShowFileChooser` + SAF（`ACTION_OPEN_DOCUMENT`），支持多选，无需存储权限 |
| 外链 | `shouldOverrideUrlLoading` 交给系统浏览器；应用内不加载远程页面 |
| 返回键 | 先关 `<dialog>` / 侧边栏，再回退历史，最后退出 |
| 沉浸式/键盘 | `edge-to-edge` + `WindowInsets`（systemBars/ime），`adjustResize` 让输入框不被键盘遮挡 |
| 图片粘贴/拖拽 | 移动端无拖拽；图片走相册选择或输入框粘贴 |
| 右键菜单 / 页面总结 | `background.js` 是扩展 Service Worker，Android 端不加载；这些能力在 App 中不可用 |

## 目录

```text
android/
├── settings.gradle.kts
├── build.gradle.kts
├── gradle.properties
└── app/
    ├── build.gradle.kts        # syncWebAssets 将根目录前端资源复制进 APK
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/sapgir-shim.js
        ├── java/com/sapgir/app/MainActivity.kt
        └── res/                # 主题、启动图标
```
