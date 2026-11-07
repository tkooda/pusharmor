package com.pusharmor.app.session

import androidx.test.core.app.ApplicationProvider
import com.pusharmor.app.FakeAndroidKeyStore
import com.pusharmor.app.PaApp
import com.pusharmor.app.TestApp
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.crypto.B64url
import com.pusharmor.crypto.Ids
import com.pusharmor.net.ErrorText
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.engine.ApiResult
import com.pusharmor.store.HistoryEntity
import com.pusharmor.store.SelfEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.KeyStore

/** Several accounts on one device: one active, the others archived by account id with their keys, data, and settings. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestApp::class)
class AccountSwitchTest {
    private val app get() = ApplicationProvider.getApplicationContext<PaApp>() as TestApp
    private val g get() = app.graph
    private val calls = mutableListOf<String>()

    private fun <T> io(block: () -> T): T = runBlocking(Dispatchers.IO) { block() }

    /** Ticket "tA" is for account A, "tB" for account B. */
    private fun prefix(ticket: String) = ByteArray(9) { if (ticket == "tA") 1 else 2 }
    private fun account(ticket: String) = B64url.encode(prefix(ticket))

    private fun reply(chain: Interceptor.Chain, code: Int, body: String): Response =
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x")
            .body(body.toResponseBody("application/json".toMediaType())).build()

    @Before fun setUp() = io {
        FakeAndroidKeyStore.install()
        KeystoreKeyOps.base = KeystoreKeyOps.LEGACY
        g.store.wipeRegistration()
        g.dao.deleteAllHistory()
        g.settings.clearKeepingOldId()
        g.settings.set(Settings.K.KEY_ALIAS, null)
        g.settings.putAccountPrefs(emptyMap())
        val sql = g.db.openHelper.writableDatabase
        val arch = sql.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'arch%'").use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
        for (t in arch) sql.execSQL("DROP TABLE `$t`")
        g.keysOrNull = null
        // A fake relay server: a ticket's account decides the id it registers, and a login with another account's ticket is a mismatch.
        app.fakeHttp = Interceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            calls += "${req.method} $path"
            val body = Buffer().also { req.body?.writeTo(it) }.readUtf8()
            val ticket = Regex("\"ticket\":\"([^\"]*)\"").find(body)?.groupValues?.get(1) ?: ""
            when {
                req.method == "POST" && path == "/v1/peers" -> {
                    val k = g.keysOrNull!!
                    reply(chain, 200, "{\"id\":\"${B64url.encode(prefix(ticket) + Ids.keyhash(k.signPub, k.encPub) + ByteArray(9))}\",\"peers\":[]}")
                }
                path.endsWith("/login") && path.removePrefix("/v1/peers/").take(12) != account(ticket) ->
                    reply(chain, 401, "{\"error\":\"account mismatch\",\"account\":\"${account(ticket)}\"}")
                else -> reply(chain, 200, "{\"r\":{}}")
            }
        }
    }

    @After fun done() {
        app.fakeHttp = null
        KeystoreKeyOps.base = KeystoreKeyOps.LEGACY
        FakeAndroidKeyStore.remove()
    }

    private fun register(ticket: String, email: String): String {
        g.session.keysForSignIn()
        val r = g.session.onTicket(ticket, email)
        assertTrue((r as? Session.SignIn.Error)?.text ?: r.toString(), r is Session.SignIn.Done)
        return g.dao.self()!!.id
    }

    private fun history(text: String) = g.dao.insertHistory(HistoryEntity(direction = "in", peerId = null, type = "text", content = text, n = null,
        pairingId = null, at = System.currentTimeMillis(), read = true, results = "", count = 1))

    private fun historyTexts() = g.dao.newestHistory()?.content

    /** A register, logout, B by email (new keys), logout, A by email: A's keys, id, devices, history, and settings come back; B stays archived. */
    @Test fun emailLoginSwitchesAccountsAndBack() = io {
        assertEquals("register", g.session.prepareEmail("a@x.com"))
        val a = register("tA", "a@x.com")
        val aPub = g.keysOrNull!!.signPub
        g.store.putPeer(Peer(id = "P".repeat(40), name = "Laptop"))
        history("hello A")
        g.settings.set(Settings.K.HISTORY_DAYS, 7)
        g.session.signOut()

        assertEquals("register", g.session.prepareEmail(" B@x.com "))
        assertNull(g.dao.self())
        assertTrue(g.store.peers().isEmpty())
        assertNull(historyTexts())
        assertEquals(30, g.settings.historyDays)
        val b = register("tB", "b@x.com")
        val bPub = g.keysOrNull!!.signPub
        assertNotEquals(a.take(12), b.take(12))
        assertFalse(aPub.contentEquals(bPub))
        history("hello B")
        g.session.signOut()

        assertEquals("login", g.session.prepareEmail("a@x.com"))
        assertEquals(a, g.dao.self()?.id)
        assertArrayEquals(aPub, g.keysOrNull!!.signPub)
        assertEquals(listOf("Laptop"), g.store.peers().map { it.name })
        assertEquals("hello A", historyTexts())
        assertEquals(7, g.settings.historyDays)
        assertEquals(b.take(12), g.slots.accountFor("b@x.com", a.take(12)))
        assertFalse(g.slots.has(a.take(12)))
        assertEquals(Session.Start.SIGNED_OUT, g.session.startup())
        assertArrayEquals(aPub, g.keysOrNull!!.signPub)
        assertTrue(g.session.onTicket("tA", "a@x.com") is Session.SignIn.Done)
        assertEquals(a, g.dao.self()?.id)

        // B is intact in its archive
        g.session.signOut()
        assertEquals("login", g.session.prepareEmail("b@x.com"))
        assertEquals(b, g.dao.self()?.id)
        assertArrayEquals(bPub, g.keysOrNull!!.signPub)
        assertEquals("hello B", historyTexts())
        assertEquals(30, g.settings.historyDays)
    }

    /** A Google login of another account gets 401 "account mismatch": the device switches and says so; the next login works. */
    @Test fun loginMismatchSwitchesAndSecondLoginWorks() = io {
        val a = register("tA", "a@x.com")
        g.session.signOut()

        // B is not on this device: a new empty account
        val r = g.session.onTicket("tB", "b@x.com")
        assertEquals("To finish logging in as \"b@x.com\", log in again.", (r as Session.SignIn.Switched).text)
        assertNull(g.dao.self())
        assertEquals("register", g.session.purposeForSignIn())
        assertTrue(g.slots.has(a.take(12)))
        val b = register("tB", "b@x.com")
        assertEquals(account("tB"), b.take(12))
        g.session.signOut()

        // A is archived: switched in with its keys, and its login works
        val r2 = g.session.onTicket("tA", "a@x.com")
        assertEquals("To finish logging in as \"a@x.com\", log in again.", (r2 as Session.SignIn.Switched).text)
        assertEquals(a, g.dao.self()?.id)
        assertEquals("login", g.session.purposeForSignIn())
        assertTrue(g.session.onTicket("tA", "a@x.com") is Session.SignIn.Done)
        assertEquals(a, g.dao.self()?.id)
        assertTrue(g.slots.has(b.take(12)))

        // a register ticket of an archived account switches to it instead of registering a second device
        g.session.signOut()
        g.session.switchAccount(null)
        val r3 = g.session.onTicket("tB", "b@x.com")
        assertEquals("To finish logging in as \"b@x.com\", log in again.", (r3 as Session.SignIn.Switched).text)
        assertEquals(b, g.dao.self()?.id)
        // any other "account mismatch" reply
        assertEquals("This login is for another account.", ErrorText.reason(ApiResult.Http(401, "account mismatch")))
    }

    /** Data an older version wrote (keys under "pa", no alias, no archive) survives a switch out and back. */
    @Test fun oldLayoutSurvivesSwitchOutAndBack() = io {
        val keys = KeystoreKeyOps.createFresh()
        g.keysOrNull = keys
        val a = B64url.encode(prefix("tA") + ByteArray(21))
        g.dao.putSelf(SelfEntity(id = a, accountPrefix = prefix("tA"), email = "a@x.com", name = "Phone"))
        g.store.putPeer(Peer(id = "P".repeat(40), name = "Laptop"))
        history("hello A")
        g.settings.set(Settings.K.SHOW_CONTENT, false)
        g.settings.set(Settings.K.SIGNED_OUT, true)

        assertEquals("register", g.session.prepareEmail("b@x.com"))
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertTrue(ks.containsAlias("pa.sign") && ks.containsAlias("pa.enc"))
        assertTrue(g.settings.showContent)
        register("tB", "b@x.com")
        g.session.signOut()

        assertEquals("login", g.session.prepareEmail("a@x.com"))
        assertEquals(KeystoreKeyOps.LEGACY, KeystoreKeyOps.base)
        assertNull(g.settings.get(Settings.K.KEY_ALIAS))
        assertArrayEquals(keys.signPub, g.keysOrNull!!.signPub)
        assertEquals(a, g.dao.self()?.id)
        assertEquals("Phone", g.dao.self()?.name)
        assertEquals(listOf("Laptop"), g.store.peers().map { it.name })
        assertEquals("hello A", historyTexts())
        assertFalse(g.settings.showContent)
    }

    /** A delete-account login of another email says so and sends nothing to the relay server. */
    @Test fun deleteAccountOtherEmailSendsNothing() = io {
        register("tA", "a@x.com")
        calls.clear()
        assertEquals("Unable to delete the account.\nThis login is for \"b@x.com\", not the account on this device. Log in with the account you want to delete.",
            g.session.deleteAccount("tB", "b@x.com"))
        assertEquals(emptyList<String>(), calls)
        assertTrue(g.dao.self() != null)
    }

    /** Keys with no id (the register reply was lost) are kept on a switch, not deleted. */
    @Test fun keysWithoutIdSurviveSwitch() = io {
        g.session.keysForSignIn()
        val alias = KeystoreKeyOps.base
        assertTrue(KeystoreKeyOps.present())
        g.session.switchAccount(null)
        KeystoreKeyOps.base = alias
        assertTrue(KeystoreKeyOps.present())
    }

    /** The archive holds a hash of the address, never the address; a plain one from an earlier version is hashed. */
    @Test fun archiveHoldsNoPlainEmail() = io {
        val a = register("tA", "a@x.com")
        g.session.signOut()
        g.session.onTicket("tB", "b@x.com")
        val sql = g.db.openHelper.writableDatabase
        fun emails() = sql.query("SELECT email FROM arch_self").use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
        assertEquals(listOf(com.pusharmor.store.Slots.emailHash("a@x.com")), emails())
        sql.execSQL("UPDATE arch_self SET email = 'a@x.com'")
        assertEquals(a.take(12), g.slots.accountFor("a@x.com", null))
        assertTrue(emails().none { it!!.contains("@") })
    }

    /** An archive matches the relay server's account: Gmail dots, googlemail, and a +tag name the same mailbox; an earlier version's hash matches too. */
    @Test fun archiveMatchesSameMailbox() = io {
        val a = register("tA", "a.b+x@googlemail.com")
        g.session.signOut()
        assertEquals("login", g.session.prepareEmail("AB@gmail.com"))
        assertEquals(a, g.dao.self()?.id)
        g.session.prepareEmail("b@x.com")
        register("tB", "b@x.com")
        g.session.signOut()
        assertEquals("login", g.session.prepareEmail("AB@gmail.com"))
        assertEquals(a, g.dao.self()?.id)
        // a hash an earlier version stored (of the address itself) still matches
        g.session.switchAccount(null)
        val sql = g.db.openHelper.writableDatabase
        sql.execSQL("UPDATE arch_self SET email = ? WHERE account = ?", arrayOf(com.pusharmor.store.Slots.legacyEmailHash("a.b@gmail.com"), a.take(12)))
        assertEquals(a.take(12), g.slots.accountFor(" A.B@gmail.com", null))
        assertNull(g.slots.accountFor("ab@gmail.com.au", null))
    }

    /** A removed device has no id and no keys, but a switch keeps the history in the archive, and switching back brings it. */
    @Test fun removedDeviceHistorySurvivesSwitch() = io {
        register("tA", "a@x.com")
        g.session.signOut()
        g.session.prepareEmail("b@x.com")
        val b = register("tB", "b@x.com")
        history("hello B")
        g.session.selfRemoved(deleted = false, lostKeys = false)
        assertNull(g.dao.self())
        assertEquals("hello B", historyTexts())

        assertTrue(g.session.onTicket("tA", "a@x.com") is Session.SignIn.Switched)
        assertNull(historyTexts())
        assertTrue(g.slots.has(b.take(12)))
        assertTrue(g.session.onTicket("tB", "b@x.com") is Session.SignIn.Switched)
        assertEquals("hello B", historyTexts())
    }

    /** The screens read long-lived flows: a switch updates the devices, history, email, and settings they show without a restart. */
    @Test fun switchUpdatesScreenFlows() = io {
        val scope = kotlinx.coroutines.CoroutineScope(Dispatchers.IO)
        try {
            val peers = g.dao.peersFlow().stateIn(scope, SharingStarted.Eagerly, null)
            val hist = g.dao.historyFlow().stateIn(scope, SharingStarted.Eagerly, null)
            val self = g.dao.selfFlow().stateIn(scope, SharingStarted.Eagerly, null)
            val days = g.settings.data.map { it[Settings.K.HISTORY_DAYS] }.stateIn(scope, SharingStarted.Eagerly, null)
            fun waitFor(what: String, cond: () -> Boolean) {
                val end = System.currentTimeMillis() + 5000
                while (!cond()) { assertTrue(what, System.currentTimeMillis() < end); Thread.sleep(20) }
            }
            register("tA", "a@x.com")
            g.store.putPeer(Peer(id = "P".repeat(40), name = "Laptop"))
            history("hello A")
            g.settings.set(Settings.K.HISTORY_DAYS, 7)
            waitFor("A shown") { peers.value?.size == 1 && hist.value?.size == 1 && self.value?.email == "a@x.com" && days.value == 7 }
            g.session.signOut()
            g.session.prepareEmail("b@x.com")
            waitFor("B shown") { peers.value?.isEmpty() == true && hist.value?.isEmpty() == true && self.value == null && days.value == null }
        } finally { scope.cancel() }
    }
}
