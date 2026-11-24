package com.pusharmor.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import java.io.File

/** Loads tests/vectors/file-v1.json (path from the "pusharmor.filevectors" system property). */
object FileVectors {
    val file: File = File(System.getProperty("pusharmor.filevectors") ?: "../../tests/vectors/file-v1.json")

    val root: JsonObject by lazy {
        assertTrue("file vector file missing: $file", file.isFile)
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    fun section(name: String): JsonObject = root[name]!!.jsonObject

    fun cases(name: String): List<JsonObject> = section(name)["cases"]!!.jsonArray.map { it.jsonObject }
}
