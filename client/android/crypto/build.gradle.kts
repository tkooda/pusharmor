plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-test-fixtures`
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    testImplementation(libs.junit)
    testFixturesApi(libs.junit)
    testFixturesApi(libs.kotlinx.serialization.json)
}

tasks.test {
    // The golden cross-platform vector file lives at the repo root (tests/vectors).
    systemProperty("pusharmor.golden", rootProject.file("../../tests/vectors/golden-v1.json").absolutePath)
}
