package com.pusharmor.protocol

import com.pusharmor.crypto.Golden
import com.pusharmor.crypto.str
import com.pusharmor.crypto.strOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** tests/vectors/golden-v1.json "device_name": every case of the four lists through the production name rule. */
class GoldenDeviceNameTest {
    private fun list(name: String) = Golden.section("device_name")[name]!!.jsonArray.map { it.jsonObject }

    @Test fun inputCases() {
        val cases = list("input_cases")
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val r = DeviceName.check(c.str("input"))
            assertEquals(c.str("input"), c.strOrNull("error"), r.error)
            assertEquals(c.str("input"), c.strOrNull("name"), r.name)
            assertEquals(c.str("input"), c.strOrNull("error"), DeviceName.inputError(c.str("input")))
        }
    }

    @Test fun defaultCases() {
        val cases = list("default_cases")
        assertTrue(cases.isNotEmpty())
        for (c in cases) assertEquals(c.str("input"), c.str("name"), DeviceName.setupDefault(c.str("input")))
    }

    @Test fun displayCases() {
        val cases = list("display_cases")
        assertTrue(cases.isNotEmpty())
        for (c in cases) assertEquals(c.str("input"), c.str("shown"), DeviceName.display(c.str("input")))
    }

    @Test fun clashCases() {
        val cases = list("clash_cases")
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val taken = c["taken"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(c.str("base"), c.str("name"), DeviceName.unique(c.str("base"), taken))
        }
    }
}
