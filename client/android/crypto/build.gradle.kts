plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-test-fixtures`
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(libs.bouncycastle.bcprov)
    testImplementation(libs.junit)
    testFixturesApi(libs.junit)
    testFixturesApi(libs.kotlinx.serialization.json)
}

tasks.test {
    // The golden cross-platform vector file lives at the repo root (tests/vectors).
    systemProperty("pusharmor.golden", rootProject.file("../../tests/vectors/golden-v1.json").absolutePath)
    systemProperty("pusharmor.filevectors", rootProject.file("../../tests/vectors/file-v1.json").absolutePath)
}
