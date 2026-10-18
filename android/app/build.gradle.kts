import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The Chrome extension is the single source of truth for the web UI. The whole
// repo root is copied into the APK at build time, so there is no second copy
// of app.html / js / styles to keep in sync.
val webRoot: File = rootProject.projectDir.parentFile
val webManifest = JsonSlurper().parse(File(webRoot, "manifest.json")) as Map<*, *>
val webVersion = webManifest["version"] as String
val webVersionCode = webVersion.split(".").let { parts ->
    (parts.getOrNull(0)?.toIntOrNull() ?: 1) * 10_000 +
        (parts.getOrNull(1)?.toIntOrNull() ?: 0) * 100 +
        (parts.getOrNull(2)?.toIntOrNull() ?: 0)
}

android {
    namespace = "com.sapgir.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sapgir.app"
        minSdk = 29
        targetSdk = 35
        versionCode = webVersionCode
        versionName = webVersion
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

/** Copy the extension sources into the APK assets without duplicating them in git. */
val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    from(webRoot) {
        include(
            "app.html",
            "assets/**",
            "js/**",
            "styles/**",
            "vendor/**",
        )
        exclude("assets/icon256.png", "assets/icon512.png")
    }
    into(layout.buildDirectory.dir("generated/webAssets"))
}

tasks.named("preBuild").configure { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
