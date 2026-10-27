import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.google.services)
}

// Version: committed release/version.properties (CI asserts it equals the android-v tag).
val versionProps = Properties().apply {
    rootProject.file("../../release/version.properties").inputStream().use { load(it) }
}
// Build ids from the git-ignored release/local.json (template release/local.example.json,
// key names in release/names.json). Debug builds work without it; release builds fail.
val localJson = rootProject.file("../../release/local.json")
@Suppress("UNCHECKED_CAST")
val localValues = localJson.takeIf { it.isFile }
    ?.let { JsonSlurper().parse(it) as Map<String, Any?> } ?: emptyMap()
val localVapidKey = "vapid_public_key"
val localGoogleWebClientId = "google_web_client_id"

android {
    namespace = "com.pusharmor.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pusharmor"
        minSdk = 31
        targetSdk = 35
        versionCode = versionProps.getProperty("versionCode").toInt()
        versionName = versionProps.getProperty("versionName")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "API_BASE", "\"https://api.pusharmor.com\"")
        buildConfigField("String", "VAPID_PUBLIC_KEY", "\"${localValues[localVapidKey] ?: ""}\"")
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"${localValues[localGoogleWebClientId] ?: "PLACEHOLDER_GOOGLE_WEB_CLIENT_ID"}\"")
    }

    flavorDimensions += "dist"
    productFlavors {
        create("play") { dimension = "dist" }
        create("foss") { dimension = "dist" }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Reproducible foss builds: no VCS info, no build-time stamps.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    testOptions { unitTests.isIncludeAndroidResources = true }
}

// foss has no google-services.json; the plugin only does work for play variants.
googleServices {
    missingGoogleServicesStrategy = com.google.gms.googleservices.GoogleServicesPlugin.MissingGoogleServicesStrategy.IGNORE
}

// Release gate: a release assemble or bundle fails while a PLACEHOLDER or empty value is baked in.
// Debug builds are unaffected.
// The real google-services.json is git-ignored in src/play/ and wins over the committed
// placeholder in src/playDebug/, which only debug builds can use.
val releaseVapidKey = localValues[localVapidKey]?.toString() ?: ""
val releaseGoogleClientId = localValues[localGoogleWebClientId]?.toString() ?: ""
val googleServicesFile = file("src/play/google-services.json")
fun releaseValueProblems(play: Boolean): List<String> {
    val bad = mutableListOf<String>()
    fun check(name: String, v: String) {
        if (v.isBlank() || v.contains("placeholder", ignoreCase = true)) bad += "$name is empty or a PLACEHOLDER"
    }
    if (!localJson.isFile) bad += "release/local.json is missing; copy release/local.example.json and fill it"
    check("release/local.json $localVapidKey (BuildConfig.VAPID_PUBLIC_KEY)", releaseVapidKey)
    check("release/local.json $localGoogleWebClientId (BuildConfig.GOOGLE_WEB_CLIENT_ID)", releaseGoogleClientId)
    if (play) {
        if (!googleServicesFile.isFile) bad += "app/src/play/google-services.json is missing"
        else if (googleServicesFile.readText().contains("placeholder", ignoreCase = true)) {
            bad += "app/src/play/google-services.json contains PLACEHOLDER values"
        }
    }
    return bad
}
for (flavor in listOf("Play", "Foss")) {
    tasks.register("checkRelease${flavor}Values") {
        group = "verification"
        description = "Fails when a release value is a PLACEHOLDER or empty."
        val play = flavor == "Play"
        doLast {
            val bad = releaseValueProblems(play)
            if (bad.isNotEmpty()) {
                throw GradleException("release values not set:\n  - " + bad.joinToString("\n  - "))
            }
        }
    }
}
tasks.configureEach {
    val m = Regex("^(?:assemble|bundle|package)(Play|Foss)?Release(?:Bundle)?$").matchEntire(name) ?: return@configureEach
    val only = m.groupValues[1]
    for (f in listOf("Play", "Foss")) if (only.isEmpty() || only == f) dependsOn("checkRelease${f}Values")
}

dependencies {
    implementation(project(":net"))
    implementation(project(":store"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.webkit)
    implementation(libs.unifiedpush.connector)
    implementation(libs.kotlinx.coroutines.core)

    // play flavor only: Firebase Cloud Messaging and Google sign-in through Play services.
    "playImplementation"(platform(libs.firebase.bom))
    "playImplementation"(libs.firebase.messaging)
    "playImplementation"(libs.play.services.base)
    "playImplementation"(libs.androidx.credentials)
    "playImplementation"(libs.androidx.credentials.play.services.auth)
    "playImplementation"(libs.googleid)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(testFixtures(project(":crypto")))
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(testFixtures(project(":crypto")))
}
