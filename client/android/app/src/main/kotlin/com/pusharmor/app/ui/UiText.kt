package com.pusharmor.app.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import com.pusharmor.protocol.DeviceName
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
    enum class Mark { OK, WAIT, OFF, NOT_PAIRED }

    /** Same words as iOS: Delete account asks first and says what follows. */
    const val COPY_VERSION = "Copy version"
    fun version(name: String) = "Version $name"

    /** Copy confirmation and failure (two lines), same words as the other clients. */
    const val COPIED = "Copied"
    const val UNABLE_COPY = "Unable to copy"
    const val COPY_BY_HAND = "Select the text and copy it by hand"

    /** Brief text after a copy, on every Android version (13 and later also show their own clipboard preview). */
    fun copyResult(ok: Boolean): String = if (ok) COPIED else com.pusharmor.net.ErrorText.text(UNABLE_COPY, COPY_BY_HAND)

    /** Save and copy of a named file: the toast names it. */
    fun saved(name: String) = "Saved \"$name\""
    fun unableSave(name: String) = "Unable to save \"$name\""
    fun unableCopy(name: String) = "Unable to copy \"$name\""

    /** Toast and snackbar text: no line ends with a period. Inline text, dialogs, and notifications keep theirs; an ellipsis stays. */
    fun brief(text: String): String =
        text.split('\n').joinToString("\n") { if (it.endsWith('.') && !it.endsWith("..")) it.dropLast(1) else it }

    const val DELETE_CONFIRM = "You must log in again to confirm. This cannot be undone."

    // Line 1 of an error: what could not be done. Line 2 (ErrorText) says why.
    const val UNABLE_SEND = "Unable to send."
    const val UNABLE_REFRESH = "Unable to refresh the device list."
    const val UNABLE_RENAME = "Unable to rename this device."
    fun unablePair(x: String) = "Unable to pair with ${q(x)}."
    /** Pair again cancelled the old pairing but a new one did not start. */
    fun pairAgainFailed(x: String) = unablePair(x) + "\nThe old pairing was cancelled. Tap Pair to try again."
    fun unableCancelPairing(x: String) = "Unable to cancel pairing with ${q(x)}."
    fun unableConfirm(x: String) = "Unable to confirm ${q(x)}."
    fun unableReject(x: String) = "Unable to reject ${q(x)}."
    fun unableRemove(x: String) = "Unable to remove ${q(x)}."
    const val UNABLE_EVICT = "Unable to remove the chosen devices."
    const val UNABLE_LOGOUT = "Unable to log out."
    const val UNABLE_SEND_CODE = "Unable to send the code."
    const val UNABLE_CHECK_CODE = "Unable to check the code."
    const val UNABLE_LOGIN = "Unable to log in."
    const val UNABLE_LOGIN_GOOGLE = "Unable to log in with Google."
    const val UNABLE_START_LOGIN = "Unable to start the login."
    const val UNABLE_DELETE_ACCOUNT = "Unable to delete the account."
    const val UNABLE_DELETE_MESSAGES = "Unable to delete on this device."
    const val UNABLE_DELETE_SYNC = "Unable to delete on your other devices."
    const val UNABLE_DELETE_FILE_SERVER = "Unable to delete on the relay server."

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
        "You will then log in again and pair all your devices again."
    const val KEYS_BROKEN_RETRY = "Retry"
    const val KEYS_BROKEN_DELETE = "Delete broken keys"
    const val KEYS_BROKEN_DIALOG_TITLE = "Delete broken keys?"
    const val KEYS_BROKEN_DIALOG_BODY = "This cannot be undone. You will need to pair all your devices again."

    /** Snackbar once after a damaged settings file was reset to defaults. */
    const val SETTINGS_RESET = "Your settings were reset."

    /** Snackbar once per app open after a device sent a message in a newer format version. */
    const val NEWER_VERSION = "A device uses a newer version. Update PushArmor"

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

    /** Banner when several UnifiedPush apps are installed and none is chosen. */
    const val CHOOSE_PUSH_APP = "Choose a UnifiedPush app in Settings to receive messages"

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

    /** Peer status line by priority: missing, signed out, send only, unreachable, not paired here, approves, has not approved. */
    fun status(p: Peer): Pair<Mark, String> = when {
        p.missing -> Mark.OFF to "(missing)"
        p.loggedOut -> Mark.OFF to "Logged out"
        !p.listening -> Mark.OFF to "Not listening"
        !p.reachable -> Mark.OFF to "Unreachable"
        !p.pinned -> Mark.NOT_PAIRED to "Not paired" // a Pair and Reject row, same word as the extensions
        p.approvesMe -> Mark.OK to "Paired"
        else -> Mark.WAIT to "Unconfirmed"
    }

    /** Device-limit row: "Trusts 3 devices. Trusted by 1." then "Unreachable." and "Logged out." on their own line when they apply. */
    fun limitRow(approves: Int, approvedBy: Int, reachable: Boolean, loggedOut: Boolean): String {
        val off = listOfNotNull(if (!reachable) "Unreachable." else null, if (loggedOut) "Logged out." else null).joinToString(" ")
        return "Trusts $approves ${if (approves == 1) "device" else "devices"}. Trusted by $approvedBy." + (if (off.isEmpty()) "" else "\n$off")
    }

    /** Device-limit order: fewest pairings (trusts + trusted by) first, then oldest added first. */
    fun limitOrder(peers: List<com.pusharmor.protocol.engine.ListedPeer>): List<com.pusharmor.protocol.engine.ListedPeer> =
        peers.sortedWith(compareBy({ it.approves + it.approvedBy }, { it.created }))

    /** "(39 / 2000)"; over the cap "Too long (N / 2000)". */
    fun counter(bytes: Int): String =
        if (bytes > SizeCap.MAX_CONTENT_BYTES) "Too long ($bytes / 2000)" else "($bytes / 2000)"

    /** Share sheet toasts when nothing can be sent: line 1, then line 2. */
    const val SHARE_LOGGED_OUT = UNABLE_SEND + "\nThis device is logged out. Open PushArmor and log in."
    const val SHARE_NOTHING = UNABLE_SEND + "\nThere is no text or URL to send."

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
        1 -> if (name == null) "Send to 1 device" else "Send to ${qCut(name)}"
        else -> "Send to $n devices"
    }

    /**
     * Snackbar after a send to [picked] devices: [sent] reached, [total] in the All set; [name] is the one device reached.
     * Reached every pick: Message sent to "Laptop" or Message sent to 3 devices, as on iOS.
     */
    fun sendToast(picked: Int, sent: Int, total: Int, name: String? = null): String = when {
        sent == 1 && picked == 1 -> if (name == null) "Message sent to 1 device" else "Message sent to ${qCut(name)}"
        sent == picked && sent > 0 -> "Message sent to $sent devices"
        else -> "Sent to $sent of $total ${if (total == 1) "device" else "devices"}"
    }

    /** Toast after a Direct Share send to one device. */
    /** Direct Share progress line: the type as named on the Send screen caption. */
    fun directSending(type: ContentType, name: String): String =
        "Sending ${when (type) { ContentType.URL -> "URL"; ContentType.TEL -> "phone number"; ContentType.TEXT -> "text" }} to ${qCut(name)}..."

    /** Body of the History multi-select delete confirmation; [sync] is the Sync deletions setting. */
    fun deleteSelectedBody(sync: Boolean): String =
        if (sync) "This deletes the selected messages off this and other paired devices." else "This deletes the selected messages off this device."

    fun directSending(type: ContentType, names: List<String>): String =
        "Sending ${when (type) { ContentType.URL -> "URL"; ContentType.TEL -> "phone number"; ContentType.TEXT -> "text" }} to ${quotedList(names.map(::cutName), names)}..."

    /** Progress caption for 2 or more devices: the devices follow, one per line. */
    fun directSendingFile(file: String, names: List<String>): String = "Sending \"$file\" to ${quotedList(names.map(::cutName), names)}..."

    fun directSendingFileList(file: String): String = "Sending \"$file\" to:"
    /** Line 2 of the error of a Direct Share file send that the app closed during. */
    fun directSendClosed(file: String): String = "PushArmor closed before \"$file\" was sent. Share it again"

    fun directSendingList(type: ContentType): String =
        "Sending ${when (type) { ContentType.URL -> "URL"; ContentType.TEL -> "phone number"; ContentType.TEXT -> "text" }} to:"

    /** One device in the progress list: a bullet and the name, no quotes. */
    fun bulleted(name: String): String = "\u2022 ${cutName(name)}"

    fun directShareSent(name: String): String = "Message sent to ${qCut(name)}"

    /** The two lines for the one picked device that did not get a send; null when it did. An unknown or missing word reads as not ready yet. */
    fun sendResultText(word: String, x: String): String? {
        val to = "Unable to send to ${q(x)}.\n"
        return when {
            word == "sent" -> null
            word == "gone" -> "Unable to deliver message to ${q(x)}.\nOpen PushArmor on it to resolve."
            word == "logged out" -> to + "That device is logged out. Log in on that device to receive messages."
            word == "not listening" -> to + "It has not listened recently. Run pusharmor listen on it."
            word == "unapproved" -> to + "It is not paired with this device. Pair with it to send it messages."
            word == "denied" -> to + "It is not paired with this device."
            word == "unknown" -> to + "It is no longer on this account."
            word.startsWith("failed:") -> to + "Its push service did not accept the message. Try again later."
            else -> to + "It has not finished turning on notifications. Open PushArmor on it."
        }
    }

    /** Sync deletions the relay server took but some devices did not get: one is named (and why), several are listed; null when all got it. */
    fun syncDeleteMissed(missed: List<Pair<String, String>>): String? = when (missed.size) {
        0 -> null
        1 -> missed[0].let { (x, w) -> "Unable to delete on ${q(x)}" + (sendResultText(w, x)?.substringAfter('\n', "")?.takeIf { it.isNotEmpty() }?.let { "\n$it" } ?: "") }
        else -> "Unable to delete on " + quotedList(missed.map { it.first })
    }

    /** "\"A\" and \"B\""; "\"A\", \"B\", and \"C\"". */
    fun quotedList(names: List<String>, full: List<String> = names): String {
        val q = names.mapIndexed { i, n -> if (isNewDeviceLabel(full[i])) n else "\"$n\"" }
        return if (q.size <= 2) q.joinToString(" and ") else q.dropLast(1).joinToString(", ") + ", and " + q.last()
    }

    /** Subtext of a History row whose delete is still pending on [names]. */
    fun notDeletedOn(names: List<String>): String = if (names.size == 1) "Not deleted on ${q(names[0])}" else "Not deleted on ${names.size} devices"

    /** Delete progress captions: del calls finished of all, a retry, then the local delete. */
    fun deletingOnOthers(done: Int, total: Int): String = "Deleting on your other devices ($done of $total)"
    fun tryingAgain(attempt: Int): String = "Trying again (attempt $attempt of 3)"
    const val DELETING_HERE = "Deleting on this device"

    /** Step captions under a progress indicator: sign-in, device limit, logout, Refresh, delete account, and Direct Share. */
    const val SENDING_CODE = "Sending the code"
    const val CHECKING_CODE = "Checking the code"
    const val SETTING_UP = "Setting up this device"
    const val LOADING_DEVICES = "Loading your devices"
    const val LOGGING_IN = "Logging in"
    const val LOGGING_OUT = "Logging out"
    const val UPDATING_DEVICES = "Updating devices"
    const val DELETING_ACCOUNT = "Deleting your account"
    fun removing(names: List<String>): String = "Removing " + quotedList(names)
    fun encryptingFor(name: String): String = "Encrypting for ${qCut(name)}"
    fun sendingTo(name: String): String = "Sending to ${qCut(name)}"

    fun encryptingFor(names: List<String>): String = "Encrypting for ${quotedList(names.map(::cutName), names)}"
    fun sendingTo(names: List<String>): String = "Sending to ${quotedList(names.map(::cutName), names)}"

    private fun cutName(name: String) = if (name.length > SEND_NAME_MAX) name.take(SEND_NAME_MAX - 3).trimEnd() + "..." else name

    /** History title of a sent row (F22): reached its one device reads Sent to "Laptop", cut like the Send button; else "Sent". */
    fun sentTitle(results: Map<String, String>, nameOf: (String) -> String): String {
        val only = results.entries.singleOrNull()
        return if (only?.value == "sent") "Sent to ${qCut(nameOf(only.key))}" else "Sent"
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

    /** Under the code cells. */
    const val CODE_SENT_NOTE = "We sent a 6-character code to this address. It can take a minute to arrive."

    /** The security check cannot show: line 1, then line 2. */
    const val SECURITY_CHECK_FAILED = "Unable to show the security check.\nUpdate Android System WebView."

    /** The security check page did not load (for example, no connection): line 1, then the connection reason. */
    val SECURITY_CHECK_LOAD_FAILED = "Unable to load the security check.\n" + com.pusharmor.net.ErrorText.UNREACHABLE

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
    /** The system setting that pauses unused apps, named as this Android version names it in App info. */
    fun unusedAppSetting(sdk: Int = android.os.Build.VERSION.SDK_INT): String = when {
        sdk >= 35 -> "Manage app if unused"
        sdk >= 33 -> "Pause app activity if unused"
        else -> "Remove permissions and free up space"
    }
    fun hibernationBanner(sdk: Int = android.os.Build.VERSION.SDK_INT): String =
        "Android may pause this app's ability to receive messages unless \"${unusedAppSetting(sdk)}\" is turned off."
    val PAIR_HOWTO_STEPS = listOf("Install PushArmor on the other device.", "Log in with the same account.", "It appears here. Tap Pair.")
    fun numbered(steps: List<String>): List<String> = steps.mapIndexed { i, t -> "${i + 1}. $t" }
    /** Send chips in alphabetical order of the shown name: case-insensitive, locale-aware. */
    fun <T> sortedByName(items: List<T>, nameOf: (T) -> String, locale: java.util.Locale = java.util.Locale.getDefault()): List<T> {
        val c = java.text.Collator.getInstance(locale).apply { strength = java.text.Collator.SECONDARY }
        return items.sortedWith { a, b -> c.compare(nameOf(a), nameOf(b)) }
    }
    const val FIRST_DEVICE_TITLE = "Pair your first device"
    /** Same steps as the iOS first-pair screen; each shows with a numbered circle. */
    val FIRST_DEVICE_STEPS = listOf("Install PushArmor on another device.", "Log in with the same account.", "When it shows below, tap Pair, then tap Codes match when the codes match.")
    /** Added date of a device from its created time (seconds), as YYYY-MM-DD in the device's time zone. */
    fun addedDate(created: Long, zone: ZoneId = ZoneId.systemDefault()): String = Instant.ofEpochSecond(created).atZone(zone).toLocalDate().toString()
    /** The Added line of a device card, or null when the created time is not known (0). */
    fun addedLine(created: Long, zone: ZoneId = ZoneId.systemDefault()): String? = if (created > 0) "Added: ${addedDate(created, zone)}" else null
    /** The device ID the command line prints for this device. */
    fun shortDeviceId(id: String): String = com.pusharmor.crypto.Ids.deviceId(java.util.Base64.getUrlDecoder().decode(id))
    /** Extra line on an unpaired command line device; the command is monospace with no-break spaces so it never splits. */
    fun pairCommandLine(name: String, selfId: String): AnnotatedString = buildAnnotatedString {
        append("To pair, run this on ${q(name)}: ")
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append("pusharmor\u00A0pair\u00A0" + shortDeviceId(selfId)) }
    }
    const val FIRST_DEVICE_WAITING = "Waiting for another device to log in."

    /** Send with no paired device: pairing guidance replaces the empty "Send to" block once this device is loaded. */
    fun noDevicesShown(selfLoaded: Boolean, paired: Int): Boolean = selfLoaded && paired == 0
    const val NO_DEVICES_TITLE = "Pair a device first"
    /** Call to action under an empty or not-yet-usable Send or History. */
    const val PAIR_FIRST_CTA = "Pair your first device to start sending."
    /** Call to action under an empty History when devices are paired. */

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
    fun fingerprintLabel(code: String): String = "Pairing code " + code.toList().joinToString(", ")

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

    /** Rename field error: null when [name] is a valid device name, else "Name too short" or "Invalid characters" (same as Session.rename). */
    fun nameError(name: String): String? = DeviceName.inputError(name)

    /** Why a Pair tap did not start a pairing; null when it did. Pairing is not live, so no "online". */
    fun pairRefused(r: PairStart, name: String): String? = when (r) {
        PairStart.STARTED -> null
        PairStart.NO_DEVICE -> "This device is no longer on your account."
        PairStart.PAIRED -> "Already paired with ${q(name)}."
        PairStart.IN_PROGRESS -> "Pairing with ${q(name)} is already in progress."
        PairStart.NOT_READY -> "${q(name)} can't pair right now. Open PushArmor on that device, then try again."
    }

    /** A device as the app names it: its name, else "New Android device" (its name is not known until it pairs). */
    fun peerLabel(name: String?, platform: String): String = name?.let(DeviceName::display) ?: "New ${com.pusharmor.app.notify.AppEffects.platformLabel(platform)} device"
    /**
     * [p]'s name where only a name shows (send chips, Send to, History, notifications, share targets): "Pixel 8 (907-331-064)"
     * when another of [all] shows the same name ignoring case, else just the name. A paired device clashes only with
     * another paired device; a device not paired clashes with any of [all], so the ID goes on it, never on the paired one.
     */
    fun distinctLabel(p: Peer, all: Collection<Peer>): String {
        val l = peerLabel(p.name, p.platform)
        val key = DeviceName.fold(l)
        val mine = pairedForName(p)
        val clash = all.any { it.id != p.id && (!mine || pairedForName(it)) && DeviceName.fold(peerLabel(it.name, it.platform)) == key }
        return if (clash) "$l (${shortDeviceId(p.id)})" else l
    }
    /** Rename to a name another device already has (two lines). */
    fun nameUsedBy(name: String, id: String): String =
        "Name already used by \"${DeviceName.display(name)}\" (${shortDeviceId(id)})\nRemove that device, or rename it on that device"
    /** The rename error for [typed] when another device of [others] has exactly the cleaned name, else null. */
    fun nameTaken(typed: String, others: Collection<Peer>): String? {
        val name = DeviceName.check(typed).name ?: return null
        return others.firstOrNull { it.name == name }?.let { nameUsedBy(it.name!!, it.id) }
    }
    /** Pairing card title while the codes show. */
    fun pairWithNew(platform: String): String = "Pair with new ${com.pusharmor.app.notify.AppEffects.platformLabel(platform)} device"
    /** Pairing card title after Codes match here, until the other device confirms. */
    fun awaitingResponse(platform: String): String = "Awaiting ${com.pusharmor.app.notify.AppEffects.platformLabel(platform)} device's response"
    /** Text under the pairing code. */
    const val CONFIRM_CODE = "Confirm the other device shows this code."
    /** A pairing that failed because the other device's name could not be read (two lines). */
    fun nameUnreadable(platform: String): String =
        "Unable to pair with ${com.pusharmor.app.notify.AppEffects.platformLabel(platform)} device\nIts name could not be read. Try pairing again"
    /** Notice title and text when a device with no known name asks to pair. */
    const val NEW_DEVICE_WANTS_TO_PAIR = "A new device wants to pair"
    fun newDeviceWithId(platform: String, deviceId: String): String = "${com.pusharmor.app.notify.AppEffects.platformLabel(platform)} device with ID $deviceId"

    /** Notice when a device in the half state sends a new pairing request. */
    fun pairAgainNotice(x: String?): String = "${quoted(x, "A device")} wants to pair again. Tap Pair on its row."
    /** Status lines of a Waiting to pair row in the half state. */
    const val WANTS_TO_PAIR_AGAIN = "Wants to pair again"
    const val REJECTED_THIS_DEVICE = "Rejected this device"

    // Device texts: the name is always in straight double quotes; no name reads "A device" / "a device".
    fun approvedNotice(name: String?): String = "${quoted(name, "A device")} confirmed this device."
    fun renamedNotice(old: String?, new: String): String = "${quoted(old, "A device")} renamed to \"${DeviceName.display(new)}\""
    fun deletedNotice(count: Int, name: String?): String = (if (count == 1) "1 message" else "$count messages") + " deleted by " + quoted(name, "a device")
    fun rejectedNotice(name: String?): String = "Rejected by ${quoted(name, "a device")}."
    fun logoutNotice(name: String?, loggedOut: Boolean): String = quoted(name, "A device") + if (loggedOut) " logged out." else " logged in."
    fun greyedChip(name: String, status: String): String = "${q(name)}: $status"
    fun blockedChannel(name: String?): String = "Messages from ${quoted(name, "a device")} are blocked."
    fun stillHolds(x: String): String = "${q(x)} still holds an earlier pairing. On ${q(x)}, tap Cancel pairing request, then tap Send again."
    fun pairingInProgress(name: String?): String = "Pairing with ${quoted(name, "a device")} is in progress. Open PushArmor."
    /** A device asks to pair: named when its name is known, else the generic text. */
    fun wantsToPairNotice(name: String?): String = if (name == null) "A new device wants to pair. Open PushArmor." else "${q(name)} wants to pair."
    /** The compare step: the generic text, then the fingerprint. */
    fun compareNotice(fingerprint: String): String = "New device: compare $fingerprint"
    fun newMessageFrom(name: String?): String = "New message from ${quoted(name, "a device")}"
    /** A message notification title: the sending device's name in quotes. */
    fun messageTitle(name: String?): String = quoted(name, "Unknown sender")
    fun removeDeviceBody(x: String): String = "Remove ${q(x)} from this account? ${q(x)} must log in again and pair with every device again."
    fun deleteDeviceTitle(x: String): String = "Delete ${q(x)}?"
    fun deleteDeviceBody(x: String): String = "This removes ${q(x)} from this device."
    fun rejectedBy(x: String): String = "Rejected by ${q(x)}"
    fun notPairedOn(x: String): String = "Not paired on ${q(x)}"
    fun waitingCodesMatch(x: String): String = "Waiting for ${q(x)}: open PushArmor there and tap Codes match."
    fun repliedWaiting(x: String): String = "Replied. Waiting for ${q(x)}."
    fun waitingReply(x: String): String = "Waiting for ${q(x)} to reply."
    // Screen reader labels that carry a device name in a sentence quote it too.
    fun moreOptionsFor(x: String): String = "More options for ${q(x)}"
    fun chipLabel(name: String, status: String): String = "${q(name)}: $status"
    /** The pairing row error when the other device has not answered (two lines). */
    fun noReplyFrom(x: String): String = "No reply from ${q(x)}\nCheck that notifications are on for PushArmor on both devices, then try again"
    private fun quoted(name: String?, none: String): String = if (name == null) none else q(DeviceName.display(name))
    /** A computed label of a device with no known name ("New Android device", with its ID when it clashes). */
    fun isNewDeviceLabel(x: String): Boolean = NEW_DEVICE.matches(x)
    private val NEW_DEVICE = Regex("New (Android|iOS|Chrome|Firefox|CLI) device( \\(\\d{3}-\\d{3}-\\d{3}\\))?")
    /** A device name in a sentence, in straight double quotes; a computed "New X device" label stays unquoted, as on the extensions. */
    fun q(x: String): String = if (isNewDeviceLabel(x)) x else "\"$x\""
    /** [q] of [name] cut like the Send button; a computed label is never quoted, even when cut. */
    private fun qCut(name: String): String = if (isNewDeviceLabel(name)) cutName(name) else "\"${cutName(name)}\""

    /** Screen reader state of the sign-in code field, which has no visible label: "Code, 2 of 6 entered". */
    fun codeState(n: Int): String = "Code, $n of 6 entered"

    /** "1 day", "30 days". */
    fun days(d: Int): String = if (d == 1) "1 day" else "$d days"

    /**
     * [label] cut to what [fits]: a "Pixel 8 (907-331-064)" label shortens only its name (see [middleEllipsis]),
     * so the ID always shows whole; any other label comes back as is.
     */
    fun keepIdCut(label: String, fits: (String) -> Boolean): String {
        if (fits(label)) return label
        val id = ID_SUFFIX.find(label)?.value ?: return label
        return middleEllipsis(label.dropLast(id.length)) { fits(it + id) } + id
    }
    private val ID_SUFFIX = Regex(" \\(\\d{3}-\\d{3}-\\d{3}\\)$")

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
