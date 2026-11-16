package com.pusharmor.app.session

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Renaming this device to its current name does nothing: no relay server call, so no device shows a rename. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class SessionRenameTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private var calls = 0
    private var code = 200
    private var boom = false

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "Phone"))
        app.fakeHttp = Interceptor { chain ->
            calls++
            if (boom) throw IllegalStateException("transport failed")
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body("{}".toResponseBody("application/json".toMediaType())).build()
        }
    }

    @After fun done() = io {
        app.fakeHttp = null
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    @Test fun sameNameMakesNoCall() {
        assertNull(io { g.session.rename("Phone") })
        assertEquals(0, calls)
        assertEquals("Phone", io { g.dao.self()!!.name })
    }

    @Test fun newNameIsSent() {
        io { g.session.rename("Tablet") }
        assertEquals(1, calls)
        assertEquals("Tablet", io { g.dao.self()!!.name })
    }

    @Test fun failedRenameKeepsOldNameAndRetrySends() {
        code = 400
        assertNotNull(io { g.session.rename("Tablet") })
        assertEquals("Phone", io { g.dao.self()!!.name })
        code = 200
        val before = calls
        assertNull(io { g.session.rename("Tablet") })
        assertEquals(before + 1, calls)
        assertEquals("Tablet", io { g.dao.self()!!.name })
    }

    @Test fun thrownRenameKeepsOldNameAndRetrySends() {
        boom = true
        try { io { g.session.rename("Tablet") }; org.junit.Assert.fail("expected a throw") } catch (e: IllegalStateException) { }
        assertEquals("Phone", io { g.dao.self()!!.name })
        boom = false
        val before = calls
        assertNull(io { g.session.rename("Tablet") })
        assertEquals(before + 1, calls)
        assertEquals("Tablet", io { g.dao.self()!!.name })
    }
}
