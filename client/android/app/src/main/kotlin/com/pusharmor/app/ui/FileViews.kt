package com.pusharmor.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import com.pusharmor.app.files.FileUi
import com.pusharmor.app.ui.theme.LocalPaExtra
import com.pusharmor.app.ui.theme.MiddleEllipsisText
import com.pusharmor.app.ui.theme.PaIcons
import com.pusharmor.protocol.FileValue
import com.pusharmor.store.HistoryEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** The icon of a file kind, from its extension. */
internal fun fileIcon(name: String): ImageVector = when (FileUi.kind(name)) {
    FileUi.Kind.IMAGE -> PaIcons.Image
    FileUi.Kind.PDF -> PaIcons.Pdf
    FileUi.Kind.TEXT -> PaIcons.Notes
    FileUi.Kind.CODE -> PaIcons.Code
    FileUi.Kind.AUDIO -> PaIcons.MusicNote
    FileUi.Kind.VIDEO -> PaIcons.Movie
    FileUi.Kind.ARCHIVE -> PaIcons.Archive
    FileUi.Kind.OTHER -> PaIcons.InsertDriveFile
}

/** The type to open, share, or save a file as: from its extension, else application/octet-stream. */
internal fun fileMime(name: String): String =
    MimeTypeMap.getSingleton().getMimeTypeFromExtension(FileUi.ext(name))?.takeIf { it.isNotEmpty() } ?: "application/octet-stream"

internal fun noAppOpens(name: String) = "No app can open \"$name\"."

/** "Choose file..." inside the message box, at its bottom right. */
@Composable
internal fun ChooseFileButton(modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = modifier.heightIn(min = 40.dp)) {
        Icon(PaIcons.AttachFile, null, Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(FileUi.CHOOSE_FILE)
    }
}

/** The chosen file in place of the message box: its icon, name (middle cut, extension kept), size, and Remove file. */
@Composable
internal fun FileCard(name: String, size: Long, modifier: Modifier = Modifier, onRemove: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(modifier.fillMaxWidth().heightIn(min = 116.dp), shape = RoundedCornerShape(12.dp), color = LocalPaExtra.current.tile, border = BorderStroke(1.dp, cs.outline)) {
        Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            com.pusharmor.app.ui.theme.IconTile(fileIcon(name))
            Column(Modifier.weight(1f).padding(horizontal = 16.dp)) {
                MiddleEllipsisText(name, MaterialTheme.typography.bodyLarge, Modifier.fillMaxWidth())
                Text(FileUi.sizeText(size), style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            IconButton(onClick = onRemove) { Icon(PaIcons.Close, FileUi.REMOVE_FILE) }
        }
    }
}

/** "Will be sent as file", like the type caption of a message. */
@Composable
internal fun FileCaption() {
    val cs = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(PaIcons.InsertDriveFile, null, Modifier.size(16.dp), tint = cs.onSurfaceVariant)
        Text(FileUi.WILL_SEND_FILE, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
    }
}

/** A small preview of a received image, decoded off the main thread; the file icon until then. */
@Composable
internal fun FileThumb(file: File, name: String) {
    var bmp by remember(file) { mutableStateOf<Bitmap?>(null) }
    androidx.compose.runtime.LaunchedEffect(file) { bmp = withContext(Dispatchers.IO) { decodeSampled(file, 160) } }
    val b = bmp
    if (b == null) com.pusharmor.app.ui.theme.IconTile(fileIcon(name))
    else Image(b.asImageBitmap(), name, Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.Crop)
}

/** Decodes [file] at most about [max] pixels on its longer side; null when it is not an image or memory is short. */
internal fun decodeSampled(file: File, max: Int): Bitmap? = try {
    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, o)
    var sample = 1
    while (maxOf(o.outWidth, o.outHeight) / (sample * 2) >= max) sample *= 2
    BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
} catch (e: Exception) { null } catch (e: OutOfMemoryError) { null }

/** The name, size and type, and the state of a file row: Download with the expiry right of it, progress, errors, or the actions. */
@Composable
internal fun FileRowBody(vm: AppViewModel, h: HistoryEntity, f: FileValue, style: TextStyle, now: Long) {
    val cs = MaterialTheme.colorScheme
    val sent = h.direction == "SENT"
    val rows by vm.files.rows.collectAsState()
    val row = rows[h.id]
    val name = if (sent) f.name else row?.name ?: FileUi.receivedName(f.name, h.at)
    val status = row?.status
    val faded = status == FileUi.Status.Expired
    Column(Modifier.fillMaxWidth()) {
        MiddleEllipsisText(name, if (faded) style.copy(color = cs.onSurfaceVariant) else style, Modifier.fillMaxWidth())
        Text(FileUi.detail(name, f.size), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
        if (sent) {
            Text(FileUi.expiresText(f.expires, now / 1000), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            return@Column
        }
        @Composable fun line(icon: ImageVector, text: String, color: Color) = Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(18.dp), tint = color)
            Text(text, Modifier.padding(start = 4.dp), style = MaterialTheme.typography.bodyMedium, color = color)
        }
        @Composable fun button(label: String, icon: ImageVector, expires: String?, onClick: () -> Unit) =
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                MessageAction(label, icon, onClick)
                if (expires != null) Text(expires, Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            }
        when (status) {
            null, FileUi.Status.Ready -> if (status == FileUi.Status.Ready && row.plain != null && !row.image && FileUi.kind(name) == FileUi.Kind.IMAGE)
                Text(FileUi.PREVIEW_NA, style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
            is FileUi.Status.Pending -> button("Download", PaIcons.Download, status.expires) { vm.files.download(h.id) }
            is FileUi.Status.Downloading -> {
                line(PaIcons.Download, "Downloading ${status.percent}%", cs.onSurfaceVariant)
                LinearProgressIndicator({ status.percent / 100f }, Modifier.fillMaxWidth().padding(top = 4.dp).heightIn(max = 4.dp))
            }
            FileUi.Status.Decrypting -> LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(max = 4.dp))
            is FileUi.Status.Failed -> {
                val removed = status.text == FileUi.REMOVED
                line(if (removed) PaIcons.Info else PaIcons.Error, status.text, if (removed) cs.onSurfaceVariant else cs.error)
                if (status.download) button("Download", PaIcons.Download, status.expires) { vm.files.download(h.id) }
            }
            FileUi.Status.NoMemory -> {
                line(PaIcons.Error, FileUi.NO_MEMORY, cs.error)
                button("Decrypt", PaIcons.Lock, null) { vm.files.decryptNow(h.id) }
            }
            FileUi.Status.Expired -> line(PaIcons.Schedule, FileUi.EXPIRED, cs.onSurfaceVariant)
        }
    }
}

