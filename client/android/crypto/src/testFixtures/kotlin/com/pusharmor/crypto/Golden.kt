package com.pusharmor.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertTrue
import java.io.File

/** Loads tests/vectors/golden-v1.json (path from the "pusharmor.golden" system property). */
object Golden {
    val file: File = File(System.getProperty("pusharmor.golden") ?: "../../tests/vectors/golden-v1.json")

    val root: JsonObject by lazy {
        assertTrue("golden vector file missing: $file", file.isFile)
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    fun section(name: String): JsonObject = root[name]!!.jsonObject

    fun cases(name: String): List<JsonObject> = section(name)["cases"]!!.jsonArray.map { it.jsonObject }

    fun peer(name: String): JsonObject = section("keys")["peers"]!!.jsonObject[name]!!.jsonObject

    fun keysOf(name: String): SoftwareKeyOps {
        val p = peer(name)
        return SoftwareKeyOps.fromPrivate(B64url.decode(p.str("sign_priv")), B64url.decode(p.str("enc_priv")))
    }
}

fun JsonObject.str(k: String): String = this[k]!!.jsonPrimitive.content
fun JsonObject.strOrNull(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
fun JsonObject.bool(k: String): Boolean = this[k]!!.jsonPrimitive.content.toBoolean()
fun JsonObject.long(k: String): Long = this[k]!!.jsonPrimitive.content.toLong()
fun JsonObject.obj(k: String): JsonObject? = this[k] as? JsonObject
fun JsonObject.arr(k: String): JsonArray = this[k]!!.jsonArray
fun JsonElement.b64(): ByteArray = B64url.decode(jsonPrimitive.content)
