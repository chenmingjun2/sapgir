# Keep the JavaScript bridge: methods are resolved by name at runtime.
-keepclassmembers class com.sapgir.app.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
