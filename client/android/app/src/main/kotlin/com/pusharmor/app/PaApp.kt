package com.pusharmor.app

import android.app.Application
import androidx.sqlite.db.SupportSQLiteDatabase
import com.pusharmor.app.data.Settings
import com.pusharmor.app.keys.KeystoreKeyOps
import com.pusharmor.app.notify.AppEffects
import com.pusharmor.app.notify.Notifier
import com.pusharmor.app.push.PushFlavor
import com.pusharmor.app.session.Session
import com.pusharmor.app.work.Work
import com.pusharmor.crypto.KeyOps
import com.pusharmor.net.ClockOffset
import com.pusharmor.net.WorkerClient
import com.pusharmor.protocol.engine.AllowReconcile
import com.pusharmor.protocol.engine.ApproveFlow
import com.pusharmor.protocol.engine.Identity
import com.pusharmor.protocol.engine.PairingEngine
import com.pusharmor.protocol.engine.LogoutFlow
import com.pusharmor.protocol.engine.PeersSync
import com.pusharmor.protocol.engine.ReceiveEngine
import com.pusharmor.protocol.engine.SendFlow
import com.pusharmor.store.PaDatabase
import com.pusharmor.store.RoomLocalStore
import com.pusharmor.store.Slots
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import java.security.SecureRandom

open class PaApp : Application() {
    lateinit var graph: Graph

    /** The HTTP client for the relay server; tests replace it. */
    open fun httpClient(): OkHttpClient = WorkerClient.defaultHttp()

    /** Room's invalidation across processes; tests turn it off (Robolectric answers its service bind with no name). */
    open fun multiInstanceDb(): Boolean = true

    override fun onCreate() {
        super.onCreate()
        graph = Graph(this)
        graph.notifier.ensureChannels()
        Work.scheduleDaily(this)
    }
}

/** Object graph (no DI framework). */
class Graph(val app: PaApp) {
    /** The database file was made new in this process (first start, or a reset of a corrupt file); its "no self row" is not proof. */
    @Volatile var dbCreated = false
    /** A corrupt database file met in this process; kept until the user confirms Reset this device. */
    @Volatile var corruptDb: SupportSQLiteDatabase? = null
    val db = PaDatabase.open(app, multiInstance = app.multiInstanceDb(), onCorrupt = { corruptDb = it }) { dbCreated = true }
    val store = RoomLocalStore(db)
    val dao = store.dao
    val settings = Settings(app, dao)
    val notifier = Notifier(app, settings, dao)
    val push = PushFlavor.create(app)
    val slots = Slots(db)
    private val random = SecureRandom()

    init { try { loadKeyAlias() } catch (e: Exception) { } } // a damaged database: startup reads it again

    @Volatile var keysOrNull: KeyOps? = try { KeystoreKeyOps.load() } catch (e: Exception) { null }

    /** Points the Keystore at the active account's key set; true when it changed. */
    fun loadKeyAlias(): Boolean {
        val b = settings.get(Settings.K.KEY_ALIAS) ?: KeystoreKeyOps.LEGACY
        if (b == KeystoreKeyOps.base) return false
        KeystoreKeyOps.base = b
        return true
    }

    /** Clock offset learned while there is no self row (a registration in progress); dropped by a wipe. */
    @Volatile var bootOffsetS = 0L

    /** Worker clock offset in seconds, persisted in the self row. */
    val offset = object : ClockOffset {
        override var offsetS: Long
            get() = dao.self()?.clockOffset ?: bootOffsetS
            set(v) { if (dao.self() == null) bootOffsetS = v else dao.setClockOffset(v) }
    }

    val client = WorkerClient({ keysOrNull ?: error("no keys") }, { dao.self()?.id }, offset, BuildConfig.API_BASE.toHttpUrl(),
        http = if (BuildConfig.SCREENSHOT_MODE) ScreenshotMode.guard(app.httpClient()) else app.httpClient(),
        onAuthState = ::onAuthState, paClient = "android/${BuildConfig.VERSION_NAME}",
        onUpdateRequired = { settings.markUpdateRequired(BuildConfig.VERSION_NAME) },
        onPushMissing = { settings.set(Settings.K.PUSH_MISSING, true) })

    /**
     * 401 "unknown peer": the removal check runs (false = not confirmed, the call reads as no reply);
     * 401 "logged out": signed out. Applies to every signed call.
     */
    private fun onAuthState(error: String): Boolean {
        if (error == "unknown peer") return session.onRemovedSignal(deleted = false)
        settings.set(Settings.K.SIGNED_OUT, true)
        return true
    }

    fun identity(): Identity? {
        val k = keysOrNull ?: return null
        val id = dao.self()?.id ?: return null
        return Identity(k, id)
    }

    fun effects(fcm: Boolean) = AppEffects(this, fcm)

    val session by lazy { Session(this) }

    fun rand(n: Int) = ByteArray(n).also { random.nextBytes(it) }

    fun pairing(fcm: Boolean = true) = PairingEngine(store, identity()!!, client, effects(fcm)) { rand(it) }
    fun approve(fcm: Boolean = true) = ApproveFlow(store, identity()!!, client, effects(fcm))
    fun receive(fcm: Boolean) = ReceiveEngine(store, identity()!!, effects(fcm))
    fun sender() = SendFlow(store, identity()!!, client, effects(true))
    fun sync() = PeersSync(store, identity()!!, effects(false))
    fun reconcile() = AllowReconcile(store, client) { session.onRemovedSignal(deleted = false) }
    fun logoutFlow() = LogoutFlow(store, identity()!!, client, reconcile())
}
