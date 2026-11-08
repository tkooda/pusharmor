package com.pusharmor.app.work

import androidx.test.core.app.ApplicationProvider
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.store.HistoryEntity
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger

/** The daily job is local only: it purges old history and makes no relay server call. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class DailyWorkTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val calls = AtomicInteger()

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        g.settings.clearKeepingOldId()
        g.keysOrNull = KeystoreKeyOps.createFresh()
        g.dao.putSelf(SelfEntity(id = "B".repeat(40), accountPrefix = ByteArray(9), name = "t"))
        g.settings.set(Settings.K.PUSH_TYPE, "unifiedpush") // no UnifiedPush app saved: a distributor check would set a banner
        app.fakeHttp = Interceptor { calls.incrementAndGet(); throw java.io.IOException("offline") }
        WorkManager.getInstance(app).cancelAllWork().result.get(); Unit
    }

    @After fun done() = io {
        app.fakeHttp = null
        g.store.wipeRegistration()
        g.settings.clearKeepingOldId()
        FakeAndroidKeyStore.remove()
    }

    @Test fun dailyIsLocalOnly() {
        val old = io { g.dao.insertHistory(HistoryEntity(direction = "in", peerId = null, type = "text", content = "x", n = null,
            pairingId = null, at = 1, read = true, results = "", count = 1)) }
        io { Work.daily(g) }
        assertNull(io { g.dao.history(old) })
        assertEquals(0, calls.get())
        assertNull(g.settings.get(Settings.K.BANNER))
        val reconcile = WorkManager.getInstance(app).getWorkInfosForUniqueWork("allow-reconcile").get()
        assertTrue(reconcile.none { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING })
    }
}
