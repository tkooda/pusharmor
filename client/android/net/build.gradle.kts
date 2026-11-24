plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":protocol"))
    api(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(testFixtures(project(":crypto")))
}

tasks.test {
    systemProperty("pusharmor.golden", rootProject.file("../../tests/vectors/golden-v1.json").absolutePath)
    systemProperty("pusharmor.filevectors", rootProject.file("../../tests/vectors/file-v1.json").absolutePath)
}
