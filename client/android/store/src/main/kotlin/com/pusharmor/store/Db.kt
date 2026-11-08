package com.pusharmor.store

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.room.RoomDatabase
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "self")
data class SelfEntity(
    @PrimaryKey val k: Int = 0,
    val id: String,
    @ColumnInfo(name = "account_prefix") val accountPrefix: ByteArray,
    @ColumnInfo(name = "push_hash") val pushHash: String? = null,
    @ColumnInfo(name = "clock_offset") val clockOffset: Long = 0,
    val email: String? = null,
    val name: String,
)

@Entity(tableName = "peers")
data class PeerEntity(
    @PrimaryKey val id: String,
    val platform: String,
    val created: Long,
    @ColumnInfo(name = "list_sign_pub") val listSignPub: String?,
    @ColumnInfo(name = "list_enc_pub") val listEncPub: String?,
    @ColumnInfo(name = "sign_pub") val signPub: String?,
    @ColumnInfo(name = "enc_pub") val encPub: String?,
    @ColumnInfo(name = "pairing_id") val pairingId: ByteArray?,
    val approved: Boolean,
    @ColumnInfo(name = "denied_by_me") val deniedByMe: Boolean,
    @ColumnInfo(name = "approve_verified") val approveVerified: Boolean,
    @ColumnInfo(name = "approves_me") val listApprovesMe: Boolean,
    @ColumnInfo(name = "denies_me") val listDeniesMe: Boolean,
    @ColumnInfo(name = "list_after_verify") val listAfterVerify: Boolean,
    val declined: Boolean,
    val reachable: Boolean,
    @ColumnInfo(name = "logged_out") val loggedOut: Boolean,
    @ColumnInfo(name = "logout_n") val logoutN: Long,
    val hidden: Boolean,
    val name: String?,
    @ColumnInfo(name = "name_n") val nameN: Long,
    val removed: Boolean,
    val missing: Boolean,
    @ColumnInfo(name = "last_n") val lastN: Long,
    @ColumnInfo(name = "channel_id") val channelId: String?,
    @ColumnInfo(name = "stored_approve") val storedApprove: String?,
    @ColumnInfo(name = "stored_approve_name") val storedApproveName: String?,
    @ColumnInfo(name = "last_approve_result") val lastApproveResult: String?,
    @ColumnInfo(name = "last_send_at") val lastSendAt: Long,
    val note: String?,
    @ColumnInfo(name = "pair_again", defaultValue = "0") val pairAgain: Boolean = false,
    /** Per-peer switches (section 6): lock screen, watch, always hide. */
    @ColumnInfo(name = "lock_screen") val lockScreen: Boolean = true,
    val watch: Boolean = true,
    /** Legacy "Always hide content"; replaced by [showContent] in schema 5 and no longer read. */
    @ColumnInfo(name = "hide_content") val hideContent: Boolean = false,
    @ColumnInfo(defaultValue = "1") val listening: Boolean = true,
    /** "Allow message content in notifications" for this peer; the inverse of the old hide_content. */
    @ColumnInfo(name = "show_content", defaultValue = "1") val showContent: Boolean = true,
)

@Entity(tableName = "pairing")
data class PairingEntity(
    @PrimaryKey @ColumnInfo(name = "peer_id") val peerId: String,
    val role: String,
    val state: String,
    @ColumnInfo(name = "own_r") val r: ByteArray,
    @ColumnInfo(name = "c_n") val cN: ByteArray?,
    @ColumnInfo(name = "peer_sign_pub") val peerSignPub: ByteArray?,
    @ColumnInfo(name = "peer_enc_pub") val peerEncPub: ByteArray?,
    @ColumnInfo(name = "peer_r") val peerR: ByteArray?,
    @ColumnInfo(name = "started_at") val startedAt: Long,
    @ColumnInfo(name = "pending_kind") val pendingKind: String?,
    @ColumnInfo(name = "pending_message") val pendingMessage: String?,
    @ColumnInfo(name = "not_before") val notBefore: Long,
    val authorized: Boolean,
    val fingerprint: String?,
    @ColumnInfo(name = "last_send_at") val lastSendAt: Long,
    @ColumnInfo(name = "last_result") val lastResult: String?,
    @ColumnInfo(name = "wait_from") val waitFrom: Long? = null,
)

@Entity(tableName = "pairing_cap")
data class CapEntity(@PrimaryKey(autoGenerate = true) val rowId: Long = 0, val at: Long)

@Entity(tableName = "replay")
data class ReplayEntity(
    @PrimaryKey @ColumnInfo(name = "peer_id") val peerId: String,
    @ColumnInfo(name = "pairing_id") val pairingId: ByteArray,
    val h: Long,
    val bitmap: ByteArray,
)

@Entity(tableName = "allow_set")
data class AllowEntity(@PrimaryKey val id: String)

