package com.pusharmor.app.files

import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileNotFoundException

/** The file provider of received files: it serves only a decrypted file (received/<key>/out/<name>), never a blob or state. */
class OutFileProvider : FileProvider() {
    companion object {
        /**
         * true for the decoded path segments of a decrypted file: no separator (an encoded one decodes into a
         * segment), no dot segment, and the file stays in its key's out folder under [root] (the file folder).
         */
        fun served(segments: List<String>, root: File? = null): Boolean {
            if (segments.size != 4 || segments[0] != "received" || !FileStore.validKey(segments[1]) || segments[2] != "out") return false
            val name = segments[3]
            if (name.isEmpty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') || name.contains('\u0000')) return false
            if (root == null) return true
            val out = File(File(root, segments[1]), "out").canonicalFile
            return File(out, name).canonicalFile.parentFile == out
        }
    }

    private fun ok(uri: Uri): Boolean = served(uri.pathSegments, context?.let { File(it.filesDir, "files") })

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        if (!ok(uri)) throw FileNotFoundException("not served")
        return super.openFile(uri, mode)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor =
        if (ok(uri)) super.query(uri, projection, selection, selectionArgs, sortOrder) else android.database.MatrixCursor(arrayOf<String>(), 0)

    override fun getType(uri: Uri): String? = if (ok(uri)) super.getType(uri) else null
}
