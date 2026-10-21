plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "de.local.kabeltv"
    compileSdk = 36

    defaultConfig {
        applicationId = "de.local.kabeltv"
        // Fire OS 5 (Fire TV Stick 1./2. Gen.) entspricht API 22
        minSdk = 22
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0"

        // Adressen im Heimnetz, lassen sich später in den Einstellungen ändern
        buildConfigField("String", "FRITZ_HOST", "\"192.168.177.1\"")
        buildConfigField("String", "PROXY_URL", "\"http://192.168.177.80:8095\"")
    }

    // Fester Debug-Schlüssel im Repo, damit CI-Builds und lokale Builds sich gegenseitig
    // aktualisieren lassen, ohne die App vorher zu deinstallieren
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Zum Sideloaden reicht die Debug-Signatur
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.extractor)
    implementation(libs.media3.ui)
}