@Entity(tableName = "history", indices = [Index("received_at"), Index("peer_id", "pairing_id", "n")])
data class HistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val direction: String,
    @ColumnInfo(name = "peer_id") val peerId: String?,
    val type: String,
    val content: String?,
    val n: Long?,
    @ColumnInfo(name = "pairing_id") val pairingId: ByteArray?,
    @ColumnInfo(name = "received_at") val at: Long,
    val read: Boolean,
    val results: String,
    val count: Int,
)

/** App security state by key (signed out, removal check, old id, push registration); the app's Settings owns the keys. */
@Entity(tableName = "app_state")
data class StateEntity(@PrimaryKey val k: String, val v: String)

@Dao
interface PaDao {
    @Query("SELECT * FROM self WHERE k = 0") fun self(): SelfEntity?
    @Query("SELECT * FROM self WHERE k = 0") fun selfFlow(): Flow<SelfEntity?>
    @Upsert fun putSelf(s: SelfEntity)
    @Query("UPDATE self SET clock_offset = :v WHERE k = 0") fun setClockOffset(v: Long)
    @Query("UPDATE self SET name = :n WHERE k = 0") fun setSelfName(n: String)
    @Query("UPDATE self SET push_hash = :h WHERE k = 0") fun setPushHash(h: String?)
    @Query("UPDATE self SET email = :e WHERE k = 0") fun setSelfEmail(e: String?)
    @Query("DELETE FROM self") fun deleteSelf()

    @Query("SELECT * FROM peers WHERE id = :id") fun peer(id: String): PeerEntity?
    @Query("SELECT * FROM peers ORDER BY created") fun peers(): List<PeerEntity>
    @Query("SELECT * FROM peers ORDER BY created") fun peersFlow(): Flow<List<PeerEntity>>
    @Upsert fun putPeer(p: PeerEntity)
    /** Changes only the switches given (null keeps a switch), so a concurrent write to another column is never undone. */
    @Query("UPDATE peers SET lock_screen = COALESCE(:lock, lock_screen), watch = COALESCE(:watch, watch), show_content = COALESCE(:show, show_content) WHERE id = :id")
    fun updatePeerSwitches(id: String, lock: Boolean?, watch: Boolean?, show: Boolean?)
    @Query("UPDATE peers SET hidden = :hidden WHERE id = :id") fun setHidden(id: String, hidden: Boolean)
    @Query("UPDATE peers SET channel_id = :ch WHERE id = :id") fun setChannelId(id: String, ch: String?)
    @Query("DELETE FROM peers WHERE id = :id") fun deletePeer(id: String)
    @Query("DELETE FROM peers") fun deleteAllPeers()
    @Query("UPDATE peers SET last_n = last_n + 1 WHERE id = :id") fun bumpCounter(id: String): Int
    @Query("UPDATE peers SET last_n = 0 WHERE id = :id") fun resetCounter(id: String)
    @Query("SELECT last_n FROM peers WHERE id = :id") fun counter(id: String): Long

    @Query("SELECT * FROM replay WHERE peer_id = :id") fun replay(id: String): ReplayEntity?
    @Upsert fun putReplay(r: ReplayEntity)
    @Query("DELETE FROM replay WHERE peer_id = :id") fun deleteReplay(id: String)
    @Query("DELETE FROM replay") fun deleteAllReplay()

    @Query("SELECT * FROM pairing WHERE peer_id = :id") fun pairing(id: String): PairingEntity?
    @Query("SELECT * FROM pairing") fun pairings(): List<PairingEntity>
    @Query("SELECT * FROM pairing") fun pairingsFlow(): Flow<List<PairingEntity>>
    @Upsert fun putPairing(p: PairingEntity)
    @Query("UPDATE pairing SET started_at = :now WHERE peer_id = :id AND started_at > :now") fun clampPairingStart(id: String, now: Long)
    @Query("DELETE FROM pairing WHERE peer_id = :id") fun deletePairing(id: String)
    @Query("UPDATE pairing SET own_r = zeroblob(32)") fun zeroAllR()
    @Query("DELETE FROM pairing") fun deleteAllPairings()

    @Query("SELECT at FROM pairing_cap") fun cap(): List<Long>
    @Insert fun addCap(c: CapEntity)
    @Query("DELETE FROM pairing_cap WHERE at < :before") fun pruneCap(before: Long)
    @Query("DELETE FROM pairing_cap WHERE at > :after") fun pruneCapAfter(after: Long)
    @Query("DELETE FROM pairing_cap") fun deleteAllCap()

    @Query("SELECT id FROM allow_set") fun allow(): List<String>
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun addAllow(a: AllowEntity)
    @Query("DELETE FROM allow_set WHERE id = :id") fun removeAllow(id: String)
    @Query("DELETE FROM allow_set") fun clearAllow()

