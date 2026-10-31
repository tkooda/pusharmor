package com.pusharmor.app.ui

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlinx.coroutines.runBlocking
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A failing tap handler shows a message instead of crashing the app (I547). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class AppViewModelTest {
    @Volatile private var uncaught: Throwable? = null
    private var old: Thread.UncaughtExceptionHandler? = null

    @Before fun catchUncaught() { old = Thread.getDefaultUncaughtExceptionHandler(); Thread.setDefaultUncaughtExceptionHandler { _, e -> uncaught = e } }
    @After fun restore() { Thread.setDefaultUncaughtExceptionHandler(old) }

    private fun vm() = AppViewModel(ApplicationProvider.getApplicationContext<PaApp>())

    private fun waitFor(cond: () -> Boolean) {
        val end = System.currentTimeMillis() + 5000
        while (!cond() && System.currentTimeMillis() < end) { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle() }
    }

    @Test fun ioErrorSetsMessage() {
        val vm = vm()
        val job = vm.io { throw IllegalStateException("boom") }
        waitFor { job.isCompleted }
        assertNull(uncaught)
        assertFalse(vm.busy.value)
        assertEquals(AppViewModel.NOT_DONE, vm.message.value)
    }

    @Test fun onceErrorReleasesKey() {
        val vm = vm()
        vm.once("send") { throw IllegalStateException("boom") }
        waitFor { vm.running.value.isEmpty() && vm.message.value != null }
        assertNull(uncaught)
        assertEquals(emptySet<String>(), vm.running.value)
        assertEquals(AppViewModel.NOT_DONE, vm.message.value)
    }

    /** Robolectric has no AndroidKeyStore, so key generation fails as a broken Keystore would (I549). */
    @Test fun keystoreFailureInSignInShowsMessage() {
        val vm = vm()
        vm.g.keysOrNull = null
        assertNull(runBlocking { vm.oauthUrl("apple", "register") })
        assertNull(runBlocking { vm.nonce("register") })
        assertNull(uncaught)
        assertEquals(AppViewModel.NOT_DONE, vm.message.value)
    }
}