/** The actions of a decrypted file: an image has View, Copy, Share, Save; any other file Open, Share, Save. */
@Composable
internal fun FileActions(vm: AppViewModel, row: FileModel.Row) {
    val context = LocalContext.current
    val file = row.plain ?: return
    val name = row.name
    val mime = fileMime(name)
    var viewing by rememberSaveable(file.path) { mutableStateOf(false) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime)) { uri ->
        if (uri != null) vm.files.save(file, uri)
    }
    if (viewing) ImageViewer(file, name) { viewing = false }
    MessageActions {
        if (row.image) {
            MessageAction("View", PaIcons.Image) { viewing = true }
            MessageAction("Copy", PaIcons.ContentCopy) { vm.message.value = UiText.copyResult(copyFile(context, file, name)) }
        } else MessageAction("Open", PaIcons.OpenInNew) {
            startOrToast(context, Intent(Intent.ACTION_VIEW).setDataAndType(fileUri(context, file), mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), noAppOpens(name)) { vm.message.value = it }
        }
        MessageAction("Share", PaIcons.Share) {
            val uri = fileUri(context, file)
            val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(name, uri)
            startOrToast(context, Intent.createChooser(send, null), noAppOpens(name)) { vm.message.value = it }
        }
        MessageAction("Save", PaIcons.Save) { saver.launch(name) }
    }
}

/** A content URI other apps can read for a decrypted file. */
internal fun fileUri(context: Context, file: File): Uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)

/** Puts the image on the clipboard as a content URI; false when that failed. */
private fun copyFile(context: Context, file: File, name: String): Boolean = try {
    val clip = ClipData.newUri(context.contentResolver, name, fileUri(context, file))
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
    true
} catch (e: Exception) { false }

/** Full-screen image view with pinch zoom; a tap shows or hides the close button. */
@Composable
internal fun ImageViewer(file: File, name: String, onClose: () -> Unit) {
    val px = with(androidx.compose.ui.platform.LocalDensity.current) { androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp.dp.roundToPx() }
    var bmp by remember(file) { mutableStateOf<Bitmap?>(null) }
    androidx.compose.runtime.LaunchedEffect(file) { bmp = withContext(Dispatchers.IO) { decodeSampled(file, maxOf(px, 1024)) } }
    var showClose by remember { mutableStateOf(true) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)
            .pointerInput(Unit) { detectTapGestures { showClose = !showClose } }
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }) {
            bmp?.let {
                Image(it.asImageBitmap(), name, Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                    contentScale = ContentScale.Fit)
            }
            if (showClose) Box(Modifier.align(Alignment.TopEnd).safeDrawingPadding().padding(8.dp)) {
                IconButton(onClick = onClose) { Icon(PaIcons.Close, "Close", tint = Color.White) }
            }
        }
    }
}

/** The image on the clipboard, if the first item is a content URI of an image type; else null. */
internal fun clipImage(context: Context): Uri? = try {
    context.getSystemService(ClipboardManager::class.java)?.primaryClip
        ?.takeIf { it.itemCount > 0 && it.description.hasMimeType("image/*") }?.getItemAt(0)?.uri
} catch (e: Exception) { null }

/**
 * The message box's Paste: an image on the clipboard becomes the chosen file while the box is empty, and gives
 * [onRefuse] while it holds text (one type per message); any other paste is unchanged.
 */
@Composable
internal fun PasteImage(textEmpty: Boolean, onImage: (Uri) -> Unit, onRefuse: () -> Unit, content: @Composable () -> Unit) {
    val base = androidx.compose.ui.platform.LocalTextToolbar.current
    val context = LocalContext.current
    val empty = androidx.compose.runtime.rememberUpdatedState(textEmpty)
    val toolbar = remember(base) {
        object : androidx.compose.ui.platform.TextToolbar by base {
            override fun showMenu(rect: androidx.compose.ui.geometry.Rect, onCopyRequested: (() -> Unit)?, onPasteRequested: (() -> Unit)?,
                                  onCutRequested: (() -> Unit)?, onSelectAllRequested: (() -> Unit)?) {
                // an image-only clip has no text, so the field offers no Paste: it is offered here
                val paste: (() -> Unit)? = if (onPasteRequested == null && clipImage(context) == null) null else {
                    {
                        val uri = clipImage(context)
                        when (FileUi.paste(uri != null, empty.value)) {
                            FileUi.Paste.IMAGE -> onImage(uri!!)
                            FileUi.Paste.REFUSE -> onRefuse()
                            FileUi.Paste.TEXT -> onPasteRequested?.invoke()
                        }
                    }
                }
                base.showMenu(rect, onCopyRequested, paste, onCutRequested, onSelectAllRequested)
            }
        }
    }
    androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalTextToolbar provides toolbar, content = content)
}
