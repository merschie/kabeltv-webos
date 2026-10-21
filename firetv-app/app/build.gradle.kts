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
        versionCode = 6
        versionName = "0.4.2"

        // Adresse im Heimnetz, lässt sich in den Einstellungen ändern
        buildConfigField("String", "FRITZ_HOST", "\"192.168.177.1\"")
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

    // Senderlogos aus der webOS-App mitbenutzen statt sie doppelt im Repo zu halten
    sourceSets["main"].assets.srcDir("build/generated/logos")

    lint {
        // Zurück kommt auf dem Fire TV als Taste der Fernbedienung, nicht als Wischgeste
        disable += "GestureBackNavigation"
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

val copyLogos by tasks.registering(Sync::class) {
    from(rootProject.file("../webos-app/logos"))
    into("build/generated/logos/logos")
}
tasks.named("preBuild") { dependsOn(copyLogos) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.extractor)
    implementation(libs.media3.ui)

    testImplementation(libs.junit)
}
