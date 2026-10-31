package com.pusharmor.app.ui

import com.pusharmor.protocol.NameEntry
import com.pusharmor.protocol.Peer
import java.text.DateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date
import com.pusharmor.protocol.SizeCap
import com.pusharmor.protocol.ContentType

/** Pure text rules of the screens (unit tested without a device). */
object UiText {
    enum class Mark { OK, WAIT, OFF }

    /** Same words as iOS: Delete account asks first and says what follows (I477). */
    const val DELETE_CONFIRM = "Delete this account? You must log in again to confirm. This cannot be undone."

    /** Settings note under an Apple private relay address (I528). */
    const val APPLE_RELAY_HINT = "To log in on another device, use this address. Find it on an iPhone in Settings, under your name, in Sign in with Apple. " +
        "You can also find it at appleid.apple.com, in Hide My Email."

    /** Peer status line by priority: missing, signed out, send only, unreachable, ready to pair (not paired here), approves, has not approved. */
    fun status(p: Peer): Pair<Mark, String> = when {
        p.missing -> Mark.OFF to "(missing)"
        p.loggedOut -> Mark.OFF to "Logged out"
        !p.listening -> Mark.OFF to "Send only"
        !p.reachable -> Mark.OFF to "Unreachable"
        !p.pinned -> Mark.WAIT to "Ready to pair" // a Pair and Deny row (I526), same word as the extensions
        p.approvesMe -> Mark.OK to "Paired"
        else -> Mark.WAIT to "Has not approved this device"
    }

    /** Device-limit row: "Trusts 3 devices. Trusted by 1." then "Unreachable." and "Logged out." when they apply (Q369). */
    fun limitRow(approves: Int, approvedBy: Int, reachable: Boolean, loggedOut: Boolean): String =
        "Trusts $approves ${if (approves == 1) "device" else "devices"}. Trusted by $approvedBy." +
            (if (!reachable) " Unreachable." else "") + (if (loggedOut) " Logged out." else "")

    /** "39 / 2048"; over the cap "Too long (N / 2048)". */
    fun counter(bytes: Int): String =
        if (bytes > SizeCap.MAX_CONTENT_BYTES) "Too long ($bytes / 2048)" else "$bytes / 2048"

    /** Remembered recipient ids ("a,b,c") that can still receive; empty when none, so the default stays. */
    fun rememberedSelection(remembered: String?, available: List<String>): List<String> {
        val ids = remembered.orEmpty().split(',').filter { it.isNotEmpty() }.toSet()
        return available.filter { it in ids }
    }

    /** Chosen ids that can receive now, in the order chosen: what Send counts, names and sends to. */
    fun sendable(picked: List<String>, canReceive: List<String>): List<String> = picked.filter { it in canReceive }

    /** Longest device name shown in the Send button before it is cut with "...", so the button stays one line. */
    const val SEND_NAME_MAX = 20

    /** Send button label for [n] checked peers; one peer with a known [name] reads Send to "Laptop". */
    fun sendLabel(n: Int, name: String? = null): String = when (n) {
        0 -> "Send"
        1 -> if (name == null) "Send to 1 device" else "Send to \"${cutName(name)}\""
        else -> "Send to $n devices"
    }

    private fun cutName(name: String) = if (name.length > SEND_NAME_MAX) name.take(SEND_NAME_MAX - 3).trimEnd() + "..." else name

    /** History title of a sent row (F22): reached its one device reads Sent to "Laptop", cut like the Send button; else "Sent". */
    fun sentTitle(results: Map<String, String>, nameOf: (String) -> String): String {
        val only = results.entries.singleOrNull()
        return if (only?.value == "sent") "Sent to \"${cutName(nameOf(only.key))}\"" else "Sent"
    }

    /** Header above the device chips: "Send to (6 of 9)". */
    fun sendToHeader(picked: Int, total: Int): String = "Send to ($picked of $total)"

    /** The relay server's email rule (trim, ASCII, one "@" with text on both sides, no space or <>"(),;:\\, at most 254). */
    fun emailValid(input: String): Boolean {
        val s = input.trim(' ', '\t', '\n', '\r', '\u000c', '\u000b')
        val at = s.indexOf('@')
        return s.length in 1..254 && s.all { it.code in 0x21..0x7e && it !in "<>\"(),;:\\" } &&
            at >= 1 && at == s.lastIndexOf('@') && at < s.length - 1
    }

    /** Red border while the field is non-empty and not a valid email; empty keeps the normal border (I468). */
    fun emailFieldError(input: String): Boolean = input.isNotEmpty() && !emailValid(input)

