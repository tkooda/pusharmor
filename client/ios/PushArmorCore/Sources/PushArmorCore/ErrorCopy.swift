import Foundation

/// Error texts: line 1 says what could not be done, line 2 says why and what to do next.
/// Device names are in straight double quotes and never start a text.
public enum ErrorCopy {
    /// Line 1: the action that did not complete.
    public enum Action: Equatable, Sendable {
        case send
        case sendOne(String)
        case refresh
        case rename
        case pair(String)
        case confirm(String)
        case reject(String)
        case remove(String)
        case evict
        case logout
        case sendCode
        case checkCode
        case login
        case loginGoogle
        case loginApple
        case prepareLogin
        case deleteAccount
        case deleteHistory
        case changeSetting
        case turnOnNotifications

        public var line: String {
            switch self {
            case .send: return "Unable to send."
            case .sendOne(let x): return "Unable to send to \"\(x)\"."
            case .refresh: return "Unable to refresh the device list."
            case .rename: return "Unable to rename this device."
            case .pair(let x): return "Unable to pair with \"\(x)\"."
            case .confirm(let x): return "Unable to confirm \"\(x)\"."
            case .reject(let x): return "Unable to reject \"\(x)\"."
            case .remove(let x): return "Unable to remove \"\(x)\"."
            case .evict: return "Unable to remove the chosen devices."
            case .logout: return "Unable to log out."
            case .sendCode: return "Unable to send the code."
            case .checkCode: return "Unable to check the code."
            case .login: return "Unable to log in."
            case .loginGoogle: return "Unable to log in with Google."
            case .loginApple: return "Unable to log in with Apple."
            case .prepareLogin: return "Unable to start the login."
            case .deleteAccount: return "Unable to delete the account."
            case .deleteHistory: return "Unable to delete the history."
            case .changeSetting: return "Unable to change this setting."
            case .turnOnNotifications: return "Unable to turn on notifications."
            }
        }
    }

    /// Line 2: why, and the next step.
    public enum Reason: Equatable, Sendable {
        case unreachable
        case serverDown
        case rateLimited(waitMs: Int)
        case tooOld
        case removed
        case loggedOut
        case loginExpired
        case badLink
        case clockOff
        case blocked
        case wrongCode
        case codeExpired
        case securityCheck
        case emailSendFailed
        case badEmail
        case emailNotVerified
        case notConfirmed(provider: String)
        case windowClosed
        case badReply
        case refused
        case tooLong
        case notificationsUnavailable
        case appleUnreachable
        case keysUnusable
        case storageFull
        case saveFailed
        case pushRejected
        case notReady
        case unknown

        public var line: String {
            switch self {
            case .unreachable: return "The relay server could not be reached. Check your internet connection and try again."
            case .serverDown: return "The relay server is not working right now. Try again later."
            case .rateLimited(let ms): return "Too many tries. Try again in \(S.wait(ms: ms))."
            case .tooOld: return "This version of PushArmor is too old. Update PushArmor to continue."
            case .removed: return "This device was removed from the account. Log in again."
            case .loggedOut: return "This device is logged out. Log in to resume."
            case .loginExpired: return "The login expired. Log in again."
            case .badLink: return "The login link is not valid. Request a new code and try again."
            case .clockOff: return "This device's clock is off by more than 5 minutes. Fix the clock and try again."
            case .blocked: return "This account is blocked."
            case .wrongCode: return "The code is not correct. Check the newest email from PushArmor and try again."
            case .codeExpired: return "The code expired. Request a new code to continue."
            case .securityCheck: return "The security check did not finish. Try again."
            case .emailSendFailed: return "The relay server could not send the email. Try again."
            case .badEmail: return "Only email addresses with plain ASCII characters are supported."
            case .emailNotVerified: return "This Google account has no verified email address."
            case .notConfirmed(let p): return "\(p) did not confirm the login. Try again."
            case .windowClosed: return "The login window was closed. Try again."
            case .badReply: return "The relay server sent a reply this device cannot use. Try again."
            case .refused: return "The relay server did not accept the request. Update PushArmor and try again."
            case .tooLong: return "The message is longer than 2048 characters."
            case .notificationsUnavailable:
                return "Notifications are not available on this device. Allow notifications for PushArmor in iOS Settings, then try again."
            case .appleUnreachable:
                return "Apple's notification service could not be reached. Check your internet connection and try again."
            case .keysUnusable: return "This device's security keys cannot be used right now. Restart the device and try again."
            case .storageFull: return "Storage is full. Free some space and try again."
            case .saveFailed: return "PushArmor could not save its data on this device. Restart PushArmor and try again."
            case .pushRejected: return "Its push service did not accept the message. Try again later."
            case .notReady: return "It has not finished turning on notifications. Open PushArmor on it."
            case .unknown: return "Try again."
            }
        }
    }

    /// The two-line text.
    public static func text(_ a: Action, _ r: Reason) -> String { a.line + "\n" + r.line }

