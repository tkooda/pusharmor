package com.pusharmor.app

import android.app.Application
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
import com.pusharmor.protocol.engine.PauseFlow
import com.pusharmor.protocol.engine.PeersSync
import com.pusharmor.protocol.engine.ReceiveEngine
import com.pusharmor.protocol.engine.SendFlow
import com.pusharmor.store.PaDatabase
import com.pusharmor.store.RoomLocalStore
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.security.SecureRandom

class PaApp : Application() {
    lateinit var graph: Graph

    override fun onCreate() {
        super.onCreate()
        graph = Graph(this)
        graph.notifier.ensureChannels()
        Work.scheduleDaily(this)
    }
}

/** Object graph (no DI framework). */
class Graph(val app: PaApp) {
    val settings = Settings(app)
    val db = PaDatabase.open(app)
    val store = RoomLocalStore(db)
    val dao = store.dao
    val notifier = Notifier(app, settings, dao)
    val push = PushFlavor.create(app)
    private val random = SecureRandom()

    @Volatile var keysOrNull: KeyOps? = try { KeystoreKeyOps.load() } catch (e: Exception) { null }

    /** Worker clock offset, persisted in the self row. */
    val offset = object : ClockOffset {
        override var offsetMs: Long
            get() = dao.self()?.clockOffset ?: 0
            set(v) { dao.self()?.let { dao.putSelf(it.copy(clockOffset = v)) } }
    }

    val client = WorkerClient({ keysOrNull ?: error("no keys") }, { dao.self()?.id }, offset, BuildConfig.API_BASE.toHttpUrl(),
        http = if (BuildConfig.SCREENSHOT_MODE) ScreenshotMode.guard(WorkerClient.defaultHttp()) else WorkerClient.defaultHttp(),
        onAuthState = ::onAuthState)

    /** 401 "unknown peer": this device was removed; 401 "paused": signed out. Applies to every signed call. */
    private fun onAuthState(error: String) {
        if (error == "unknown peer") session.selfRemoved(deleted = false, lostKeys = false)
        else settings.set(Settings.K.SIGNED_OUT, true)
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
    fun sync() = PeersSync(store, identity()!!)
    fun reconcile() = AllowReconcile(store, client) { session.selfRemoved(deleted = false, lostKeys = false) }
    fun pause() = PauseFlow(store, identity()!!, client, reconcile())
}
