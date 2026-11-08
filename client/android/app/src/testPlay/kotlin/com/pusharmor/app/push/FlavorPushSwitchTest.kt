package com.pusharmor.app.push

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A switch from UnifiedPush back to Google drops the "no UnifiedPush app" flag, so the cannot-receive card goes away. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class FlavorPushSwitchTest {
    private val savedInit = FlavorPush.autoInit
    private val savedFetch = FlavorPush.fetchToken
    private val savedInstalled = UnifiedPushSupport.installed
    @After fun restore() { FlavorPush.autoInit = savedInit; FlavorPush.fetchToken = savedFetch; UnifiedPushSupport.installed = savedInstalled }

    private val app = ApplicationProvider.getApplicationContext<PaApp>()

    private fun setUp() {
        FlavorPush.autoInit = { }
        FlavorPush.fetchToken = { cb -> cb("token-1") }
        UnifiedPushSupport.installed = { emptyList() }
        val s = app.graph.settings
        // Same token as before the switch to UnifiedPush.
        s.set(Settings.K.PUSH_TOKEN, "token-1")
        s.set(Settings.K.PUSH_TYPE, "unifiedpush")
        s.set(Settings.K.BANNER, "no_distributor")
    }

    @Test fun switchToGoogleClearsTheCard() {
        setUp()
        val s = app.graph.settings
        assert(UnifiedPushSupport.noPushApp(app, s.get(Settings.K.PUSH_TYPE), playServices = true))
        FlavorPush(app).switchToGoogle(app.graph)
        assertNull(s.get(Settings.K.BANNER))
        assertEquals("fcm", s.get(Settings.K.PUSH_TYPE))
        assertFalse(UnifiedPushSupport.noPushApp(app, s.get(Settings.K.PUSH_TYPE), playServices = true))
    }

    /** The switch to Google sends the token even when it equals the one stored before the switch. */
    @Test fun switchToGoogleSendsAnEqualToken() {
        setUp()
        val wm = androidx.work.WorkManager.getInstance(app)
        wm.cancelUniqueWork("push-patch").result.get(); wm.pruneWork().result.get()
        FlavorPush(app).switchToGoogle(app.graph)
        assertEquals("token-1", app.graph.settings.get(Settings.K.PUSH_TOKEN))
        assertFalse(wm.getWorkInfosForUniqueWork("push-patch").get().isEmpty())
    }

    /** A Google token that cannot be fetched on the switch to Google says the setting could not be changed. */
    @Test fun failedTokenFetchOnSwitchSaysSo() {
        setUp()
        FlavorPush.fetchToken = savedFetch
        val savedTask = FlavorPush.tokenTask
        FlavorPush.tokenTask = { com.google.android.gms.tasks.Tasks.forException(java.io.IOException("SERVICE_NOT_AVAILABLE")) }
        try {
            val vm = com.pusharmor.app.ui.AppViewModel(app)
            vm.choosePush(com.pusharmor.app.ui.PUSH_GOOGLE)
            val end = System.currentTimeMillis() + 5000
            while (vm.message.value == null && System.currentTimeMillis() < end) { Thread.sleep(20); org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle() }
            assertEquals(com.pusharmor.net.ErrorText.text(com.pusharmor.app.ui.UiText.UNABLE_CHANGE_SETTING, com.pusharmor.net.ErrorText.TRY_AGAIN), vm.message.value)
        } finally { FlavorPush.tokenTask = savedTask }
    }

    /** A failed switch to Google keeps UnifiedPush as the method shown, so picking Google again tries again. */
    @Test fun failedSwitchKeepsUnifiedPushShown() {
        setUp()
        val s = app.graph.settings
        s.set(Settings.K.UP_ENDPOINT, "https://up.example/x")
        var tries = 0
        FlavorPush.fetchToken = { cb -> tries++; if (tries == 1) throw java.io.IOException("SERVICE_NOT_AVAILABLE") else cb("token-2") }
        try { FlavorPush(app).switchToGoogle(app.graph); org.junit.Assert.fail("no error") } catch (e: java.io.IOException) { }
        assertEquals("unifiedpush", s.get(Settings.K.PUSH_TYPE))
        assertEquals("https://up.example/x", s.get(Settings.K.UP_ENDPOINT))
        assertEquals("up.app", com.pusharmor.app.ui.pushCurrent(s.get(Settings.K.PUSH_TYPE), true, "up.app"))
        FlavorPush(app).switchToGoogle(app.graph)
        assertEquals(2, tries)
        assertEquals("fcm", s.get(Settings.K.PUSH_TYPE))
        assertEquals("token-2", s.get(Settings.K.PUSH_TOKEN))
    }

    @Test fun tokenOnOpenClearsAStaleFlag() {
        setUp()
        val s = app.graph.settings
        s.set(Settings.K.PUSH_TYPE, null)
        FlavorPush(app).onToken(app.graph, "token-1")
        assertNull(s.get(Settings.K.BANNER))
        assertEquals("fcm", s.get(Settings.K.PUSH_TYPE))
    }

    /** No Google token at app start: the cannot-receive card says so; a token later clears it. */
    @Test fun failedTokenAtStartSaysSo() {
        setUp()
        val s = app.graph.settings
        s.set(Settings.K.PUSH_TYPE, "fcm")
        val savedTask = FlavorPush.tokenTask
        try {
            FlavorPush.tokenTask = { com.google.android.gms.tasks.Tasks.forException(java.io.IOException("SERVICE_NOT_AVAILABLE")) }
            FlavorPush(app).start(app.graph)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            assertEquals("fcm_token", s.get(Settings.K.PUSH_SETUP))
            FlavorPush.tokenTask = { com.google.android.gms.tasks.Tasks.forResult("token-2") }
            FlavorPush(app).start(app.graph)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            assertNull(s.get(Settings.K.PUSH_SETUP))
        } finally { FlavorPush.tokenTask = savedTask; s.set(Settings.K.PUSH_SETUP, null) }
    }

    /** Check again on a push setup error waits for the retry: a token says nothing, a second failure says still. */
    @Test fun checkAgainWaitsForTheSetupRetry() {
        setUp()
        val s = app.graph.settings
        s.set(Settings.K.PUSH_TYPE, "fcm")
        val savedTask = FlavorPush.tokenTask
        fun tap(vm: com.pusharmor.app.ui.AppViewModel) {
            vm.checkAgain(local = true)
            val end = System.currentTimeMillis() + 5000
            while ((vm.busy.value || "check" in vm.running.value) && System.currentTimeMillis() < end) { Thread.sleep(20); org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle() }
            Thread.sleep(50); org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        }
        try {
            val vm = com.pusharmor.app.ui.AppViewModel(app)
            s.set(Settings.K.PUSH_SETUP, "fcm_token")
            FlavorPush.tokenTask = { com.google.android.gms.tasks.Tasks.forException(java.io.IOException("SERVICE_NOT_AVAILABLE")) }
            tap(vm)
            assertEquals(com.pusharmor.app.ui.UiText.CHECK_STILL, vm.message.value)
            vm.message.value = null
            FlavorPush.tokenTask = { com.google.android.gms.tasks.Tasks.forResult("token-3") }
            vm.coolTaps.value = emptyMap() // past the 10 s grey time
            tap(vm)
            assertNull(vm.message.value)
            assertNull(s.get(Settings.K.PUSH_SETUP))
        } finally { FlavorPush.tokenTask = savedTask; s.set(Settings.K.PUSH_SETUP, null) }
    }
}
