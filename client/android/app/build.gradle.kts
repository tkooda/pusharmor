import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Version: committed release/version.properties (CI asserts it equals the android-v tag).
val versionProps = Properties().apply {
    rootProject.file("../../release/version.properties").inputStream().use { load(it) }
}
// Public build ids from the tracked release/public.json (meanings in release/names.json
// "public_keys"). Debug builds work with its placeholders; release builds fail on them.
@Suppress("UNCHECKED_CAST")
val publicValues = JsonSlurper().parse(rootProject.file("../../release/public.json")) as Map<String, Any?>
fun publicValue(key: String) = publicValues[key]?.toString() ?: ""
// Baked into each flavor: foss gets no Google or Firebase value.
val fossKeys = listOf("webpush_vapid_public_key")
val playKeys = fossKeys + listOf(
    "google_web_client_id",
    "google_fcm_android_app_id", "google_fcm_project_number", "google_fcm_android_api_key", "google_fcm_project_id",
)

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
        // A placeholder bakes in "" (UnifiedPush registers without a VAPID key).
        val vapid = publicValue("webpush_vapid_public_key").takeUnless { it.contains("placeholder", ignoreCase = true) } ?: ""
        buildConfigField("String", "VAPID_PUBLIC_KEY", "\"$vapid\"")
    }

    flavorDimensions += "dist"
    productFlavors {
        create("play") {
            dimension = "dist"
            buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"${publicValue("google_web_client_id")}\"")
            // The Firebase options FirebaseInitProvider reads (FirebaseOptions.fromResource).
            resValue("string", "google_app_id", publicValue("google_fcm_android_app_id"))
            resValue("string", "gcm_defaultSenderId", publicValue("google_fcm_project_number"))
            resValue("string", "google_api_key", publicValue("google_fcm_android_api_key"))
            resValue("string", "project_id", publicValue("google_fcm_project_id"))
        }
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

// Release gate: a release assemble or bundle fails while a value it bakes in is empty or a
// PLACEHOLDER, or a CI dummy (release/ci-dummy.mjs) without PA_CI_DUMMY=1. Debug builds are unaffected.
val ciDummyAllowed = System.getenv("PA_CI_DUMMY") == "1"
fun releaseValueProblems(play: Boolean): List<String> = (if (play) playKeys else fossKeys).mapNotNull { k ->
    val v = publicValue(k)
    when {
        v.isBlank() -> "release/public.json $k is missing or empty"
        v.contains("placeholder", ignoreCase = true) -> "release/public.json $k is a PLACEHOLDER"
        v.contains("ci-fork-dummy", ignoreCase = true) && !ciDummyAllowed ->
            "release/public.json $k is a CI dummy (allowed only with PA_CI_DUMMY=1)"
        else -> null
    }
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
