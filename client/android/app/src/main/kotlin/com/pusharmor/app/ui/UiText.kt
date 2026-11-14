package com.pusharmor.app.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import com.pusharmor.protocol.NameEntry
import com.pusharmor.protocol.Peer
import com.pusharmor.protocol.engine.PairStart
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

    /** Same words as iOS: Delete account asks first and says what follows. */
    const val COPY_VERSION = "Copy version"
    fun version(name: String) = "Version $name"

    /** Copy confirmation and failure (two lines), same words as the other clients. */
    const val COPIED = "Copied"
    const val UNABLE_COPY = "Unable to copy"
    const val COPY_BY_HAND = "Select the text and copy it by hand"

    /** Brief text after a copy, on every Android version (13 and later also show their own clipboard preview). */
    fun copyResult(ok: Boolean): String = if (ok) COPIED else com.pusharmor.net.ErrorText.text(UNABLE_COPY, COPY_BY_HAND)

    /** Toast and snackbar text: no line ends with a period. Inline text, dialogs, and notifications keep theirs; an ellipsis stays. */
    fun brief(text: String): String =
        text.split('\n').joinToString("\n") { if (it.endsWith('.') && !it.endsWith("..")) it.dropLast(1) else it }

    const val DELETE_CONFIRM = "Delete this account? You must log in again to confirm. This cannot be undone."

    // Line 1 of an error: what could not be done. Line 2 (ErrorText) says why.
    const val UNABLE_SEND = "Unable to send."
    const val UNABLE_REFRESH = "Unable to refresh the device list."
    const val UNABLE_RENAME = "Unable to rename this device."
    fun unablePair(x: String) = "Unable to pair with \"$x\"."
    fun unableCancelPairing(x: String) = "Unable to cancel pairing with \"$x\"."
    fun unableConfirm(x: String) = "Unable to confirm \"$x\"."
    fun unableReject(x: String) = "Unable to reject \"$x\"."
    fun unableRemove(x: String) = "Unable to remove \"$x\"."
    const val UNABLE_EVICT = "Unable to remove the chosen devices."
    const val UNABLE_LOGOUT = "Unable to log out."
    const val UNABLE_SEND_CODE = "Unable to send the code."
    const val UNABLE_CHECK_CODE = "Unable to check the code."
    const val UNABLE_LOGIN = "Unable to log in."
    const val UNABLE_LOGIN_GOOGLE = "Unable to log in with Google."
    const val UNABLE_START_LOGIN = "Unable to start the login."
    const val UNABLE_DELETE_ACCOUNT = "Unable to delete the account."
    const val UNABLE_DELETE_HISTORY = "Unable to delete the history."
    const val UNABLE_DELETE_SYNC = "Unable to delete on your other devices."

    /** Line 2 for a login ticket of another account [to]; this device switched to that account and the next login uses it. */
    fun switchAccount(to: String?): String = when {
        to == null -> com.pusharmor.net.ErrorText.ACCOUNT_MISMATCH
        else -> "To finish logging in as \"$to\", log in again."
    }

    /** Line 2 for a delete-account login of another account [to] than this device's. */
    fun deleteOtherAccount(to: String): String = "This login is for \"$to\", not the account on this device. Log in with the account you want to delete."
    const val UNABLE_SAVE_MESSAGE = "Unable to save the message."
    const val UNABLE_CHANGE_SETTING = "Unable to change this setting."
    const val UNABLE_TURN_ON_NOTIFICATIONS = "Unable to turn on notifications."
    const val UNABLE_OPEN_DATA = "Unable to open PushArmor data."

    /** Line 2 for a message file that could not be written: no access, a full disk, else a plain retry. */
    fun saveReason(e: Throwable): String = when {
        e is SecurityException -> com.pusharmor.net.ErrorText.SAVE_DENIED
        e.message?.contains("ENOSPC") == true || e.message?.contains("No space left") == true -> com.pusharmor.net.ErrorText.STORAGE_FULL
        else -> com.pusharmor.net.ErrorText.TRY_AGAIN
    }

    /** Host of a push endpoint for an error line: lower case, only a-z 0-9 . -, at most 64; never the path or token. */
    fun pushHost(endpoint: String?): String? {
        val host = endpoint?.let { runCatching { java.net.URI(it).host }.getOrNull() } ?: return null
        return host.lowercase().filter { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '-' }.take(64).ifEmpty { null }
    }

    /** Same words as iOS: keys that fail the start check; deleting them is the user's choice and asks first. */
    const val KEYS_BROKEN_TITLE = "This device's keys have become unusable."
    const val KEYS_BROKEN_BODY = "Tap Retry to try again. If this keeps happening, you can delete the broken keys. " +
        "You will then sign in again and pair all your devices again."
    const val KEYS_BROKEN_RETRY = "Retry"
    const val KEYS_BROKEN_DELETE = "Delete broken keys"
    const val KEYS_BROKEN_DIALOG_TITLE = "Delete broken keys?"
    const val KEYS_BROKEN_DIALOG_BODY = "This cannot be undone. You will need to pair all your devices again."

    /** Snackbar once after a damaged settings file was reset to defaults. */
    const val SETTINGS_RESET = "Your settings were reset."

    /** Same layout as the keys screen: a database file that cannot be read; resetting it is the user's choice and asks first. */
    const val DATA_BROKEN_TITLE = "This device's data has become unusable."
    const val DATA_BROKEN_BODY = "Tap Retry to try again. If this keeps happening, you can reset this device. " +
        "You will then log in again and pair all your devices again."
    const val DATA_BROKEN_RESET = "Reset this device"
    const val DATA_BROKEN_DIALOG_TITLE = "Reset this device?"
    const val DATA_BROKEN_DIALOG_BODY = "This cannot be undone. You will need to pair all your devices again."

    const val CANNOT_RECEIVE = "This device cannot receive messages."
    const val CANNOT_RECEIVE_NOTIFICATIONS_OFF = "Allow notifications for PushArmor in Settings."

    /** Line 2 when no UnifiedPush app is installed; Google is offered only where the Push method setting exists. */
    fun noPushApp(google: Boolean): String = if (google) "Install ntfy or Sunup, or set Push method to Google." else "Install ntfy or Sunup."

    /** Line 2 when push could not be set up on this device ([Settings.K.PUSH_SETUP] [code]), with the UnifiedPush [app] name; else null. */
    fun pushSetup(code: String?, app: String?): String? = when {
        code == "fcm_token" -> "Google's push service did not answer. Check your internet connection, then tap Check again."
        app == null -> null
        code == "up_register" -> "\"$app\" could not turn on messages for PushArmor. Open \"$app\", then tap Check again."
        code == "up_keys" -> "\"$app\" gave an address PushArmor cannot use. Update \"$app\", or choose another UnifiedPush app."
        else -> null
    }

    /** Line 2 when the relay server refused the push address of [app] at [host]. */
    fun pushRefused(host: String, app: String, google: Boolean): String =
        "The relay server cannot send to \"$host\". In $app, use its default server" + if (google) ", or set Push method to Google." else "."

    /** Push method value, in the error color, when no push service can be used. */
    const val PUSH_NONE_AVAILABLE = "None available"

    /** Push method dialog: what the UnifiedPush choice needs. */
    const val UNIFIEDPUSH_NOTE = "Uses the free ntfy or Sunup app. Install one, keep its default server, then return to PushArmor."

    /** One button, in the cannot-receive card and in Push method, opens the choice of UnifiedPush apps. */
    const val GET_PUSH_APP = "Get a UnifiedPush app"
    const val NTFY_NAME = "ntfy (recommended)"
    const val NTFY_ABOUT = "Free and open source. Keeps a light connection to deliver messages right away."
    const val SUNUP_NAME = "Sunup"
    const val SUNUP_ABOUT = "Free and open source. Delivers through Mozilla's push service."

    /** Line 2 when the relay server's push to this device failed on its side (Google push only; UnifiedPush never is). */
    const val RELAY_FAULT = "The relay server cannot reach Google's push service right now. This is not a problem on this device. Try again later."
    const val CHECK_AGAIN = "Check again"
    /** Check again: the test push reached this device. */
    const val CHECK_WORKING = "Working"
    const val CHECK_FAILED = "Unable to check right now. Try again later."
    /** Check again: a cause on this device remains, or the relay server's test push did not reach it. */
    const val CHECK_STILL = "Still cannot receive messages."

    /**
     * The line after Check again: [localCause] means no test push was sent; [word] is the relay server's result, null
     * on a network error or an error reply. "none" adds no line; an unknown word counts as "failed".
     */
    fun checkAgainText(localCause: Boolean, word: String?): String? = when {
        localCause -> CHECK_STILL
        word == null -> CHECK_FAILED
        word == "sent" -> CHECK_WORKING
        word == "none" -> null
        else -> CHECK_STILL
    }

    /**
     * True while this device cannot show or get messages: notifications off or blocked, no push app, a refused push
     * address, or a relay-side fault.
     */
    fun cannotReceive(enabled: Boolean, channelsBlocked: Boolean, noPushApp: Boolean, refused: Boolean, relayFault: Boolean = false): Boolean =
        !enabled || channelsBlocked || noPushApp || refused || relayFault

    /** Settings note under an Apple private relay address. */
    const val APPLE_RELAY_HINT = "To log in on another device, use this address. Find it on an iPhone in Settings, under your name, in Sign in with Apple. " +
        "You can also find it at appleid.apple.com, in Hide My Email."

    /** Peer status line by priority: missing, signed out, send only, unreachable, ready to pair (not paired here), approves, has not approved. */
    fun status(p: Peer): Pair<Mark, String> = when {
        p.missing -> Mark.OFF to "(missing)"
        p.loggedOut -> Mark.OFF to "Logged out"
        !p.listening -> Mark.OFF to "Not listening"
        !p.reachable -> Mark.OFF to "Unreachable"
        !p.pinned -> Mark.WAIT to "Ready to pair" // a Pair and Reject row, same word as the extensions
        p.approvesMe -> Mark.OK to "Paired"
        else -> Mark.WAIT to "Unconfirmed"
    }

    /** Device-limit row: "Trusts 3 devices. Trusted by 1." then "Unreachable." and "Logged out." when they apply. */
    fun limitRow(approves: Int, approvedBy: Int, reachable: Boolean, loggedOut: Boolean): String =
        "Trusts $approves ${if (approves == 1) "device" else "devices"}. Trusted by $approvedBy." +
            (if (!reachable) " Unreachable." else "") + (if (loggedOut) " Logged out." else "")

    /** "(39 / 2000)"; over the cap "Too long (N / 2000)". */
    fun counter(bytes: Int): String =
        if (bytes > SizeCap.MAX_CONTENT_BYTES) "Too long ($bytes / 2000)" else "($bytes / 2000)"

    /** Share sheet over the cap, then Close (and for text, Send the first 2000 characters). The cap still counts UTF-8 bytes. */
    const val SHARE_TOO_LONG = UNABLE_SEND + "\n" + com.pusharmor.net.ErrorText.TOO_LONG

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

    /**
     * Snackbar after a send to [picked] devices: [sent] reached, [total] in the All set; [name] is the one device reached.
     * Reached every pick: Message sent to "Laptop" or Message sent to 3 devices, as on iOS.
     */
    fun sendToast(picked: Int, sent: Int, total: Int, name: String? = null): String = when {
        sent == 1 && picked == 1 -> if (name == null) "Message sent to 1 device" else "Message sent to \"${cutName(name)}\""
        sent == picked && sent > 0 -> "Message sent to $sent devices"
        else -> "Sent to $sent of $total ${if (total == 1) "device" else "devices"}"
    }

    /** Toast after a Direct Share send to one device. */
    /** Direct Share progress line: the type as named on the Send screen caption. */
    fun directSending(type: ContentType, name: String): String =
        "Sending ${when (type) { ContentType.URL -> "URL"; ContentType.TEL -> "phone number"; ContentType.TEXT -> "text" }} to \"${cutName(name)}\"..."

    fun directShareSent(name: String): String = "Sent to \"${cutName(name)}\""

    /** The two lines for the one picked device that did not get a send; null when it did. An unknown or missing word reads as not ready yet. */
    fun sendResultText(word: String, x: String): String? {
        val to = "Unable to send to \"$x\".\n"
        return when {
            word == "sent" -> null
            word == "gone" -> "Unable to deliver message to \"$x\".\nOpen PushArmor on it to resolve."
            word == "logged out" -> to + "That device is logged out. Log in on that device to receive messages."
            word == "not listening" -> to + "It has not listened recently. Run pusharmor listen on it."
            word == "unapproved" -> to + "It is not paired with this device. Pair with it to send it messages."
            word == "denied" -> to + "It isn't paired with this device."
            word == "unknown" -> to + "It is no longer on this account."
            word.startsWith("failed:") -> to + "Its push service did not accept the message. Try again later."
            else -> to + "It has not finished turning on notifications. Open PushArmor on it."
        }
    }

    /** Sync deletions the relay server took but some devices did not get: one is named (and why), several are counted; null when all got it. */
    fun syncDeleteMissed(missed: List<Pair<String, String>>): String? = when (missed.size) {
        0 -> null
        1 -> missed[0].let { (x, w) -> "Unable to delete on \"$x\"" + (sendResultText(w, x)?.substringAfter('\n', "")?.takeIf { it.isNotEmpty() }?.let { "\n$it" } ?: "") }
        else -> "Unable to delete on ${missed.size} devices"
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

    /** Resend rule of the relay server: 2 sends per 60 s per address, so a code may be sent again 60 s after the last one. */
    const val RESEND_MS = 60_000L

    /** ms until a code may be sent to [email] again; only the address just sent to (or limited) waits. */
    fun sendLeftMs(until: Long, sentTo: String, email: String, now: Long): Long =
        if (sentTo.isEmpty() || sentTo != email.trim().lowercase()) 0L else maxOf(0L, until - now)

    /** Send button label: [label] alone, or "[label] in 42 seconds" while the countdown runs. */
    fun sendLabel(label: String, leftMs: Long): String = if (leftMs > 0) label + " in " + com.pusharmor.net.ErrorText.wait(leftMs) else label

    /** Red border while the field is non-empty and not a valid email; empty keeps the normal border. */
    fun emailFieldError(input: String): Boolean = input.isNotEmpty() && !emailValid(input)

    /** The red text under the field after an edit: gone once the address is valid, else kept until the next Next. */
    fun emailErrorAfterEdit(error: String?, input: String): String? = if (emailValid(input)) null else error

    /** No paired device: Devices shows the "Pair your first device" steps, Send and History lead there. */
    fun noPairedDevice(others: List<Peer>): Boolean = others.none { it.pinned && !it.removed }
    const val HIBERNATION_BANNER = "Android may pause this app's ability to receive messages unless \"Manage app if unused\" is turned off."
    val PAIR_HOWTO_STEPS = listOf("Install PushArmor on the other device.", "Log in with the same account.", "It appears here. Tap Pair.")
    fun numbered(steps: List<String>): List<String> = steps.mapIndexed { i, t -> "${i + 1}. $t" }
    /** Send chips in alphabetical order of the shown name: case-insensitive, locale-aware. */
    fun <T> sortedByName(items: List<T>, nameOf: (T) -> String, locale: java.util.Locale = java.util.Locale.getDefault()): List<T> {
        val c = java.text.Collator.getInstance(locale).apply { strength = java.text.Collator.SECONDARY }
        return items.sortedWith { a, b -> c.compare(nameOf(a), nameOf(b)) }
    }
    const val FIRST_DEVICE_TITLE = "Pair your first device"
    /** Same steps as the iOS first-pair screen; each shows with a numbered circle. */
    val FIRST_DEVICE_STEPS = listOf("Install PushArmor on another device.", "Log in with the same account.", "When it shows below, tap Pair, then tap Codes match when the fingerprints match.")
    /** The short ID the command line prints for this device: first 6 hex chars after the 9 account bytes. */
    fun shortDeviceId(id: String): String =
        java.util.Base64.getUrlDecoder().decode(id).drop(9).joinToString("") { "%02x".format(it) }.take(6)
    /** Extra line on an unpaired command line device; the command is monospace with no-break spaces so it never splits. */
    fun pairCommandLine(name: String, selfId: String): AnnotatedString = buildAnnotatedString {
        append("To pair, run this on \"$name\": ")
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append("pusharmor\u00A0pair\u00A0" + shortDeviceId(selfId)) }
    }
    const val FIRST_DEVICE_WAITING = "Waiting for another device to log in."

    /** Send with no paired device: pairing guidance replaces the empty "Send to" block once this device is loaded. */
    fun noDevicesShown(selfLoaded: Boolean, paired: Int): Boolean = selfLoaded && paired == 0
    const val NO_DEVICES_TITLE = "Pair a device first"
    /** Call to action under an empty or not-yet-usable Send or History. */
    const val PAIR_FIRST_CTA = "Pair your first device to start sending."
    /** Call to action under an empty History when devices are paired. */
    const val SEND_FIRST_CTA = "Messages you send or receive show here."

    enum class EmptyCta { PAIR, SEND }

    /** Empty History: no paired device leads to pairing, else to Send; nothing until this device is loaded. */
    fun historyCta(selfLoaded: Boolean, paired: Int): EmptyCta? = when {
        !selfLoaded -> null
        paired == 0 -> EmptyCta.PAIR
        else -> EmptyCta.SEND
    }
    const val NO_DEVICES_BODY = "1. Install PushArmor on the other device.\n2. Log in with the same account.\n3. It appears in Devices. Tap Pair."

    /** The "All" chip shows only with 2 or more devices (one device is preselected instead). */
    fun showAllChip(setting: Boolean, devices: Int, keyboardUp: Boolean = false): Boolean = setting && devices > 1 && !keyboardUp

    /** With the keyboard up only the selected device chips show, so the block stays short and every recipient stays visible. */
    fun chipVisible(selected: Boolean, keyboardUp: Boolean): Boolean = selected || !keyboardUp

    /**
     * With the keyboard up the caption, "Send as text", and "Send as URL" rows ([extrasPx]) hide when they would leave the message
     * field less than [fieldMinPx] (2 lines) of the [areaPx] above Send; the device chips ([chipsPx]) always keep their space.
     */
    fun sendExtrasShown(keyboardUp: Boolean, areaPx: Int, chipsPx: Int, extrasPx: Int, fieldMinPx: Int): Boolean =
        !keyboardUp || areaPx - chipsPx - extrasPx >= fieldMinPx

    /** The byte counter shows only from 90 percent of the cap (and over it, as "Too long"). */
    fun showCounter(bytes: Int): Boolean = bytes * 10 >= SizeCap.MAX_CONTENT_BYTES * 9

    /** Quiet caption for the detected type, present tense. */
    fun typeCaption(type: ContentType): String = when (type) {
        ContentType.URL -> "Will be sent as URL"
        ContentType.TEL -> "Will be sent as phone number"
        ContentType.TEXT -> "Will be sent as text"
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

    /** Why a Pair or Pair again tap did not start a pairing; null when it did. Pairing is not live, so no "online". */
    fun pairRefused(r: PairStart, name: String): String? = when (r) {
        PairStart.STARTED -> null
        PairStart.NO_DEVICE -> "This device is no longer on your account."
        PairStart.PAIRED -> "Already paired with \"$name\"."
        PairStart.IN_PROGRESS -> "Pairing with \"$name\" is already in progress."
        PairStart.NOT_READY -> "\"$name\" can't pair right now. Open PushArmor on that device, then try again."
    }

    /** Notice when a device in the half state sends a new pairing request. */
    fun pairAgainNotice(x: String?): String = "${quoted(x, "A device")} wants to pair again. Tap Pair again on its row."

    // Device texts: the name is always in straight double quotes; no name reads "A device" / "a device".
    fun approvedNotice(name: String?): String = "${quoted(name, "A device")} confirmed this device."
    fun renamedNotice(old: String?, new: String): String = "${quoted(old, "A device")} renamed to \"$new\""
    fun deletedNotice(count: Int, name: String?): String = (if (count == 1) "1 message" else "$count messages") + " deleted by " + quoted(name, "a device")
    fun rejectedNotice(name: String?): String = "Rejected by ${quoted(name, "a device")}."
    fun logoutNotice(name: String?, loggedOut: Boolean): String = quoted(name, "A device") + if (loggedOut) " logged out." else " logged in."
    fun greyedChip(name: String, status: String): String = "\"$name\": $status"
    fun blockedChannel(name: String?): String = "Messages from ${quoted(name, "a device")} are blocked."
    fun stillHolds(x: String): String = "\"$x\" still holds an earlier pairing. On \"$x\", tap Cancel pairing request, then tap Send again."
    fun pairingInProgress(name: String?): String = "Pairing with ${quoted(name, "a device")} in progress. Open PushArmor."
    fun newMessageFrom(name: String?): String = "New message from ${quoted(name, "a device")}"
    /** A message notification title: the sending device's name in quotes. */
    fun messageTitle(name: String?): String = quoted(name, "Unknown sender")
    fun removeDeviceBody(x: String): String = "Remove \"$x\" from this account? \"$x\" must log in again and pair with every device again."
    fun rejectedBy(x: String): String = "Rejected by \"$x\""
    fun notPairedOn(x: String): String = "Not paired on \"$x\""
    fun waitingCodesMatch(x: String): String = "Waiting for \"$x\": open PushArmor there and tap Codes match."
    fun repliedWaiting(x: String): String = "Replied. Waiting for \"$x\"."
    fun waitingReply(x: String): String = "Waiting for \"$x\" to reply."
    // Screen reader labels that carry a device name in a sentence quote it too.
    fun moreOptionsFor(x: String): String = "More options for \"$x\""
    fun chipLabel(name: String, status: String): String = "\"$name\": $status"
    /** The pairing row error when the other device has not answered (two lines). */
    fun noReplyFrom(x: String): String = "No reply from \"$x\"\nCheck that notifications are on for PushArmor on both devices, then try again"
    private fun quoted(name: String?, none: String): String = if (name == null) none else "\"$name\""

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
