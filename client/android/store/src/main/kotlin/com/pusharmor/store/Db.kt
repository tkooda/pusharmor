package com.pusharmor.store

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
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
    @ColumnInfo(name = "hide_content") val hideContent: Boolean = false,
    @ColumnInfo(defaultValue = "1") val listening: Boolean = true,
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

@Entity(tableName = "history")
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

@Dao
interface PaDao {
    @Query("SELECT * FROM self WHERE k = 0") fun self(): SelfEntity?
    @Query("SELECT * FROM self WHERE k = 0") fun selfFlow(): Flow<SelfEntity?>
    @Upsert fun putSelf(s: SelfEntity)
    @Query("DELETE FROM self") fun deleteSelf()

    @Query("SELECT * FROM peers WHERE id = :id") fun peer(id: String): PeerEntity?
    @Query("SELECT * FROM peers ORDER BY created") fun peers(): List<PeerEntity>
    @Query("SELECT * FROM peers ORDER BY created") fun peersFlow(): Flow<List<PeerEntity>>
    @Upsert fun putPeer(p: PeerEntity)
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
    @Query("DELETE FROM pairing WHERE peer_id = :id") fun deletePairing(id: String)
    @Query("UPDATE pairing SET own_r = zeroblob(32)") fun zeroAllR()
    @Query("DELETE FROM pairing") fun deleteAllPairings()

    @Query("SELECT at FROM pairing_cap") fun cap(): List<Long>
    @Insert fun addCap(c: CapEntity)
    @Query("DELETE FROM pairing_cap WHERE at < :before") fun pruneCap(before: Long)
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
}

@Database(
    entities = [SelfEntity::class, PeerEntity::class, PairingEntity::class, CapEntity::class, ReplayEntity::class, AllowEntity::class, HistoryEntity::class],
    version = 4,
    exportSchema = true,
)
abstract class PaDatabase : RoomDatabase() {
    abstract fun dao(): PaDao

    companion object {
        const val NAME = "pusharmor.db"

        /** 1 -> 2: peers.pair_again (row marker for [Pair again]). */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE peers ADD COLUMN pair_again INTEGER NOT NULL DEFAULT 0")
            }
        }

        /** 2 -> 3: peers.paused / pause_n -> logged_out / logout_n; history event types follow. */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE peers RENAME COLUMN paused TO logged_out")
                db.execSQL("ALTER TABLE peers RENAME COLUMN pause_n TO logout_n")
                db.execSQL("UPDATE history SET type = 'logged_out' WHERE type = 'paused'")
                db.execSQL("UPDATE history SET type = 'logged_in' WHERE type = 'resumed'")
            }
        }

        /** 3 -> 4: peers.listening ("cli" peers that do not listen are send only). */
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE peers ADD COLUMN listening INTEGER NOT NULL DEFAULT 1")
            }
        }

        fun open(context: Context, name: String? = NAME): PaDatabase {
            val b = if (name == null) Room.inMemoryDatabaseBuilder(context, PaDatabase::class.java)
            else Room.databaseBuilder(context, PaDatabase::class.java, name).enableMultiInstanceInvalidation()
            return b.addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4).build()
        }
    }
}