    @Query("SELECT id FROM history WHERE peer_id = :peer AND pairing_id = :pid AND n = :n LIMIT 1") fun historyId(peer: String, pid: ByteArray, n: Long): Long?
    @Insert fun insertHistory(h: HistoryEntity): Long
    @Query("SELECT * FROM history ORDER BY received_at DESC, id DESC LIMIT 1") fun newestHistory(): HistoryEntity?
    @Query("UPDATE history SET count = count + 1, received_at = :at WHERE id = :id") fun bumpEvent(id: Long, at: Long)
    @Query("SELECT * FROM history WHERE id = :id") fun history(id: Long): HistoryEntity?
    @Query("SELECT * FROM history ORDER BY received_at DESC, id DESC") fun historyFlow(): Flow<List<HistoryEntity>>
    @Query("UPDATE history SET read = 1 WHERE id = :id") fun markRead(id: Long)
    @Query("DELETE FROM history WHERE received_at < :before") fun purgeHistory(before: Long)
    @Query("DELETE FROM history") fun deleteAllHistory()
    @Query("DELETE FROM history WHERE id IN (:ids)") fun deleteHistory(ids: List<Long>)
    /** Keeps the [keep] newest rows by received time (ties: newest id). */
    @Query("UPDATE history SET received_at = :to WHERE received_at > :now") fun clampHistoryTimes(now: Long, to: Long)
    @Query("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY received_at DESC, id DESC LIMIT :keep)") fun trimHistory(keep: Int)

    @Query("SELECT v FROM app_state WHERE k = :k") fun state(k: String): String?
    @Query("SELECT * FROM app_state") fun stateFlow(): Flow<List<StateEntity>>
    @Upsert fun putState(s: StateEntity)
    @Query("DELETE FROM app_state WHERE k = :k") fun deleteState(k: String)
    @Query("DELETE FROM app_state WHERE k NOT IN (:keep)") fun clearStateExcept(keep: List<String>)
}

@Database(
    entities = [SelfEntity::class, PeerEntity::class, PairingEntity::class, CapEntity::class, ReplayEntity::class, AllowEntity::class, HistoryEntity::class, StateEntity::class],
    version = 8,
    exportSchema = true,
)
abstract class PaDatabase : RoomDatabase() {
    abstract fun dao(): PaDao

    companion object {
        const val NAME = "pusharmor.db"

        /** 6 -> 7: app_state, the security state that moved out of the settings file. */
        val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `app_state` (`k` TEXT NOT NULL, `v` TEXT NOT NULL, PRIMARY KEY(`k`))")
            }
        }

        /** 7 -> 8: pairing.wait_from, the start of the no-reply window (null: started_at). */
        val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `pairing` ADD COLUMN `wait_from` INTEGER")
            }
        }

        /**
         * [onCreate] runs when the file is made new: first start, or after a confirmed [deleteCorrupt]. A corrupt
         * file is kept: SQLite hands it to [onCorrupt] instead of deleting it, and the call that met it throws.
         */
        fun open(context: Context, name: String? = NAME, multiInstance: Boolean = true, onCorrupt: (SupportSQLiteDatabase) -> Unit = {}, onCreate: () -> Unit = {}): PaDatabase {
            val b = if (name == null) Room.inMemoryDatabaseBuilder(context, PaDatabase::class.java)
            else Room.databaseBuilder(context, PaDatabase::class.java, name).let { if (multiInstance) it.enableMultiInstanceInvalidation() else it }
            return b.addMigrations(MIGRATION_6_7, MIGRATION_7_8)
                .openHelperFactory(KeepCorruptFactory(onCorrupt))
                .addCallback(object : RoomDatabase.Callback() { override fun onCreate(db: SupportSQLiteDatabase) = onCreate() }).build()
        }

        /** The user's confirmed reset: SQLite's own corrupt-file repair (close, then delete the file); the next call opens a new file. */
        fun deleteCorrupt(db: SupportSQLiteDatabase) = object : SupportSQLiteOpenHelper.Callback(1) {
            override fun onCreate(db: SupportSQLiteDatabase) = Unit
            override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
        }.onCorruption(db)
    }
}

/** SQLite's open helper with one change: a corrupt file goes to [onCorrupt] and is not deleted. */
private class KeepCorruptFactory(private val onCorrupt: (SupportSQLiteDatabase) -> Unit) : SupportSQLiteOpenHelper.Factory {
    private val base = FrameworkSQLiteOpenHelperFactory()

    override fun create(configuration: SupportSQLiteOpenHelper.Configuration): SupportSQLiteOpenHelper {
        val cb = configuration.callback
        val keep = object : SupportSQLiteOpenHelper.Callback(cb.version) {
            override fun onConfigure(db: SupportSQLiteDatabase) = cb.onConfigure(db)
            override fun onCreate(db: SupportSQLiteDatabase) = cb.onCreate(db)
            override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = cb.onUpgrade(db, oldVersion, newVersion)
            override fun onDowngrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = cb.onDowngrade(db, oldVersion, newVersion)
            override fun onOpen(db: SupportSQLiteDatabase) = cb.onOpen(db)
            override fun onCorruption(db: SupportSQLiteDatabase) = onCorrupt(db)
        }
        return base.create(SupportSQLiteOpenHelper.Configuration(configuration.context, configuration.name, keep,
            configuration.useNoBackupDirectory, configuration.allowDataLossOnRecovery))
    }
}