    /// The reason for a call outcome; nil or no reply = could not be reached. A 2xx reply
    /// reaches here only when its body could not be used. `provider` names the sign-in
    /// service for a refused id token.
    public static func reason(from out: APIOutcome?, provider: String? = nil) -> Reason {
        if out?.isKeysUnusable == true { return .keysUnusable }
        guard let r = out?.reply else { return .unreachable }
        return reason(status: r.status, error: r.error, retryAfter: r.retryAfter, provider: provider)
    }

    /// The reason for one Worker reply status and error word. A failed id check (401
    /// "bad id") is not a removal: the relay server did not accept the request.
    public static func reason(status: Int, error: String?, retryAfter: Int? = nil, provider: String? = nil) -> Reason {
        switch (status, error) {
        case (200 ..< 300, _): return .badReply
        case (426, _): return .tooOld
        case (429, _): return .rateLimited(waitMs: (retryAfter ?? 60) * 1000)
        case (413, _): return .tooLong
        case (401, "clock skew"?): return .clockOff
        case (401, "unknown peer"?): return .removed
        case (401, "logged out"?): return .loggedOut
        case (401, "bad id"?): return .refused
        case (401, "invalid client signature"?): return .refused
        case (401, "ticket expired"?): return .loginExpired
        case (401, "invalid ticket"?), (401, "bad ticket"?): return .badLink
        case (401, "wrong code"?): return .wrongCode
        case (401, "code expired"?): return .codeExpired
        case (401, "email not verified"?): return .emailNotVerified
        case (401, "invalid id_token"?): return provider.map { Reason.notConfirmed(provider: $0) } ?? .unknown
        case (403, "banned"?): return .blocked
        case (403, "turnstile failed"?): return .securityCheck
        case (400, "bad email"?): return .badEmail
        case (400, "bad request"?), (404, _), (405, _): return .refused
        case (502, "email send failed"?): return .emailSendFailed
        case (500 ..< 600, _): return .serverDown
        default: return .unknown
        }
    }

    /// The reason when Google or Apple gave no id token: a network error (also as an
    /// underlying error) = could not be reached, else `provider` did not confirm the login.
    public static func tokenFailReason(_ e: Error?, provider: String) -> Reason {
        var cur = e.map { $0 as NSError }
        while let n = cur {
            if n.domain == NSURLErrorDomain { return .unreachable }
            cur = n.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return .notConfirmed(provider: provider)
    }

    /// The name rule; shown only for a name that breaks it.
    public static let nameRule = "Use 1 to 32 plain ASCII characters, no double quote."

    /// The toast after a rename of this device, nil when it went through: the name rule only
    /// for a bad name, else "Unable to rename this device." and the reason.
    public static func renameFailText(_ name: String, _ result: Result<APIOutcome, Error>) -> String? {
        guard NameEntry.isValidName(name) else { return nameRule }
        switch result {
        case .success(let out):
            if out.reply?.ok == true { return nil }
            return text(.rename, reason(from: out))
        case .failure(let e):
            return text(.rename, reason(local: e))
        }
    }

    /// The toast after Refresh, nil when the device list came back (or no call was made).
    public static func refreshFailText(_ out: APIOutcome?) -> String? {
        guard let out = out, !Core.fetchOk(out) else { return nil }
        return text(.refresh, reason(from: out))
    }

    /// The two lines for one chosen device that did not get a send; nil when it did. A
    /// result word this version does not know reads as not ready yet.
    public static func sendResultText(_ word: String, _ x: String) -> String? {
        let sendTo = Action.sendOne(x).line
        switch word {
        case "sent": return nil
        case "gone": return "Unable to deliver message to \"\(x)\".\nOpen PushArmor on it to resolve."
        case "logged out": return sendTo + "\nThat device is logged out. Log in on that device to receive messages."
        case "not listening": return sendTo + "\nIt is set to send only. It does not receive messages."
        case "unapproved": return sendTo + "\nIt is not paired with this device. Pair with it to send it messages."
        case "denied": return sendTo + "\nIt isn't paired with this device."
        case "unknown": return sendTo + "\nIt is no longer on this account."
        default: return text(.sendOne(x), word.hasPrefix("failed:") ? .pushRejected : .notReady)
        }
    }

    /// The toast for a send that threw: "Unable to send." and the reason.
    public static func sendFailText(_ e: Error) -> String {
        switch e as? Core.SendError {
        case .rejected(let r)?: return text(.send, r)
        case .clockOff?: return text(.send, .clockOff)
        case .tooLong?: return text(.send, .tooLong)
        default: return text(.send, reason(local: e))
        }
    }

    /// The reason for a local data error: SQLITE_FULL = storage full, any other store error =
    /// could not save.
    public static func reason(local e: Error) -> Reason {
        if case DBError.sql(let code, _)? = e as? DBError, code & 0xff == 13 { return .storageFull }
        if e is DBError { return .saveFailed }
        return .unknown
    }
}
