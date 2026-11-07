// User-facing strings (component-webext sections 5, 7; catalog).

import type { PeerRow } from "../store/db.ts";

const A_DEVICE = "A device";
/** A device name in a text, in straight double quotes; a device with no name stays "A device" unquoted. */
export const quoted = (x: string): string => (x === A_DEVICE ? x : '"' + x + '"');

export const T = {
  appName: "PushArmor",
  unreadable: "Unable to read a message.\nIt is not valid or was damaged.",
  pairCommit: "A new device wants to pair. Open PushArmor.",
  pairReply: "Pairing fingerprint ready. Open PushArmor.",
  pairOpen: (fp: string) => "New device: compare " + fp,
  pairHalf: (x: string) => quoted(x) + " wants to pair again. Click Pair again on its row.",
  pairCrossing: (x: string) => "Pairing with " + quoted(x) + " is in progress. Open PushArmor.",
  approved: (name: string) => quoted(name) + " confirmed this device.",
  peerChanged: "Device list changed",
  denied: (name: string) => quoted(name) + " rejected this device.",
  loggedOutRecv: (name: string) => quoted(name) + " logged out.",
  loggedInRecv: (name: string) => quoted(name) + " logged in.",
  aPeer: A_DEVICE,
  newMessageFrom: (x: string) => "New message from " + quoted(x),
  removed: "This device was removed from the account. Log in again.",
  accountDeleted: "The account was deleted on another device.",
  keysLost: "This device's security keys cannot be used right now. Log in again.",
  keysBrokenTitle: "This device's keys have become unusable.",
  keysBrokenBody: "Click Retry to try again. If this keeps happening, you can delete the broken keys. You will then sign in again and pair all your devices again.",
  keysDeleteTitle: "Delete broken keys?",
  keysDeleteBody: "This cannot be undone. You will need to pair all your devices again.",
  startLoginFailed: "Unable to start the login.",
  requestFailed: "Request failed.\nTry again.",
  noReply: "Unable to reach PushArmor.\nClose this window, open it again, and try again.",
  storageFull: "Storage is full. Free some space and try again.",
  saveFailed: "PushArmor could not save its data on this device. Restart PushArmor and try again.",
  signedOut: "This device is logged out. Log in to resume.",
  sendOnly: "Send only",
  pairFailed: (x: string) => "Unable to pair with " + quoted(x) + ".\nClick Pair to start again.",
  pairTimedOut: (x: string) => "Unable to pair with " + quoted(x) + ".\nIt did not answer in time. Click Pair to start again.",
  pairing: "Pairing...",
  pairingWith: (x: string) => "Pairing with " + quoted(x) + ". Waiting for its reply.",
  wantsToPair: (x: string) => quoted(x) + " wants to pair.",
  waiting: (x: string) => "Waiting for " + quoted(x) + ": open PushArmor there, compare the codes on both devices, and click Codes match only if they are the same.",
  noReplyYet: (x: string) => "No reply yet. Open PushArmor on " + quoted(x) + ", or click Send again.",
  stillHolds: (x: string) => quoted(x) + " still holds an earlier pairing. On " + quoted(x) + ", click Cancel pairing request, then click Send again.",
  notPairedOn: (x: string) => "Not paired on " + quoted(x) + ".",
  declinedBy: (x: string) => "Rejected by " + quoted(x) + ".",
  fingerprint: (fp: string) => "Pairing fingerprint " + fp,
  removeConfirm: (x: string) => "Remove " + quoted(x) + " from this account? It must log in again and pair with every device again.",
  removedDevice: (x: string) => "Removed " + quoted(x) + ".",
  sentToNofM: (n: number, m: number) => "Sent to " + n + " of " + m + (m === 1 ? " device" : " devices"),
  sentToOne: (x: string) => 'Sent to "' + x + '"',
  messageSentToOne: (x: string) => 'Message sent to "' + x + '"',
  googleNotInBrowser: "Google login is not available in this browser\nUse email login",
  appleNotInBrowser: "Apple login is not available in this browser\nUse email login",
  googleNotInCopy: "Google login is not available in this copy of PushArmor\nUse email login, or install PushArmor from the Chrome Web Store or GitHub",
  messageSentToN: (n: number) => "Message sent to " + n + (n === 1 ? " device" : " devices"),
  tooLong: (n: number) => "Too long (" + n + " / 2048)",
  counter: (n: number) => n + " / 2048",
  countdownLeft: (c: string) => "Times out in " + c,
  typeCaption: (t: string) => (t === "url" ? "Will be sent as URL" : t === "tel" ? "Will be sent as phone number" : "Will be sent as text"),
  clockOff: "This device's clock is off by more than 5 minutes.",
  badEmail: "Only email addresses with plain ASCII characters are supported.",
  unknownSender: "Unknown sender",
  signedInAs: (e: string) => "Logged in as " + e,
  notificationsOff: "Notifications are off. This device cannot receive messages.",
  ffFinishSetup: "Finish setup in the Firefox setup tab.",
  pushWorking: "Working",
  pushCheckFailed: "Unable to check right now. Try again later.",
  pushStillCannot: "Still cannot receive messages.",
  copied: "Copied",
  copyFailed: "Unable to copy\nSelect the text and copy it by hand",
} as const;

