package com.pusharmor.app

import com.pusharmor.app.ui.MessageKind
import com.pusharmor.app.ui.TEXT_BOX_LINES
import com.pusharmor.app.ui.historyActionLabels
import com.pusharmor.app.ui.messageFileName
import com.pusharmor.app.ui.messageKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class HistoryActionsTest {
    private fun source(path: String) = java.io.File("src/main/kotlin/com/pusharmor/app/$path").readText()

    @Test fun fileNameUsesLocalDateAndTime() {
        val zone = ZoneId.of("America/New_York")
        val at = ZonedDateTime.of(2026, 3, 7, 9, 5, 2, 0, zone).toInstant().toEpochMilli()
        assertEquals("2026-03-07_090502_message.txt", messageFileName(at, zone))
    }

    @Test fun actionOrderByType() {
        assertEquals(listOf("Copy", "Open", "Share"), historyActionLabels(messageKind("url", "https://example.com/a")))
        assertEquals(listOf("Copy", "Open", "Share"), historyActionLabels(messageKind("tel", "+15551234567")))
        assertEquals(listOf("Read", "Copy", "Share", "Save"), historyActionLabels(messageKind("text", "hello")))
        assertEquals(MessageKind.TEXT, messageKind("url", "not a link"))
    }

    @Test fun readOpensAndCloses() {
        val main = source("ui/MainScreens.kt")
        assertTrue(main.contains("RowAction(\"Read\", PaIcons.Article) { reading = true }"))
        assertTrue(main.contains("if (reading) ReadDialog(hc) { reading = false }"))
        val dialog = main.substring(main.indexOf("private fun ReadDialog("))
        assertTrue(dialog.contains("IconButton(onClick = onClose) { Icon(PaIcons.Close"))
        assertTrue(dialog.contains("Dialog(onDismissRequest = onClose"))
        assertTrue(dialog.substringBefore("/** ").contains("SelectionContainer"))
        assertEquals(1, Regex("IconButton\\(").findAll(dialog.substringBefore("\n}\n")).count())
    }

    @Test fun textBoxShowsThreeLinesAndScrolls() {
        assertEquals(3, TEXT_BOX_LINES)
        val box = source("ui/MainScreens.kt").substringAfter("private fun TextBox(").substringBefore("\n}\n")
        assertTrue(box.contains("heightIn(max = lineDp * TEXT_BOX_LINES).verticalScroll("))
    }

    @Test fun saveWritesLocallyAsPlainText() {
        val main = source("ui/MainScreens.kt")
        assertTrue(main.contains("CreateDocument(\"text/plain\")"))
        assertTrue(main.contains("saver.launch(messageFileName(h.at))"))
    }
}