    /** Q338: logged in with no paired device, one "Pair your first device" screen replaces Send, History, and Devices. */
    fun firstDeviceGate(others: List<Peer>): Boolean = others.none { it.pinned && !it.removed }

    /** Q338: when the first pairing lifts the gate, the normal navigation opens on Send. */
    fun afterGate(wasGate: Boolean, gate: Boolean): String? = if (wasGate && !gate) "send" else null
    const val FIRST_DEVICE_TITLE = "Pair your first device"
    const val FIRST_DEVICE_STEPS = "1. Install PushArmor on another device.\n2. Log in with the same account.\n3. Approve it here: tap Pair when it shows below."
    const val FIRST_DEVICE_WAITING = "No device is waiting yet. Your other device shows up here after it logs in."

    /** Send with no paired device (I462): pairing guidance replaces the empty "Send to" block once this device is loaded. */
    fun noDevicesShown(selfLoaded: Boolean, paired: Int): Boolean = selfLoaded && paired == 0
    const val NO_DEVICES_TITLE = "Pair a device first"
    const val NO_DEVICES_BODY = "1. Install PushArmor on the other device.\n2. Log in with the same account.\n3. It appears in Devices. Tap Pair."

    /** The "All" chip shows only with 2 or more devices (one device is preselected instead). */
    fun showAllChip(setting: Boolean, devices: Int, keyboardUp: Boolean = false): Boolean = setting && devices > 1 && !keyboardUp

    /** With the keyboard up only the selected device chips show, so the block stays short and every recipient stays visible. */
    fun chipVisible(selected: Boolean, keyboardUp: Boolean): Boolean = selected || !keyboardUp

    /**
     * With the keyboard up the caption and "Send as text" rows ([extrasPx]) hide when they would leave the message
     * field less than [fieldMinPx] (2 lines) of the [areaPx] above Send; the device chips ([chipsPx]) always keep their space.
     */
    fun sendExtrasShown(keyboardUp: Boolean, areaPx: Int, chipsPx: Int, extrasPx: Int, fieldMinPx: Int): Boolean =
        !keyboardUp || areaPx - chipsPx - extrasPx >= fieldMinPx

    /** The byte counter shows only from 90 percent of the cap (and over it, as "Too long"). */
    fun showCounter(bytes: Int): Boolean = bytes * 10 >= SizeCap.MAX_CONTENT_BYTES * 9

    /** Quiet caption for the detected type, present tense. */
    fun typeCaption(type: ContentType): String = when (type) {
        ContentType.URL -> "Will open as a link"
        ContentType.TEL -> "Will open as a phone number"
        ContentType.TEXT -> "Will arrive as text"
    }

    /** Spoken form of a fingerprint: "Pairing fingerprint K, 7, Q, D". */
    fun fingerprintLabel(code: String): String = "Pairing fingerprint " + code.toList().joinToString(", ")

    /** Day of [at] (epoch ms) in [zone], for grouping History rows. */
    fun day(at: Long, zone: ZoneId = ZoneId.systemDefault()): LocalDate = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()

    /** History day header: "Today", "Yesterday", else the locale medium date. */
    fun dayLabel(at: Long, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val d = day(at, zone)
        val today = day(now, zone)
        return when (d) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(at))
        }
    }

    /** Rename field error: null when [name] is a valid peer name (same rule and text as Session.rename). */
    fun nameError(name: String): String? = if (NameEntry.isValidName(name)) null else "Use 1 to 32 plain ASCII characters, no double quotes."

    /** Notice when a device in the half state sends a new pairing request. */
    fun pairAgainNotice(x: String): String = "$x wants to pair again. Tap Pair again on its row."

    /** Screen reader state of the sign-in code field, which has no visible label: "Code, 2 of 6 entered". */
    fun codeState(n: Int): String = "Code, $n of 6 entered"

    /** "1 day", "30 days". */
    fun days(d: Int): String = if (d == 1) "1 day" else "$d days"

    /**
     * Longest "head...tail" form of [text] that [fits] (about two thirds head), or [text] itself
     * when it fits. Binary search on the number of kept characters.
     */
    fun middleEllipsis(text: String, fits: (String) -> Boolean): String {
        if (fits(text)) return text
        var lo = 1
        var hi = text.length - 1
        var best = "..."
        while (lo <= hi) {
            val k = (lo + hi) / 2
            val tail = k / 3
            val s = text.take(k - tail) + "..." + text.takeLast(tail)
            if (fits(s)) { best = s; lo = k + 1 } else hi = k - 1
        }
        return best
    }
}