/** Whose push service a push endpoint belongs to; by browser when the host is not known. */
export function pushVendor(endpoint: string | null, platform: "chrome" | "firefox"): string {
  let host = "";
  try {
    host = endpoint ? new URL(endpoint).hostname : "";
  } catch {
    host = "";
  }
  if (host === "googleapis.com" || host.endsWith(".googleapis.com")) return "Google";
  if (host.endsWith(".mozilla.com")) return "Mozilla";
  if (host.endsWith(".notify.windows.com")) return "Microsoft";
  return platform === "firefox" ? "Mozilla" : "Google";
}

/** The sticky message while this browser cannot receive (the push service or the relay server refused, or a relay-side fault). */
export function pushIssueText(issue: "refused" | "noservice" | "unsupported" | "relay" | "nostart" | "noreach" | "fault", brave: boolean, vendor = "Google"): string {
  if (issue === "fault")
    return "This device cannot receive messages.\nThe relay server cannot reach " + vendor + "'s push service right now. This is not a problem on this device. Try again later.";
  // the relay server answered 400 "push endpoint not allowed" to this browser's push address
  if (issue === "unsupported") return "This browser cannot receive messages.\nIts push service is not supported.";
  if (issue === "nostart") return "This browser cannot receive messages.\nFirefox did not start its push service. Restart Firefox, then click Check again.";
  if (issue === "noreach") return "This browser cannot receive messages.\nIts push address did not reach the relay server. Check the internet connection, then click Check again.";
  const head = "Unable to turn on notifications.\n";
  if (issue === "relay") return head + "The relay server did not accept its push service. Try again later.";
  if (brave) return head + 'Turn on "Use Google services for push messaging" in Brave\'s privacy settings.';
  // a browser built without a push service (ungoogled-chromium): sending still works
  if (issue === "noservice") return "This browser cannot receive messages.\nIt has no push service. Sending still works.";
  return head + "Notifications are not available on this device.";
}

/** The two lines for one device that did not get a send (sent excluded); an unknown word reads as not ready yet. */
export function sendResultText(name: string, res: string): string {
  const to = 'Unable to send to "' + name + '".\n';
  if (res === "gone") return 'Unable to deliver message to "' + name + '".\nOpen PushArmor on it to resolve.';
  if (res === "logged out") return to + "That device is logged out. Log in on that device to receive messages.";
  if (res === "not listening") return to + "It is set to send only. It does not receive messages.";
  if (res === "unapproved") return to + "It is not paired with this device. Pair with it to send it messages.";
  if (res === "denied") return to + "It isn't paired with this device.";
  if (res === "unknown") return to + "It is no longer on this account.";
  if (res.startsWith("failed:")) return to + "Its push service did not accept the message. Try again later.";
  return to + "It has not finished turning on notifications. Open PushArmor on it.";
}

/** The two lines when Codes match reached the relay server but not the device: why, as for a send. */
export function confirmResultText(name: string, res: string): string {
  return 'Unable to deliver the confirmation to "' + name + '".\n' + sendResultText(name, res).split("\n")[1];
}

/** The two lines for a greyed device chip on Send: why it cannot get a message right now. */
export function greyedText(name: string, greyed: string): string {
  if (greyed === "logged out") return sendResultText(name, "logged out");
  if (greyed === "send only") return sendResultText(name, "not listening");
  if (greyed === "(missing)") return sendResultText(name, "unknown");
  if (greyed.startsWith("Not paired on ")) return sendResultText(name, "unapproved");
  const to = 'Unable to send to "' + name + '".\n';
  if (greyed.startsWith("Rejected by ")) return to + "It rejected this device. Pair with it again to send it messages.";
  return to + "It cannot be reached right now. Try again later.";
}

export function peerLabel(name: string | null): string {
  return name ?? T.aPeer;
}

function created(p: PeerRow): string {
  const d = new Date(p.created * 1000);
  const plat = p.platform === "cli" ? "Command line" : p.platform.charAt(0).toUpperCase() + p.platform.slice(1);
  return Number.isFinite(d.getTime()) ? plat + ", added " + d.toISOString().slice(0, 10) : plat;
}

/** The device name its row in the list shows. */
export function rowLabel(p: PeerRow): string {
  return p.name ?? created(p);
}

// Error texts, same words as Android and iOS: line 1 says what could not be done,
// line 2 says why and what to do next. Device names are in straight double quotes
// and never start a text.

