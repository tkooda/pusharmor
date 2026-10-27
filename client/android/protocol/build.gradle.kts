plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(project(":crypto"))
    testImplementation(libs.junit)
    testImplementation(testFixtures(project(":crypto")))
}

tasks.test {
    systemProperty("pusharmor.golden", rootProject.file("../../tests/vectors/golden-v1.json").absolutePath)
}
