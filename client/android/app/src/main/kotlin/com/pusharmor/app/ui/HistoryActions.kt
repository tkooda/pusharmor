package com.pusharmor.app.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** What a History message is, for choosing its actions (I622). */
enum class MessageKind { URL, TEL, TEXT }

/** A link or phone number that is not usable is shown as plain text, like the notification does. */
fun messageKind(type: String?, content: String): MessageKind = when {
    type == "url" && com.pusharmor.protocol.UrlCheck.parse(content) != null -> MessageKind.URL
    type == "tel" && com.pusharmor.protocol.Phone.isPhone(content) -> MessageKind.TEL
    else -> MessageKind.TEXT
}

/** The action buttons of an opened message, in display order. */
fun historyActionLabels(kind: MessageKind): List<String> = when (kind) {
    MessageKind.URL, MessageKind.TEL -> listOf("Copy", "Open", "Share")
    MessageKind.TEXT -> listOf("Read", "Copy", "Share", "Save")
}

/** Number of text lines the opened text box shows before it scrolls. */
const val TEXT_BOX_LINES = 3

private val FILE_STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd_HHmmss")

/** Default file name for Save: the message time in local time, as YYYY-MM-DD_HHMMSS_message.txt. */
fun messageFileName(at: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    FILE_STAMP.format(Instant.ofEpochMilli(at).atZone(zone)) + "_message.txt"