export type ActionId =
  | "send"
  | "refresh"
  | "rename"
  | "pair"
  | "confirm"
  | "reject"
  | "remove"
  | "evict"
  | "cancel"
  | "logout"
  | "sendCode"
  | "checkCode"
  | "login"
  | "loginGoogle"
  | "loginApple"
  | "deleteAccount"
  | "deleteHistory"
  | "saveMessage"
  | "changeSetting";

/** Line 1: the action that did not complete. */
export function actionLine(a: ActionId, x = ""): string {
  const q = '"' + x + '"';
  switch (a) {
    case "send": return "Unable to send.";
    case "refresh": return "Unable to refresh the device list.";
    case "rename": return "Unable to rename this device.";
    case "pair": return "Unable to pair with " + q + ".";
    case "confirm": return "Unable to confirm " + q + ".";
    case "reject": return "Unable to reject " + q + ".";
    case "remove": return "Unable to remove " + q + ".";
    case "evict": return "Unable to remove the chosen devices.";
    case "cancel": return "Unable to cancel pairing with " + q + ".";
    case "logout": return "Unable to log out.";
    case "sendCode": return "Unable to send the code.";
    case "checkCode": return "Unable to check the code.";
    case "login": return "Unable to log in.";
    case "loginGoogle": return "Unable to log in with Google.";
    case "loginApple": return "Unable to log in with Apple.";
    case "deleteAccount": return "Unable to delete the account.";
    case "deleteHistory": return "Unable to delete the history.";
    case "saveMessage": return "Unable to save the message.";
    case "changeSetting": return "Unable to change this setting.";
  }
}

/** Line 2: why, and the next step. */
export const R = {
  unreachable: "The relay server could not be reached. Check your internet connection and try again.",
  offline: "No internet connection.",
  timeout: "The relay server did not answer in time. Try again.",
  serverDown: "The relay server is not working right now. Try again later.",
  rateLimited: (wait: string) => "Too many tries. Try again in " + wait + ".",
  tooOld: "This version of PushArmor is too old. Update PushArmor to continue.",
  removed: "This device was removed from the account. Log in again.",
  loggedOut: "This device is logged out. Log in to resume.",
  loginExpired: "The login expired. Log in again.",
  badLink: "The login link is not valid. Request a new code and try again.",
  clockOff: "This device's clock is off by more than 5 minutes. Fix the clock and try again.",
  blocked: "This account is blocked.",
  wrongCode: "The code is not correct. Check the newest email from PushArmor and try again.",
  codeExpired: "The code expired. Request a new code to continue.",
  securityCheck: "The security check did not finish. Try again.",
  emailSendFailed: "The relay server could not send the email. Try again.",
  badEmail: "Only email addresses with plain ASCII characters are supported.",
  emailNotVerified: "This Google account has no verified email address.",
  notConfirmed: (provider: string) => provider + " did not confirm the login. Try again.",
  windowClosed: "The login window was closed. Try again.",
  badReply: "The relay server sent a reply this device cannot use. Try again.",
  refused: "The relay server did not accept the request. Update PushArmor and try again.",
  tooLong: "The message is longer than 2048 characters.",
  pushNotSupported: "This browser's push service is not supported yet.",
  keysUnusable: "This device's security keys cannot be used right now. Restart the device and try again.",
  storageFull: "Storage is full. Free some space and try again.",
  saveFailed: "PushArmor could not save its data on this device. Restart PushArmor and try again.",
  downloadsDenied: "Allow downloads for PushArmor to save files",
  saveDenied: "PushArmor is not allowed to save there. Choose another location.",
  tryAgain: "Try again.",
  enterCode: "Enter the 6-character code from the email.",
  enterEmail: "Enter your email address.",
  emailNotValid: "The email address is not valid. Check it and try again.",
  badName: "Use 1 to 32 plain ASCII characters, with no double quote.",
  someNotSent: "Some devices did not get the message. Open PushArmor to see which.",
  noLongerOnAccount: "It is no longer on this account.",
  alreadyPaired: "It is already paired with this device.",
  pairingOpen: "A pairing with it is already open. Cancel it first.",
  notAtCodeCheck: "The pairing with it has not reached the code check. Pair with it again.",
  /** A login for another account; this device switched to it. */
  otherLogin: (email: string) => 'To finish logging in as "' + email + '", log in again.',
  deleteOther: (email: string) => 'This login is for "' + email + '", not the account on this device. Log in with the account you want to delete.',
  otherAccount: "This login is for another account.",
} as const;

/** Save a message to a file: no access, a full disk, else a plain retry. */
export function saveFailText(err: unknown): string {
  const m = String((err as { message?: unknown } | null)?.message ?? "");
  const why = /DOWNLOADS_DENIED/.test(m) ? R.downloadsDenied : /FILE_ACCESS_DENIED/.test(m) ? R.saveDenied : /FILE_NO_SPACE/.test(m) ? R.storageFull : R.tryAgain;
  return actionLine("saveMessage") + "\n" + why;
}
