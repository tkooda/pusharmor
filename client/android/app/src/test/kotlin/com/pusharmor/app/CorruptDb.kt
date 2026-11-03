package com.pusharmor.app

import com.pusharmor.store.PaDatabase

/** Replaces the database file with junk and gives the app a new graph on it, as the next process would see it. */
fun corruptDatabase(app: PaApp) {
    app.graph.db.close()
    app.getDatabasePath(PaDatabase.NAME).writeBytes(ByteArray(4096) { 0x5a })
    app.graph = Graph(app)
}
