package com.pusharmor.app.files

import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import java.io.FileNotFoundException

/** The file provider of received files: it serves only a decrypted file (received/<key>/out/<name>), never a blob or state. */
class OutFileProvider : FileProvider() {
    companion object {
        /** true for the path segments of a decrypted file. */
        fun served(segments: List<String>): Boolean =
            segments.size == 4 && segments[0] == "received" && FileStore.validKey(segments[1]) && segments[2] == "out" && segments[3].isNotEmpty() && segments[3] != ".."
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        if (!served(uri.pathSegments)) throw FileNotFoundException("not served")
        return super.openFile(uri, mode)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor =
        if (served(uri.pathSegments)) super.query(uri, projection, selection, selectionArgs, sortOrder) else android.database.MatrixCursor(arrayOf<String>(), 0)

    override fun getType(uri: Uri): String? = if (served(uri.pathSegments)) super.getType(uri) else null
}
