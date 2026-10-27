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
// Repo constants (release/constants.json): the VAPID public key baked into the clients.
@Suppress("UNCHECKED_CAST")
val repoConstants = rootProject.file("../../release/constants.json").takeIf { it.isFile }
    ?.let { JsonSlurper().parse(it) as Map<String, Any?> } ?: emptyMap()

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
        buildConfigField("String", "VAPID_PUBLIC_KEY", "\"${repoConstants["vapid_public_key"] ?: ""}\"")
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"${project.findProperty("pusharmor.googleWebClientId") ?: "PLACEHOLDER_GOOGLE_WEB_CLIENT_ID"}\"")
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
val releaseVapidKey = repoConstants["vapid_public_key"]?.toString() ?: ""
val releaseGoogleClientId = (project.findProperty("pusharmor.googleWebClientId") ?: "PLACEHOLDER_GOOGLE_WEB_CLIENT_ID").toString()
val googleServicesFile = file("src/play/google-services.json")
fun releaseValueProblems(play: Boolean): List<String> {
    val bad = mutableListOf<String>()
    fun check(name: String, v: String) {
        if (v.isBlank() || v.contains("placeholder", ignoreCase = true)) bad += "$name is empty or a PLACEHOLDER"
    }
    check("release/constants.json vapid_public_key (BuildConfig.VAPID_PUBLIC_KEY)", releaseVapidKey)
    check("gradle property pusharmor.googleWebClientId (BuildConfig.GOOGLE_WEB_CLIENT_ID)", releaseGoogleClientId)
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
