package com.sapgir.app

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/**
 * Single-activity WebView shell around the Sapgir extension UI.
 *
 * The web sources are packaged as assets and served through
 * WebViewAssetLoader on an https://appassets.androidplatform.net origin, which
 * gives us a secure context (clipboard, IndexedDB, service-worker-free fetch)
 * without enabling file:// access.
 */
class MainActivity : ComponentActivity() {

    companion object {
        private const val TAG = "Sapgir"
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$APP_HOST/assets/app.html"
        private const val DOWNLOAD_DIR = "Sapgir"
    }

    private lateinit var webView: WebView
    private lateinit var rootView: FrameLayout
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/res/", WebViewAssetLoader.ResourcesPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        val background = if (dark) Color.parseColor("#131417") else Color.WHITE

        val root = FrameLayout(this).apply { setBackgroundColor(background) }
        rootView = root
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime()
            )
            view.updatePadding(
                left = bars.left,
                top = bars.top,
                right = bars.right,
                bottom = bars.bottom,
            )
            insets
        }
        setContentView(root)

        webView = WebView(this).apply { setBackgroundColor(background) }
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        WindowInsetsControllerCompat(window, webView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        window.isNavigationBarContrastEnforced = false

        registerFileChooser()

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            useWideViewPort = true
            loadWithOverviewMode = false
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
        }

        webView.addJavascriptInterface(Bridge(), "SapgirAndroid")
        WebView.setWebContentsDebuggingEnabled(
            (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        )

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                // Inject the Android shim into app.html before any module runs.
                // Doing it here (instead of a WebView feature API) keeps working
                // on older, never-updated WebView builds.
                if (request.url.host == APP_HOST && request.url.path == "/assets/app.html") {
                    val html = assets.open("app.html").bufferedReader().use { it.readText() }
                    val injected = html.replaceFirst(
                        "<head>",
                        "<head>\n    <script src=\"sapgir-shim.js\"></script>",
                    )
                    return WebResourceResponse(
                        "text/html",
                        "utf-8",
                        injected.byteInputStream(Charsets.UTF_8),
                    )
                }
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                if (request.url.host == APP_HOST) return false
                return openExternal(request.url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                // The shim reads the bridge on boot, but a reload or a missed
                // configuration change can leave it stale; push the current
                // system mode once the page is ready.
                notifyWebTheme(systemIsDark())
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    fileChooserLauncher.launch(buildFileChooserIntent(params))
                    true
                } catch (err: Exception) {
                    Log.e(TAG, "file chooser failed", err)
                    fileChooserCallback = null
                    callback.onReceiveValue(null)
                    false
                }
            }
        }

        registerBackHandler()
        webView.loadUrl(START_URL)
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        notifyWebTheme(systemIsDark())
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val dark = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        val background = if (dark) Color.parseColor("#131417") else Color.WHITE
        rootView.setBackgroundColor(background)
        webView.setBackgroundColor(background)
        WindowInsetsControllerCompat(window, webView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        notifyWebTheme(dark)
    }

    override fun onDestroy() {
        (webView.parent as? FrameLayout)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    private fun registerBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    """
                    (function () {
                      var dialog = document.querySelector('dialog[open]');
                      if (dialog) { dialog.close(); return 'dialog'; }
                      var app = document.getElementById('app');
                      if (app && app.classList.contains('sidebar-open')) {
                        var backdrop = document.getElementById('sidebar-backdrop');
                        if (backdrop) backdrop.click();
                        return 'sidebar';
                      }
                      return '';
                    })()
                    """.trimIndent()
                ) { result ->
                    when {
                        !result.isNullOrBlank() && result.trim('"').isNotEmpty() -> Unit
                        webView.canGoBack() -> webView.goBack()
                        else -> finish()
                    }
                }
            }
        })
    }

    private fun registerFileChooser() {
        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val callback = fileChooserCallback
            fileChooserCallback = null
            if (callback == null) return@registerForActivityResult
            if (result.resultCode != RESULT_OK) {
                callback.onReceiveValue(null)
                return@registerForActivityResult
            }
            val data = result.data
            val uris = ArrayList<Uri>()
            val clip = data?.clipData
            if (clip != null) {
                for (index in 0 until clip.itemCount) {
                    clip.getItemAt(index)?.uri?.let { uris.add(it) }
                }
            } else {
                data?.data?.let { uris.add(it) }
            }
            callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        }
    }

    private fun buildFileChooserIntent(params: WebChromeClient.FileChooserParams): Intent {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }

        val mimeTypes = params.acceptTypes
            .flatMap { it.split(',') }
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .mapNotNull(::normalizeMimeType)
            .distinct()

        when {
            mimeTypes.isEmpty() -> intent.type = "*/*"
            mimeTypes.size == 1 -> intent.type = mimeTypes.first()
            else -> {
                intent.type = "*/*"
                intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
            }
        }
        return intent
    }

    private fun normalizeMimeType(entry: String): String? = when {
        entry.contains('/') -> entry
        entry.startsWith(".") -> MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(entry.removePrefix(".").lowercase())
        else -> null
    }

    private fun openExternal(uri: Uri): Boolean {
        if (uri.scheme !in setOf("http", "https", "mailto")) return false
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (err: Exception) {
            Log.w(TAG, "no activity for $uri", err)
            false
        }
    }

    private fun toast(message: String) {
        runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
    }

    private fun systemIsDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    /**
     * Push the current system day/night mode into the page. The page only
     * applies it when the user's theme setting is "auto"; explicit light/dark
     * choices keep priority.
     */
    private fun notifyWebTheme(dark: Boolean) {
        webView.evaluateJavascript(
            "window.__sapgirSetSystemTheme && window.__sapgirSetSystemTheme($dark);",
            null,
        )
    }

    /**
     * Export bridge: `<a download>` + blob URLs do not work in WebView, so the
     * page hands exported Markdown/JSON over to MediaStore instead.
     */
    inner class Bridge {
        /**
         * Read by sapgir-shim.js on boot so the first render already uses the
         * system day/night mode.
         */
        @JavascriptInterface
        fun isSystemDark(): Boolean = try {
            systemIsDark()
        } catch (_: Exception) {
            false
        }

        /**
         * Called by sapgir-shim.js whenever the page theme changes. The app
         * theme is independent from the system uiMode, so status/navigation
         * bar icon colors must follow the page instead of the configuration.
         */
        @JavascriptInterface
        fun setTheme(dark: Boolean) {
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                val background = if (dark) Color.parseColor("#131417") else Color.WHITE
                rootView.setBackgroundColor(background)
                webView.setBackgroundColor(background)
                WindowInsetsControllerCompat(window, webView).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
        }

        @JavascriptInterface
        fun saveFile(fileName: String, mimeType: String, content: String): Boolean {
            return try {
                val name = sanitizeFileName(fileName)
                val mime = mimeType.substringBefore(';').trim()
                    .ifBlank { "application/octet-stream" }
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(
                        MediaStore.MediaColumns.RELATIVE_PATH,
                        "${Environment.DIRECTORY_DOWNLOADS}/$DOWNLOAD_DIR",
                    )
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val resolver = contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                if (uri == null) {
                    toast("保存失败：无法创建文件")
                    return false
                }
                val stream = resolver.openOutputStream(uri)
                if (stream == null) {
                    resolver.delete(uri, null, null)
                    toast("保存失败：无法写入文件")
                    return false
                }
                stream.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                toast("已保存到 下载/$DOWNLOAD_DIR/$name")
                true
            } catch (err: Exception) {
                Log.e(TAG, "saveFile failed", err)
                toast("保存失败：${err.message ?: "未知错误"}")
                false
            }
        }
    }

    private fun sanitizeFileName(name: String): String {
        val cleaned = name
            .replace('/', '_')
            .replace('\\', '_')
            .replace("\u0000", "")
            .trim()
            .ifEmpty { "sapgir-export.txt" }
        return if (cleaned.startsWith('.')) "sapgir-$cleaned" else cleaned
    }
}
